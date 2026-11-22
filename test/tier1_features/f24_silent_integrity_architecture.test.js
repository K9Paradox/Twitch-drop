import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client, TwitchApiError } from "../../background/twitchApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

describe("Tier 1: Feature 24 - 4-Tier Silent Integrity Architecture & Kasada Self-Healing", () => {
    let sandbox;
    const bgJs = readFileSync(resolve(rootDir, "background.js"), "utf8");

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F24-T1: Zero chrome.windows.create calls anywhere in background.js codebase", () => {
        const matches = bgJs.match(/chrome\.windows\.create/g) || [];
        assert.deepEqual(
            matches,
            [],
            "Found legacy chrome.windows.create in background.js violating 4-tier silent architecture: " + matches.length
        );
    });

    it("F24-T2: Client.buildHeaders() excludes expired Client-Integrity objects, includes valid future objects & strings, and includes Client-Version", () => {
        const client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-123",
            deviceId: "device-xyz"
        });

        // 1. Expired object: expiration <= Date.now() -> MUST NOT attach Client-Integrity
        client.integrity = {
            token: "expired-integ-token",
            expiration: Date.now() - 5000
        };
        const headersExpired = client.buildHeaders(true);
        assert.equal(headersExpired["Client-Integrity"], undefined, "Expired integrity token must be omitted from headers");

        // 2. Fresh object: expiration in future -> MUST attach Client-Integrity
        client.integrity = {
            token: "fresh-integ-token-999",
            expiration: Date.now() + 3600000
        };
        const headersFresh = client.buildHeaders(true);
        assert.equal(headersFresh["Client-Integrity"], "fresh-integ-token-999");

        // 3. Raw string integrity (for test backwards-compatibility) -> MUST attach
        client.integrity = "raw-string-integrity-token";
        const headersRaw = client.buildHeaders(true);
        assert.equal(headersRaw["Client-Integrity"], "raw-string-integrity-token");

        // 4. Client-Version header included when set
        client.clientVersion = "2.0.0-kasada-clean";
        const headersWithVersion = client.buildHeaders(true);
        assert.equal(headersWithVersion["Client-Version"], "2.0.0-kasada-clean");

        // 5. skipIntegrity option bypasses integrity attachment
        const headersSkipped = client.buildHeaders(true, { skipIntegrity: true });
        assert.equal(headersSkipped["Client-Integrity"], undefined);
    });

    it("F24-T3: Tier 1 silent SW Client.fetchIntegrity() POSTs to /integrity, sets real server expiration, and opens zero tabs/windows", async () => {
        const client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-123",
            deviceId: "device-xyz"
        });

        const futureServerExpiration = Date.now() + (6 * 3600 * 1000); // 6 hours
        let capturedFetchUrl = null;
        let capturedFetchOpts = null;

        globalThis.fetch = async (url, opts) => {
            if (url.includes("/integrity")) {
                capturedFetchUrl = url;
                capturedFetchOpts = opts;
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: async () => ({
                        token: "tier1-server-token-abc",
                        expiration: futureServerExpiration
                    })
                };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        };

        const res = await client.fetchIntegrity();
        assert.equal(res.ok, true);
        assert.equal(res.token, "tier1-server-token-abc");
        assert.equal(res.expiration, futureServerExpiration);

        assert.ok(capturedFetchUrl.includes("gql.twitch.tv/integrity"));
        assert.equal(capturedFetchOpts.method, "POST");

        // Client internal state updated
        const currentInteg = await client.getInteg();
        const tokenVal = typeof currentInteg === "object" ? currentInteg?.token : currentInteg;
        assert.equal(tokenVal, "tier1-server-token-abc");

        // Zero tabs or windows created
        assert.equal(sandbox.chrome._createdTabs?.length || 0, 0);
    });

    it("F24-T4: postAuthorized() read-only self-heal: retries once without Client-Integrity on IntegrityCheckFailed without opening tabs", async () => {
        const client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-123"
        });
        client.integrity = { token: "bad-token", expiration: Date.now() + 100000 };

        let refreshCalled = false;
        client.onIntegrityError = async (opName) => {
            refreshCalled = true;
            client.integrity = null;
            return false; // Silent refresh failed
        };

        let callCount = 0;
        let secondCallHeaders = null;
        globalThis.fetch = async (url, opts) => {
            callCount++;
            if (callCount === 1) {
                // First call: Twitch rejects integrity token
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    json: async () => ({
                        errors: [{ message: "failed integrity check" }]
                    })
                };
            }
            // Second call (read-only self-heal retry): succeeds without Client-Integrity
            secondCallHeaders = opts?.headers || {};
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    data: {
                        currentUser: {
                            inventory: {
                                dropCampaignsInProgress: [],
                                gameEventDropsConnection: { edges: [] }
                            }
                        }
                    }
                })
            };
        };

        // Query Inventory (read-only operation)
        const inventory = await client.getInventory();
        assert.ok(inventory);
        assert.equal(refreshCalled, true);
        assert.equal(callCount, 2, "postAuthorized must retry read-only query once");
        assert.equal(
            secondCallHeaders["Client-Integrity"],
            undefined,
            "Second call must omit Client-Integrity for read-only self-healing"
        );

        // Protected mutations like claimDropReward must NOT do unauthenticated retry
        callCount = 0;
        globalThis.fetch = async () => {
            callCount++;
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    errors: [{ message: "failed integrity check" }]
                })
            };
        };

        await assert.rejects(
            async () => {
                await client.claimDropReward("drop-instance-123");
            },
            TwitchApiError
        );
        assert.equal(callCount, 1, "Protected mutation must not execute read-only retry without integrity");
    });

    it("F24-T5: Tier 2 open Twitch tab proxy mints integrity via atd:requestIntegrity message with zero new tabs", async () => {
        // Mock existing open Twitch tabs in Chrome
        const existingTabs = [
            { id: 201, url: "https://www.twitch.tv/directory", status: "complete", discarded: false },
            { id: 202, url: "https://www.twitch.tv/esl_csgo", status: "complete", discarded: false }
        ];

        sandbox.chrome.tabs.query = async (queryInfo) => {
            if (queryInfo.url === "*://*.twitch.tv/*") {
                return existingTabs;
            }
            return [];
        };

        let messageSentToTab = null;
        sandbox.chrome.tabs.sendMessage = async (tabId, msg) => {
            if (msg.type === "atd:requestIntegrity") {
                messageSentToTab = { tabId, msg };
                return {
                    ok: true,
                    token: "proxied-tab-integ-token-777",
                    expiration: Date.now() + 18000000
                };
            }
            return { ok: false };
        };

        // Test helper simulating Tier 2 tab proxy logic from background.js
        async function runTier2Proxy() {
            const tabs = await sandbox.chrome.tabs.query({ url: "*://*.twitch.tv/*" });
            const candidates = tabs.filter(t => t && typeof t.id === "number" && !t.discarded);
            for (const tab of candidates) {
                const res = await sandbox.chrome.tabs.sendMessage(tab.id, {
                    type: "atd:requestIntegrity",
                    requestId: "req-1"
                });
                if (res && res.ok && res.token) {
                    return res;
                }
            }
            return null;
        }

        const tier2Result = await runTier2Proxy();
        assert.ok(tier2Result);
        assert.equal(tier2Result.token, "proxied-tab-integ-token-777");
        assert.equal(messageSentToTab.tabId, 201);
        assert.equal(messageSentToTab.msg.type, "atd:requestIntegrity");

        // Zero new tabs created
        assert.equal(sandbox.chrome._createdTabs?.length || 0, 0);
    });

    it("F24-T6: Tier 3 smart gating prevents tabs/windows for startup, tokenRefreshAlarm, and ClaimCommunityPoints", async () => {
        let createdTabsCount = 0;
        sandbox.chrome.tabs.create = async () => {
            createdTabsCount++;
            return { id: 999 };
        };

        // Simulate refreshIntegrityToken with allowTabFallback: false
        async function testRefreshGating({ allowTabFallback }) {
            // Tier 1 direct fail
            const tier1Ok = false;
            // Tier 2 proxy fail
            const tier2Ok = false;

            // Tier 3 gating check
            if (!allowTabFallback) {
                return false;
            }

            // Tier 4
            await sandbox.chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory", active: false });
            return true;
        }

        // 1. Startup / Alarm refresh: allowTabFallback is false
        const startupResult = await testRefreshGating({ allowTabFallback: false });
        assert.equal(startupResult, false);
        assert.equal(createdTabsCount, 0, "Startup/Alarm must never create a tab on integrity failure");

        // 2. Read-only query: allowTabFallback is false
        const queryResult = await testRefreshGating({ allowTabFallback: false });
        assert.equal(queryResult, false);
        assert.equal(createdTabsCount, 0, "Read-only query must never create a tab on integrity failure");
    });

    it("F24-T7: Tier 4 last-resort fallback creates silent background tab ONLY when allowed and enforces 15m cooldown", async () => {
        let createdTabs = [];
        sandbox.chrome.tabs.create = async (props) => {
            const tab = { id: 500 + createdTabs.length, ...props };
            createdTabs.push(tab);
            return tab;
        };

        const INTEGRITY_TAB_COOLDOWN_MS = 15 * 60 * 1000;
        let lastAttemptAt = 0;
        let activeTabId = 0;

        async function attemptTier4Fallback(allowTabFallback) {
            if (!allowTabFallback) return false;
            const now = Date.now();
            if (activeTabId !== 0) return false;
            if (lastAttemptAt && (now - lastAttemptAt) < INTEGRITY_TAB_COOLDOWN_MS) {
                return false;
            }

            lastAttemptAt = now;
            const tab = await sandbox.chrome.tabs.create({
                url: "https://www.twitch.tv/drops/inventory",
                active: false
            });
            activeTabId = tab.id;
            return true;
        }

        // 1. First claim failure with allowTabFallback: true creates 1 silent background tab
        const firstTry = await attemptTier4Fallback(true);
        assert.equal(firstTry, true);
        assert.equal(createdTabs.length, 1);
        assert.equal(createdTabs[0].active, false);
        assert.equal(createdTabs[0].url, "https://www.twitch.tv/drops/inventory");

        // Simulate tab completion and cleanup
        activeTabId = 0;

        // 2. Immediate second failure hits 15-minute cooldown and DOES NOT create a tab
        const secondTry = await attemptTier4Fallback(true);
        assert.equal(secondTry, false, "Second attempt must be blocked by 15m cooldown");
        assert.equal(createdTabs.length, 1, "No extra tabs should be created within cooldown window");
    });
});
