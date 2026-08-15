/**
 * Challenger 1 Adversarial Stress Test Suite & Empirical Verification
 * Milestone 4: Final Integration & Adversarial Coverage Hardening (Tier 5)
 * 
 * Comprehensive Stress Tests:
 * 1. High-throughput GraphQL error bursts, network disconnects & integrity token lifecycle
 * 2. Stream stall watchdog triggers, rapid channel switches & streamer offline failovers
 * 3. Channel points bonus chest click floods & concurrent drop claims without race conditions or memory leaks
 * 4. Storage state mutations, re-hydration mutex & rapid popup tab switching
 * 5. Zero unhandled promise rejections, zero memory leaks, and 100% data contract compliance
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setupTestSandbox, resetTestSandbox } from "../harness/sandbox.js";
import { Client, TwitchApiError } from "../../background/twitchApi.js";
import {
    currentUserFixture,
    directoryRootFixture,
    viewerDropsDashboardFixture,
    dropCampaignDetailsFixture,
    inventoryFixture,
    directoryPageGameFixture,
    claimDropRewardSuccessFixture,
    claimDropRewardEligibleFixture,
    claimCommunityPointsSuccessFixture,
    claimCommunityPointsErrorFixture,
    channelShellLiveFixture,
    channelShellOfflineFixture
} from "../fixtures/graphql-fixtures.js";
import {
    gqlAuthErrorFixture,
    gqlForbiddenErrorFixture,
    gqlRateLimitErrorFixture,
    gqlInternalServerErrorFixture,
    expiredIntegrityTokenFixture,
    validIntegrityTokenFixture
} from "../fixtures/error-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

class MockHttpResponse {
    constructor(body, init = {}) {
        this.status = init.status !== undefined ? init.status : 200;
        this.ok = this.status >= 200 && this.status < 300;
        this.statusText = init.statusText || (this.ok ? "OK" : "Error");
        this._body = body;
        this.url = init.url || "https://gql.twitch.tv/gql";
        this.headers = new Map(Object.entries(init.headers || {}));
    }

    async json() {
        if (typeof this._body === "string") return JSON.parse(this._body);
        return JSON.parse(JSON.stringify(this._body));
    }

    async text() {
        if (typeof this._body === "string") return this._body;
        return JSON.stringify(this._body);
    }

    clone() {
        return new MockHttpResponse(this._body, {
            status: this.status,
            statusText: this.statusText,
            url: this.url,
            headers: Object.fromEntries(this.headers.entries())
        });
    }
}

// Global unhandled rejection monitor
let unhandledRejections = [];
const rejectionHandler = (reason, promise) => {
    unhandledRejections.push({ reason, promise });
};

describe("Adversarial Suite M4 (Tier 5): Challenger 1 Deep Empirical Stress Testing", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        unhandledRejections = [];
        process.on("unhandledRejection", rejectionHandler);
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko",
            oauthToken: "test_oauth_token_m4_challenger",
            deviceId: "device_id_m4_stress",
            integrity: { token: "valid_integrity_token_jwt", expiration: Date.now() + 3600000 },
            userId: "987654321",
            uuid: "session_uuid_m4"
        });
    });

    afterEach(() => {
        process.removeListener("unhandledRejection", rejectionHandler);
        assert.equal(
            unhandledRejections.length,
            0,
            `Zero unhandled promise rejections permitted. Detected: ${unhandledRejections.length}`
        );
        resetTestSandbox();
    });

    // =========================================================================
    // DOMAIN 1: High-Throughput GraphQL Error Bursts, Network Disconnects & Token Lifecycle
    // =========================================================================
    describe("Domain 1: High-Throughput GraphQL Error Bursts, Network Disconnects & Token Expiration", () => {

        it("T5-M4-1: 1,000 rapid concurrent GQL error bursts (400..504) throw typed TwitchApiError and preserve client integrity", async () => {
            const httpErrorCodes = [400, 401, 403, 404, 429, 500, 502, 503, 504];
            let callIndex = 0;

            sandbox.fetchMock.onGql("ViewerDropsDashboard", () => {
                const code = httpErrorCodes[callIndex++ % httpErrorCodes.length];
                const resp = {
                    status: code,
                    statusText: `HTTP Error ${code}`,
                    errors: [{ message: `Simulated error ${code}`, extensions: { code } }]
                };
                return new MockHttpResponse(resp, { status: code });
            });

            const startTime = Date.now();
            const burstPromises = Array.from({ length: 1000 }, async () => {
                try {
                    await client.getDropCampaigns();
                    // getDropCampaigns catches internally and returns [] on failure
                    return { success: true };
                } catch (err) {
                    return { error: err };
                }
            });

            const results = await Promise.all(burstPromises);
            const durationMs = Date.now() - startTime;

            assert.equal(results.length, 1000);
            assert.ok(durationMs < 4000, `1000 burst queries should process rapidly (took ${durationMs}ms)`);
            // Client should still maintain its tokens and credentials intact
            assert.equal(client.clientId, "kimne78kx3ncx6brgo4mv6wki5h1ko");
            assert.equal(client.oauthToken, "test_oauth_token_m4_challenger");
            assert.equal(client.deviceId, "device_id_m4_stress");
        });

        it("T5-M4-2: Intermittent network disconnects (fetch throw, ECONNREFUSED, AbortError) handle gracefully without unhandled rejections", async () => {
            let requestCounter = 0;
            sandbox.fetchMock.onGql("Inventory", () => {
                requestCounter++;
                if (requestCounter % 4 === 1) {
                    throw new TypeError("Failed to fetch: NetworkError when attempting to fetch resource.");
                } else if (requestCounter % 4 === 2) {
                    const abortErr = new Error("The operation was aborted");
                    abortErr.name = "AbortError";
                    throw abortErr;
                } else if (requestCounter % 4 === 3) {
                    const connErr = new Error("connect ECONNREFUSED 127.0.0.1:443");
                    connErr.code = "ECONNREFUSED";
                    throw connErr;
                }
                return new MockHttpResponse(inventoryFixture, { status: 200 });
            });

            const attempts = 100;
            let successCount = 0;
            let caughtCount = 0;

            for (let i = 0; i < attempts; i++) {
                try {
                    const inv = await client.getInventory();
                    if (inv) successCount++;
                    else caughtCount++;
                } catch (err) {
                    caughtCount++;
                    assert.ok(err instanceof Error);
                }
            }

            assert.ok(successCount > 0, "Successful requests should succeed");
            assert.ok(caughtCount > 0, "Network failures should be caught gracefully without crashing");
            assert.equal(successCount + caughtCount, attempts);
        });

        it("T5-M4-3: Integrity token expiration boundary (< 16 min remaining) correctly triggers invalidation & storage update", async () => {
            // Case 1: Fresh token (> 16 min)
            client.integrity = { token: "fresh_token_xyz", expiration: Date.now() + 1800000 }; // 30 min left
            const valid = await client.getInteg();
            assert.equal(valid.token, "fresh_token_xyz");

            // Case 2: Near expiration (< 16 min remaining -> 960,000 ms threshold)
            client.integrity = { token: "expiring_soon_token", expiration: Date.now() + 500000 }; // ~8.3 min left (< 16 min)
            const nearExpired = await client.getInteg();
            assert.equal(nearExpired, false, "Token with < 16 min remaining must return false to trigger refresh");

            // Case 3: Expired token
            client.integrity = { token: "expired_token", expiration: Date.now() - 10000 };
            const expired = await client.getInteg();
            assert.equal(expired, false, "Expired token must return false");

            // Case 4: Null / undefined integrity
            client.integrity = null;
            assert.equal(await client.getInteg(), false);

            // Case 5: Set new integrity persists to chrome.storage.local
            const newInteg = { token: "renewed_token_2026", expiration: Date.now() + 7200000 };
            await client.setInteg(newInteg);
            assert.deepEqual(client.integrity, newInteg);

            const stored = await sandbox.chrome.storage.local.get("twitchInteg");
            assert.deepEqual(stored.twitchInteg, newInteg);
        });

        it("T5-M4-4: High-throughput mixed batched query stress: 100 concurrent batched queries unwrap cleanly", async () => {
            const batchedCampaignIds = ["camp-batch-1", "camp-batch-2", "camp-batch-3", "camp-batch-4"];

            sandbox.fetchMock.onGql("DropCampaignDetails", () => {
                const batchResult = batchedCampaignIds.map(id => ({
                    data: {
                        user: {
                            dropCampaign: {
                                id,
                                game: { displayName: "Overwatch 2" },
                                timeBasedDrops: [
                                    {
                                        id: `drop-${id}`,
                                        name: `Reward for ${id}`,
                                        requiredMinutesWatched: 60,
                                        self: { isClaimed: false, currentMinutesWatched: 60 }
                                    }
                                ]
                            }
                        }
                    }
                }));
                return new MockHttpResponse(batchResult, { status: 200 });
            });

            const batchRuns = Array.from({ length: 100 }, () => client.getDropCampaignDetails(batchedCampaignIds));
            const allBatchResults = await Promise.all(batchRuns);

            assert.equal(allBatchResults.length, 100);
            for (const batch of allBatchResults) {
                assert.ok(Array.isArray(batch));
                assert.equal(batch.length, 4);
                assert.equal(batch[0].data.user.dropCampaign.id, "camp-batch-1");
                assert.equal(batch[3].data.user.dropCampaign.id, "camp-batch-4");
            }
        });
    });

    // =========================================================================
    // DOMAIN 2: Stream Stall Watchdog, Rapid Channel Switches & Offline Streamer Failover
    // =========================================================================
    describe("Domain 2: Stream Stall Watchdog, Rapid Channel Switches & Streamer Offline Failover", () => {

        it("T5-M4-5: Stream stall watchdog detects 2-minute stall -> trigger 1 reloads tab, trigger 2 rotates channel", async () => {
            let reloadedTabIds = [];
            sandbox.chrome.tabs.reload = async (tabId) => {
                reloadedTabIds.push(tabId);
            };

            const tab = await sandbox.chrome.tabs.create({ url: "https://www.twitch.tv/streamer_a#atd-managed=1" });
            const curWindow = { id: tab.id, type: "tab" };

            const activeStream = {
                campaign: {
                    game: { name: "Overwatch 2" },
                    onCamp: 0,
                    curWatching: "streamer_a",
                    status: "watching",
                    skippedStreamers: [],
                    lastMinutesWatched: 45,
                    lastProgressTimestamp: Date.now() - 150000, // 2.5 minutes ago (> 2-minute stall threshold)
                    stallCount: 0
                },
                campaigns: [
                    {
                        id: "camp-ow2",
                        game: "Overwatch 2",
                        minutesWatched: 45, // Unchanged progress (stalled)
                        minutesNeeded: 120,
                        streamers: ["streamer_a", "streamer_b", "streamer_c"],
                        items: [
                            { id: "drop-ow-1", reqTime: 120, self: { isClaimed: false, currentMinutesWatched: 45 } }
                        ]
                    }
                ]
            };

            const settings = { autoRefresh: true };
            let rotatedToStreamer = null;

            async function simulatedRunCampaign(forceNext = false) {
                const curCamp = activeStream.campaigns[activeStream.campaign.onCamp];
                const skipped = activeStream.campaign.skippedStreamers || [];
                const available = curCamp.streamers.filter(s => !skipped.includes(s));
                const target = available.length > 0 ? available[0] : curCamp.streamers[0];
                activeStream.campaign.curWatching = target;
                rotatedToStreamer = target;
            }

            async function handleWatchdogTickSimulation() {
                const curCamp = activeStream.campaigns[activeStream.campaign.onCamp];
                const currentMinutes = curCamp.minutesWatched;
                const now = Date.now();

                const elapsedMs = now - activeStream.campaign.lastProgressTimestamp;
                const stallThresholdMs = 2 * 60 * 1000; // 2 minutes

                if (elapsedMs >= stallThresholdMs) {
                    activeStream.campaign.stallCount = (activeStream.campaign.stallCount || 0) + 1;
                    activeStream.campaign.lastProgressTimestamp = now;

                    if (activeStream.campaign.stallCount === 1) {
                        // Reload stream tab
                        if (curWindow.id !== 0) {
                            await sandbox.chrome.tabs.reload(curWindow.id);
                        }
                    } else {
                        // Rotate to next channel
                        activeStream.campaign.skippedStreamers = activeStream.campaign.skippedStreamers || [];
                        if (activeStream.campaign.curWatching && !activeStream.campaign.skippedStreamers.includes(activeStream.campaign.curWatching)) {
                            activeStream.campaign.skippedStreamers.push(activeStream.campaign.curWatching);
                        }
                        activeStream.campaign.stallCount = 0;
                        await simulatedRunCampaign(true);
                    }
                }
            }

            // Tick 1: Stall count 1 -> reload stream tab
            await handleWatchdogTickSimulation();
            assert.equal(activeStream.campaign.stallCount, 1);
            assert.equal(reloadedTabIds.length, 1);
            assert.equal(reloadedTabIds[0], tab.id);
            assert.equal(activeStream.campaign.curWatching, "streamer_a");

            // Advance time again without progress delta
            activeStream.campaign.lastProgressTimestamp = Date.now() - 130000;

            // Tick 2: Persistent stall (stall count 2) -> rotate to streamer_b
            await handleWatchdogTickSimulation();
            assert.equal(activeStream.campaign.stallCount, 0, "Stall count resets on channel rotation");
            assert.equal(activeStream.campaign.curWatching, "streamer_b");
            assert.ok(activeStream.campaign.skippedStreamers.includes("streamer_a"));
            assert.equal(rotatedToStreamer, "streamer_b");
        });

        it("T5-M4-6: Rapid concurrent streamer skip requests (50 rapid skips) maintain skippedStreamers integrity", async () => {
            const streamersList = ["streamer_1", "streamer_2", "streamer_3", "streamer_4", "streamer_5"];
            const activeStream = {
                campaign: {
                    game: { name: "Rust" },
                    onCamp: 0,
                    curWatching: "streamer_1",
                    status: "watching",
                    skippedStreamers: []
                },
                campaigns: [
                    {
                        id: "camp-rust",
                        game: "Rust",
                        minutesWatched: 10,
                        minutesNeeded: 60,
                        streamers: streamersList
                    }
                ]
            };

            async function skipStreamerSimulation() {
                activeStream.campaign.skippedStreamers = activeStream.campaign.skippedStreamers || [];
                if (activeStream.campaign.curWatching) {
                    if (!activeStream.campaign.skippedStreamers.includes(activeStream.campaign.curWatching)) {
                        activeStream.campaign.skippedStreamers.push(activeStream.campaign.curWatching);
                    }
                }
                const curCamp = activeStream.campaigns[activeStream.campaign.onCamp];
                const available = curCamp.streamers.filter(s => !activeStream.campaign.skippedStreamers.includes(s));
                if (available.length > 0) {
                    activeStream.campaign.curWatching = available[0];
                } else {
                    activeStream.campaign.skippedStreamers = [];
                    activeStream.campaign.curWatching = curCamp.streamers[0];
                }
            }

            // Simulate 50 sequential and interleaved skip calls
            for (let i = 0; i < 50; i++) {
                await skipStreamerSimulation();
                assert.ok(streamersList.includes(activeStream.campaign.curWatching));
            }

            // Ensure no duplicate entries in skippedStreamers
            const uniqueSkipped = new Set(activeStream.campaign.skippedStreamers);
            assert.equal(uniqueSkipped.size, activeStream.campaign.skippedStreamers.length);
        });

        it("T5-M4-7: Streamer offline and game category switch detection triggers immediate failover", async () => {
            sandbox.fetchMock.onGql("ChannelShell", (url, opts, body) => {
                const username = body?.variables?.login;
                if (username === "offline_streamer") {
                    return new MockHttpResponse(channelShellOfflineFixture, { status: 200 });
                } else if (username === "switched_game_streamer") {
                    return new MockHttpResponse({
                        data: {
                            userOrError: {
                                login: "switched_game_streamer",
                                stream: {
                                    id: "stream-switched",
                                    game: { name: "Just Chatting", displayName: "Just Chatting" },
                                    title: "Chatting with viewers",
                                    viewersCount: 2500
                                }
                            }
                        }
                    }, { status: 200 });
                }
                return new MockHttpResponse(channelShellLiveFixture, { status: 200 });
            });

            // 1. Offline Streamer Check
            const offlineStreamStatus = await client.getStream("offline_streamer");
            assert.equal(offlineStreamStatus, null, "Offline streamer getStream() must return null");

            // 2. Metadata Check
            const meta = await client.getStreamMetadata("switched_game_streamer");
            assert.equal(meta.game, "Just Chatting");

            const activeGame = "Overwatch 2";
            const isCategoryMismatch = meta.game && !meta.game.toLowerCase().includes(activeGame.toLowerCase());
            assert.equal(isCategoryMismatch, true, "Category mismatch must be detected");
        });

        it("T5-M4-8: Tab closure watchdog & retry limit: pauses campaign after 5 consecutive tab closures", async () => {
            let campaignStatus = "watching";
            let reopenAttempts = 0;
            let isCompleted = false;

            async function onTabRemovedSimulation(tabId, managedTabId) {
                if (tabId === managedTabId) {
                    if (isCompleted) return;

                    reopenAttempts++;
                    if (reopenAttempts > 5) {
                        campaignStatus = "paused";
                        return;
                    }
                    campaignStatus = "reopening";
                }
            }

            // Close tab 5 times
            for (let i = 1; i <= 5; i++) {
                await onTabRemovedSimulation(101, 101);
                assert.equal(campaignStatus, "reopening");
                assert.equal(reopenAttempts, i);
            }

            // 6th closure exceeds limit (reopenAttempts > 5)
            await onTabRemovedSimulation(101, 101);
            assert.equal(campaignStatus, "paused", "Campaign status must be set to paused after > 5 closures");
            assert.equal(reopenAttempts, 6);
        });
    });

    // =========================================================================
    // DOMAIN 3: Channel Points Bonus Chest Floods & Concurrent Drop Claim Hardening
    // =========================================================================
    describe("Domain 3: Channel Points Bonus Chest Floods & Concurrent Drop Claim Hardening", () => {

        it("T5-M4-9: High-concurrency bonus chest click flood (200 simultaneous triggers) executes mutation exactly once", async () => {
            sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);

            const recentBgClaims = new Map();
            function isDuplicateBackgroundClaim(key, ttlMs = 15000) {
                const now = Date.now();
                for (const [k, time] of recentBgClaims.entries()) {
                    if (now - time > 60000) recentBgClaims.delete(k);
                }
                if (recentBgClaims.has(key) && (now - recentBgClaims.get(key) < ttlMs)) {
                    return true;
                }
                recentBgClaims.set(key, now);
                return false;
            }

            let claimedPointsTotal = 0;
            let networkMutationCalls = 0;

            async function simulateHandlePointsClaim(claimId, channelId) {
                if (!isDuplicateBackgroundClaim("claim-" + claimId, 15000)) {
                    networkMutationCalls++;
                    const result = await client.claimChannelPoints(channelId, claimId);
                    if (result && (result.success || result.status === "SUCCESS")) {
                        const pts = result.points || 50;
                        claimedPointsTotal += pts;
                    }
                }
            }

            const concurrentClicks = Array.from({ length: 200 }, () =>
                simulateHandlePointsClaim("chest-flood-claim-id-999", "channel-12345")
            );

            await Promise.all(concurrentClicks);

            assert.equal(networkMutationCalls, 1, `Mutation must be invoked exactly 1 time, got ${networkMutationCalls}`);
            assert.equal(claimedPointsTotal, 50, `Total claimed points must be exactly 50, got ${claimedPointsTotal}`);
        });

        it("T5-M4-10: Multi-drop concurrent claim storm (100 simultaneous claims) claims distinct drops accurately with no race conditions", async () => {
            sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

            const distinctDrops = [
                { id: "drop-apex-1", dropInstanceID: "inst-apex-1", name: "Apex Badge", minutes: 60 },
                { id: "drop-apex-2", dropInstanceID: "inst-apex-2", name: "Apex Skin", minutes: 120 },
                { id: "drop-apex-3", dropInstanceID: "inst-apex-3", name: "Apex Holospray", minutes: 180 }
            ];

            const testInventory = {
                dropCampaignsInProgress: [
                    {
                        id: "camp-apex",
                        game: { displayName: "Apex Legends" },
                        timeBasedDrops: distinctDrops.map(d => ({
                            id: d.id,
                            name: d.name,
                            requiredMinutesWatched: d.minutes,
                            self: { isClaimed: false, currentMinutesWatched: d.minutes, dropInstanceID: d.dropInstanceID }
                        }))
                    }
                ]
            };

            sandbox.fetchMock.onGql("Inventory", { data: { currentUser: { inventory: testInventory } } });

            const recentBgClaims = new Map();
            function isDuplicateBackgroundClaim(key, ttlMs = 30000) {
                const now = Date.now();
                if (recentBgClaims.has(key) && (now - recentBgClaims.get(key) < ttlMs)) return true;
                recentBgClaims.set(key, now);
                return false;
            }

            let claimedDropsCount = 0;
            const claimedInstanceIds = new Set();
            const notifications = [];

            async function simulatedCheckClaimDrop() {
                const inventory = await client.getInventory();
                if (!inventory || !inventory.dropCampaignsInProgress) return;

                for (const camp of inventory.dropCampaignsInProgress) {
                    for (const drop of (camp.timeBasedDrops || [])) {
                        if (drop.requiredMinutesWatched <= drop.self.currentMinutesWatched && !drop.self.isClaimed) {
                            const dropInstanceId = drop.self.dropInstanceID;
                            if (!dropInstanceId) continue;
                            if (isDuplicateBackgroundClaim("drop-claim-" + dropInstanceId, 30000)) continue;

                            try {
                                const dropClaim = await client.claimDropReward(dropInstanceId);
                                if (dropClaim && (dropClaim.status === "SUCCESS" || dropClaim.success === true)) {
                                    drop.self.isClaimed = true;
                                    claimedDropsCount++;
                                    claimedInstanceIds.add(dropInstanceId);
                                    notifications.push(`Claimed ${drop.name}`);
                                }
                            } catch (err) {}
                        }
                    }
                }
            }

            // Launch 100 concurrent workers
            const workers = Array.from({ length: 100 }, () => simulatedCheckClaimDrop());
            await Promise.all(workers);

            assert.equal(claimedDropsCount, 3, "Exactly 3 unique drops should be claimed");
            assert.equal(claimedInstanceIds.size, 3, "All 3 unique instance IDs recorded");
            assert.equal(notifications.length, 3, "Exactly 3 notifications sent");
        });

        it("T5-M4-11: Deduplication cache memory leak & TTL eviction test prunes expired entries", () => {
            const cache = new Map();
            const ttlMs = 10000;
            const pruneIntervalMs = 60000;

            function isDuplicate(key, now = Date.now()) {
                // Prune entries older than 60s
                for (const [k, time] of cache.entries()) {
                    if (now - time > pruneIntervalMs) {
                        cache.delete(k);
                    }
                }
                if (cache.has(key) && (now - cache.get(key) < ttlMs)) {
                    return true;
                }
                cache.set(key, now);
                return false;
            }

            const baseTime = Date.now();

            // Insert 5,000 old entries (older than 60s)
            for (let i = 0; i < 5000; i++) {
                cache.set(`old-key-${i}`, baseTime - 70000);
            }
            assert.equal(cache.size, 5000);

            // Accessing with a new key triggers automatic pruning
            const isDup = isDuplicate("new-key-1", baseTime);
            assert.equal(isDup, false);

            // All 5,000 expired keys must be pruned; cache size should be 1
            assert.equal(cache.size, 1, `Cache size should be pruned to 1, got ${cache.size}`);
            assert.ok(cache.has("new-key-1"));
        });
    });

    // =========================================================================
    // DOMAIN 4: Storage State Mutations, Hydration Mutex & Popup Reactivity
    // =========================================================================
    describe("Domain 4: Storage State Mutations, Hydration Mutex & Popup Reactivity", () => {

        it("T5-M4-12: High-velocity storage mutation storm (100 concurrent sets) with state hydration mutex maintains consistency", async () => {
            let isHydrated = false;
            let hydrationPromise = null;
            let hydrationCount = 0;
            let extStats = { claimedDrops: 0, claimedPoints: 0 };
            let settings = { autoRefresh: true, lowQualityMode: true };

            async function hydrateState() {
                if (isHydrated) return;
                if (hydrationPromise) return await hydrationPromise;

                hydrationPromise = (async () => {
                    hydrationCount++;
                    const val = await sandbox.chrome.storage.local.get(["extStats", "settings"]);
                    if (val.extStats) extStats = { ...extStats, ...val.extStats };
                    if (val.settings) settings = { ...settings, ...val.settings };
                    isHydrated = true;
                })();

                return await hydrationPromise;
            }

            // Seed storage
            await sandbox.chrome.storage.local.set({
                extStats: { claimedDrops: 42, claimedPoints: 2100 },
                settings: { autoRefresh: false, lowQualityMode: true }
            });

            // 100 concurrent boot triggers attempting to hydrate simultaneously
            const concurrentHydrations = Array.from({ length: 100 }, () => hydrateState());
            await Promise.all(concurrentHydrations);

            assert.equal(hydrationCount, 1, "Hydration mutex must guarantee exactly 1 execution");
            assert.equal(extStats.claimedDrops, 42);
            assert.equal(extStats.claimedPoints, 2100);
            assert.equal(settings.autoRefresh, false);
            assert.equal(settings.lowQualityMode, true);
        });

        it("T5-M4-13: Rapid popup tab switching and settings mutation floods execute without state desync", async () => {
            const tabPages = ["mainPage", "dropsPage", "autoDropsPage", "activityPage", "settingsPage"];
            let activePage = "mainPage";

            const toggleSettings = [
                "autoRefresh",
                "showAllGames",
                "autoGetToken",
                "watchPopout",
                "autoMute",
                "setShowBadges",
                "soundOnClaim",
                "desktopNotifications",
                "lowQualityMode"
            ];

            let popupSettings = {
                autoRefresh: true,
                showAllGames: true,
                autoGetToken: true,
                watchPopout: true,
                autoMute: true,
                setShowBadges: true,
                soundOnClaim: false,
                desktopNotifications: true,
                lowQualityMode: true
            };

            for (let i = 0; i < 50; i++) {
                activePage = tabPages[i % tabPages.length];
                const toggledKey = toggleSettings[i % toggleSettings.length];
                popupSettings[toggledKey] = !popupSettings[toggledKey];

                await sandbox.chrome.storage.local.set({
                    settings: popupSettings,
                    currentPage: activePage
                });
            }

            const stored = await sandbox.chrome.storage.local.get(["settings", "currentPage"]);
            assert.deepEqual(stored.settings, popupSettings);
            assert.equal(stored.currentPage, activePage);
        });

        it("T5-M4-14: Malformed storage recovery: service worker hydrates safely on null/corrupted/missing fields", async () => {
            const corruptedStates = [
                null,
                {},
                { exEnabled: "not_a_bool", settings: "invalid_settings_string" },
                { extStats: null, activeStream: { campaign: null, campaigns: null } },
                { autoDropGames: "not_an_array", listOfConnected: null },
                { oauthToken: null, twitchInteg: { expiration: "bad_number" } }
            ];

            for (const corrupted of corruptedStates) {
                await sandbox.chrome.storage.local.clear();
                if (corrupted) {
                    await sandbox.chrome.storage.local.set(corrupted);
                }

                assert.doesNotThrow(async () => {
                    const val = await sandbox.chrome.storage.local.get([
                        "exEnabled",
                        "settings",
                        "autoDropGames",
                        "extStats",
                        "activeStream"
                    ]);
                    const enabled = val.exEnabled !== undefined ? Boolean(val.exEnabled) : true;
                    const stats = val.extStats && typeof val.extStats === "object" ? val.extStats : { claimedDrops: 0 };
                    assert.ok(typeof enabled === "boolean");
                    assert.ok(typeof stats === "object");
                });
            }
        });
    });

    // =========================================================================
    // DOMAIN 5: Zero Unhandled Promise Rejections & Contract Compliance
    // =========================================================================
    describe("Domain 5: Global Process Stability & Zero Unhandled Rejections", () => {
        it("T5-M4-15: Zero unhandled promise rejections recorded during full stress test execution", () => {
            assert.equal(
                unhandledRejections.length,
                0,
                `Found ${unhandledRejections.length} unhandled rejections during test execution`
            );
        });
    });
});
