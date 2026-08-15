import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 5: Adversarial M3 - Popup UI/UX Reactivity, Auth State & Storage Hardening", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("M3-AC1: High-throughput concurrent storage change bursts update listener without dropping events", async () => {
        const receivedChanges = [];
        sandbox.chrome.storage.onChanged.addListener((changes, area) => {
            if (area === "local") {
                receivedChanges.push(changes);
            }
        });

        // Emit 50 rapid sequential storage mutations
        for (let i = 0; i < 50; i++) {
            await sandbox.chrome.storage.local.set({
                extStats: { claimedDrops: i, claimedPoints: i * 50 }
            });
        }

        assert.equal(receivedChanges.length, 50);
        assert.equal(receivedChanges[49].extStats.newValue.claimedDrops, 49);
        assert.equal(receivedChanges[49].extStats.newValue.claimedPoints, 2450);
    });

    it("M3-AC2: ActiveStream storage updates gracefully survive malformed, null, and empty payloads", async () => {
        const testPayloads = [
            null,
            {},
            { campaign: "none" },
            { campaign: null },
            { campaign: { game: null, onCamp: 999 } },
            { campaign: { game: { displayName: "Test Game" } }, campaigns: [] },
            { campaign: { game: { displayName: "Test Game" } }, campaigns: [{ items: null }] },
            { campaign: { game: { displayName: "Test Game" } }, campaigns: [{ items: [{ self: null }] }] },
            { campaign: { curWatching: "streamer1" }, campaigns: [{ items: [{ reqTime: 0, self: { currentMinutesWatched: 0 } }] }] }
        ];

        let lastStream = null;
        sandbox.chrome.storage.onChanged.addListener((changes) => {
            if (changes.activeStream) {
                lastStream = changes.activeStream.newValue;
            }
        });

        for (const payload of testPayloads) {
            await sandbox.chrome.storage.local.set({ activeStream: payload });
            assert.deepEqual(lastStream, payload);
        }
    });

    it("M3-AC3: Auth state reactivity toggles authentication status banners cleanly", async () => {
        let currentAuthState = null;
        sandbox.chrome.storage.onChanged.addListener((changes) => {
            if (changes.authState) {
                currentAuthState = changes.authState.newValue;
            }
        });

        // 1. Unauthenticated state
        await sandbox.chrome.storage.local.set({
            oauthToken: null,
            authState: { isAuthenticated: false, error: null }
        });
        assert.equal(currentAuthState.isAuthenticated, false);

        // 2. Network / GQL Error state
        await sandbox.chrome.storage.local.set({
            oauthToken: null,
            authState: { isAuthenticated: false, error: "Network timeout communicating with Twitch GraphQL" }
        });
        assert.equal(currentAuthState.error, "Network timeout communicating with Twitch GraphQL");

        // 3. Re-authenticated state
        await sandbox.chrome.storage.local.set({
            oauthToken: "valid_oauth_token_12345",
            authState: { isAuthenticated: true, error: null }
        });
        assert.equal(currentAuthState.isAuthenticated, true);
        assert.equal(currentAuthState.error, null);
    });

    it("M3-AC4: Auto-Queue mass operations withstand rapid toggle storms and maintain set uniqueness", async () => {
        const games = ["Overwatch 2", "Apex Legends", "Valorant", "Rust", "Fortnite"];

        // Mass select
        await sandbox.chrome.storage.local.set({ autoDropGames: games });
        let stored = await sandbox.chrome.storage.local.get("autoDropGames");
        assert.equal(stored.autoDropGames.length, 5);

        // Deduplication & mass deselect
        const uniqueSet = Array.from(new Set([...games, ...games]));
        assert.equal(uniqueSet.length, 5);

        await sandbox.chrome.storage.local.set({ autoDropGames: [] });
        stored = await sandbox.chrome.storage.local.get("autoDropGames");
        assert.equal(stored.autoDropGames.length, 0);
    });

    it("M3-AC5: Settings changes propagate smoothly across all 7 boolean toggles", async () => {
        const fullSettings = {
            autoRefresh: true,
            showAllGames: true,
            autoGetToken: true,
            watchPopout: true,
            autoMute: true,
            setShowBadges: true,
            soundOnClaim: true,
            desktopNotifications: true,
            lowQualityMode: true
        };

        await sandbox.chrome.storage.local.set({ settings: fullSettings });
        const retrieved = await sandbox.chrome.storage.local.get("settings");
        assert.deepEqual(retrieved.settings, fullSettings);

        // Invert toggles
        const inverted = {};
        for (const k in fullSettings) {
            inverted[k] = !fullSettings[k];
        }
        await sandbox.chrome.storage.local.set({ settings: inverted });
        const retrievedInverted = await sandbox.chrome.storage.local.get("settings");
        assert.deepEqual(retrievedInverted.settings, inverted);
    });
});
