import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import {
    currentUserFixture,
    viewerDropsDashboardFixture,
    dropCampaignDetailsFixture,
    inventoryFixture,
    directoryPageGameFixture,
    claimDropRewardSuccessFixture,
    claimCommunityPointsSuccessFixture,
    channelShellLiveFixture,
    channelShellOfflineFixture
} from "../fixtures/graphql-fixtures.js";

describe("Tier 4: Real-World Application Scenarios", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc",
            deviceId: "test-device-123",
            userId: "12345678"
        });
    });

    it("Scenario 1: Full Lifecycle Drop Farming (F2, F3, F4, F6, F9, F10, F14)", async () => {
        // 1. Initial State & Cookie Hydration
        await sandbox.chrome.cookies.set({ name: "auth-token", value: "test-oauth-token-abc", domain: ".twitch.tv" });
        await sandbox.chrome.storage.local.set({
            settings: { autoRefresh: true, autoMute: true, desktopNotifications: true },
            extStats: { claimedDrops: 0, claimedPoints: 0 },
            autoDropGames: ["Overwatch 2"]
        });

        // 2. Discover Active Campaigns
        sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);
        const campaigns = await client.getDropCampaigns();
        assert.equal(campaigns.length, 1);
        const campaign = campaigns[0];
        assert.equal(campaign.game.name, "Overwatch 2");

        // 3. Fetch Detailed Campaign Info
        sandbox.fetchMock.onGql("DropCampaignDetails", dropCampaignDetailsFixture);
        const details = await client.getDropCampaignDetails(campaign.id);
        assert.equal(details.timeBasedDrops[0].requiredMinutesWatched, 120);

        // 4. Discover Live Streamer & Launch Tab
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);
        const streamer = await client.getChannelWithDrops(campaign.game.name, campaign.id);
        assert.ok(streamer);

        const tab = await sandbox.chrome.tabs.create({
            url: `https://www.twitch.tv/${streamer.broadcaster.login}#atd-managed=1`,
            active: false,
            muted: true
        });
        assert.ok(tab.id);

        const activeStreamState = {
            campaign: {
                id: campaign.id,
                game: campaign.game,
                status: "watching",
                curWatching: streamer.broadcaster.login,
                minutesWatched: 45,
                minutesNeeded: 120
            }
        };
        await sandbox.chrome.storage.local.set({ activeStream: activeStreamState });

        // 5. Simulate Hermes WebSocket Drop Progress Event (progress reaches 100%)
        const ws = new WebSocket("wss://hermes.twitch.tv");
        sandbox.websocketMock.emitHermesDropProgress("drop-ow-1", 120, 120);

        // 6. Sync Inventory & Claim Drop
        sandbox.fetchMock.onGql("Inventory", inventoryFixture);
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        const inventory = await client.getInventory();
        assert.ok(inventory);
        const targetDrop = inventory.dropCampaignsInProgress[0].timeBasedDrops[0];

        const claimRes = await client.claimDropReward(targetDrop.self.dropInstanceID);
        assert.equal(claimRes.status, "SUCCESS");
        assert.equal(claimRes.success, true);

        // 7. Update Stats, Activity Log, and UI
        const currentStats = (await sandbox.chrome.storage.local.get("extStats")).extStats;
        currentStats.claimedDrops += 1;
        await sandbox.chrome.storage.local.set({ extStats: currentStats });

        sandbox.chrome.notifications.create({
            title: "Drop Claimed!",
            message: `${targetDrop.name} has been claimed!`
        });

        // 8. Close Tab & Complete Campaign
        await sandbox.chrome.tabs.remove(tab.id);
        assert.equal(sandbox.chrome._tabs.size, 0);
        assert.equal(sandbox.chrome._notifications.length, 1);
        assert.equal((await sandbox.chrome.storage.local.get("extStats")).extStats.claimedDrops, 1);
    });

    it("Scenario 2: Streamer Offline & Stall Auto-Recovery (F5, F8, F10, F11, F12)", async () => {
        // 1. Setup Active Tab on initial streamer
        const initialStreamer = "superstreamer";
        const tab = await sandbox.chrome.tabs.create({
            url: `https://www.twitch.tv/${initialStreamer}#atd-managed=1`,
            active: false,
            muted: true
        });

        // 2. Periodic Watchdog checks stream status -> discovers streamer went offline
        sandbox.fetchMock.onGql("ChannelShell", channelShellOfflineFixture);
        const streamStatus = await client.getStream(initialStreamer);
        assert.equal(streamStatus, null); // offline!

        // 3. Trigger Streamer Rotation: Find alternate streamer skipping offline streamer
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);
        const skipped = [initialStreamer];
        const nextStreamer = await client.getChannelWithDrops("Overwatch 2", "camp-ow-1", null, skipped);

        assert.ok(nextStreamer);
        assert.equal(nextStreamer.broadcaster.login, "chillgamer");

        // 4. Update Tab URL to new streamer without closing process
        const updatedTab = await sandbox.chrome.tabs.update(tab.id, {
            url: `https://www.twitch.tv/${nextStreamer.broadcaster.login}#atd-managed=1`
        });

        assert.ok(updatedTab.url.includes("chillgamer#atd-managed=1"));
        assert.equal(updatedTab.id, tab.id);
    });

    it("Scenario 3: Concurrent Channel Points & Drop Claim Event Storm (F6, F7, F9, F13, F14)", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        const dedupSet = new Set();
        let totalPointsClaimed = 0;
        let totalDropsClaimed = 0;

        async function handlePointsClaim(claimId, channelId) {
            if (dedupSet.has(claimId)) return false;
            dedupSet.add(claimId);
            const res = await client.claimChannelPoints(claimId, channelId);
            if (res && res.success) {
                totalPointsClaimed += res.points;
                return true;
            }
            return false;
        }

        async function handleDropClaim(dropId) {
            if (dedupSet.has(dropId)) return false;
            dedupSet.add(dropId);
            const res = await client.claimDropReward(dropId);
            if (res && res.status === "SUCCESS") {
                totalDropsClaimed += 1;
                return true;
            }
            return false;
        }

        // Fire a storm of concurrent / duplicate events
        const eventPromises = [
            handlePointsClaim("chest-claim-100", "user-101"),
            handlePointsClaim("chest-claim-100", "user-101"), // duplicate
            handlePointsClaim("chest-claim-100", "user-101"), // duplicate
            handlePointsClaim("chest-claim-200", "user-101"),
            handleDropClaim("inst-ow-1"),
            handleDropClaim("inst-ow-1"), // duplicate
            handleDropClaim("inst-ow-2")
        ];

        const results = await Promise.all(eventPromises);

        assert.equal(totalPointsClaimed, 100); // 2 distinct claims @ 50 pts each
        assert.equal(totalDropsClaimed, 2);    // 2 distinct drop instances
        assert.equal(results.filter(r => r === true).length, 4);
    });

    it("Scenario 4: Token Expiration & Integrity Refresh Loop (F1, F5, F10)", async () => {
        // 1. Initial Call with expired integrity token
        client.integrity = { token: "expired-token", expiration: Date.now() - 5000 };

        const isExpired = !(await client.getInteg());
        assert.equal(isExpired, true);

        // 2. Trigger Integrity Refresh Route
        const integRes = await fetch("https://gql.twitch.tv/integrity", { method: "POST" });
        const integData = await integRes.json();

        assert.ok(integData.token);
        assert.ok(integData.expiration > Date.now());

        // 3. Update Client with fresh integrity token
        await client.setInteg(integData);
        assert.equal(client.integrity.token, integData.token);

        // 4. Verify subsequent authenticated call succeeds with new token
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", currentUserFixture);
        const userId = await client.autoDetectUserId();

        assert.equal(userId, "12345678");
        const req = sandbox.fetchMock.history.find(h => h.body?.operationName === "CoreActionsCurrentUser");
        assert.equal(req.headers["Client-Integrity"], integData.token);
    });

    it("Scenario 5: Service Worker Suspension & Wakeup Re-hydration (F10, F14)", async () => {
        // 1. Worker saves full state before sleeping
        const preSleepState = {
            settings: { autoRefresh: true, autoMute: true, lowQualityMode: true },
            extStats: { claimedDrops: 7, claimedPoints: 350 },
            autoDropGames: ["Valorant", "Overwatch 2"],
            activeStream: {
                campaign: { id: "camp-val-1", status: "watching", curWatching: "tenz" }
            },
            curWindow: { id: 105, type: "tab" }
        };
        await sandbox.chrome.storage.local.set(preSleepState);

        // 2. Simulate Worker Sleep: Clear in-memory variables
        let memoryActiveStream = null;
        let memoryStats = null;
        let memorySettings = null;

        // 3. Worker Wakeup Trigger (e.g. periodic watchdog alarm)
        sandbox.chrome.alarms.onAlarm.addListener(async (alarm) => {
            if (alarm.name === "watchdogAlarm") {
                const stored = await sandbox.chrome.storage.local.get([
                    "settings",
                    "extStats",
                    "autoDropGames",
                    "activeStream",
                    "curWindow"
                ]);
                memorySettings = stored.settings;
                memoryStats = stored.extStats;
                memoryActiveStream = stored.activeStream;
            }
        });

        sandbox.chrome.alarms.create("watchdogAlarm", { periodInMinutes: 0.5 });
        await sandbox.chrome.alarms.trigger("watchdogAlarm");

        // 4. Verify Re-hydrated In-Memory State
        assert.ok(memorySettings);
        assert.equal(memorySettings.lowQualityMode, true);
        assert.equal(memoryStats.claimedDrops, 7);
        assert.equal(memoryStats.claimedPoints, 350);
        assert.equal(memoryActiveStream.campaign.id, "camp-val-1");
        assert.equal(memoryActiveStream.campaign.curWatching, "tenz");
    });
});
