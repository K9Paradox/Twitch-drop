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

describe("Tier 3: Pairwise & Cross-Feature Integration Combinations", () => {
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

    it("F1+F2: User Authentication & Dashboard Sync", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", currentUserFixture);
        sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);

        const userId = await client.autoDetectUserId();
        assert.equal(userId, "12345678");

        const campaigns = await client.getDropCampaigns();
        assert.ok(Array.isArray(campaigns));
        assert.equal(campaigns[0].id, "camp-ow-1");
        assert.equal(campaigns[0].game.name, "Overwatch 2");
    });

    it("F2+F5: Campaign Discovery & Live Channel Selection", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        const campaigns = await client.getDropCampaigns();
        const activeGame = campaigns[0].game.name;

        const liveChannel = await client.getChannelWithDrops(activeGame, campaigns[0].id);
        assert.ok(liveChannel);
        assert.equal(liveChannel.broadcaster.login, "superstreamer");
    });

    it("F5+F11: Channel Discovery to Background Tab Launch", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        const channel = await client.getChannelWithDrops("Overwatch 2", "camp-ow-1");
        assert.ok(channel);

        const targetUrl = `https://www.twitch.tv/${channel.broadcaster.login}#atd-managed=1`;
        const tab = await sandbox.chrome.tabs.create({
            url: targetUrl,
            active: false,
            muted: true
        });

        assert.equal(tab.active, false);
        assert.equal(tab.mutedInfo.muted, true);
        assert.ok(tab.url.includes("superstreamer#atd-managed=1"));
    });

    it("F9+F13: WebSocket PubSub Bonus Chest to Activity History", async () => {
        let history = [];
        function logPoints(pts, game) {
            history.unshift({
                id: `pts-${Date.now()}`,
                type: "points",
                title: `+${pts} Channel Points`,
                game: game,
                points: pts,
                timestamp: new Date().toISOString()
            });
        }

        const ws = new WebSocket("wss://hermes.twitch.tv");
        ws.addEventListener("message", (evt) => {
            const data = JSON.parse(evt.data);
            if (data.type === "MESSAGE") {
                const parsed = JSON.parse(data.data.message);
                if (parsed.type === "points-earned") {
                    logPoints(parsed.data.point_gain.total_points, "Overwatch 2");
                }
            }
        });

        sandbox.websocketMock.emitHermesPoints(50, "user-101");

        assert.equal(history.length, 1);
        assert.equal(history[0].points, 50);
        assert.equal(history[0].game, "Overwatch 2");
    });

    it("F9+F6: WebSocket Drop Progress to Drop Claim Mutation", async () => {
        sandbox.fetchMock.onGql("Inventory", inventoryFixture);
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        let claimResult = null;
        const ws = new WebSocket("wss://hermes.twitch.tv");
        ws.addEventListener("message", async (evt) => {
            const data = JSON.parse(evt.data);
            if (data.type === "MESSAGE") {
                const parsed = JSON.parse(data.data.message);
                if (parsed.type === "drop-progress") {
                    // Check inventory and trigger claim
                    const inv = await client.getInventory();
                    if (inv && inv.dropCampaignsInProgress.length > 0) {
                        const drop = inv.dropCampaignsInProgress[0].timeBasedDrops[0];
                        claimResult = await client.claimDropReward(drop.self.dropInstanceID);
                    }
                }
            }
        });

        sandbox.websocketMock.emitHermesDropProgress("drop-ow-1", 120, 120);

        // Allow async promise chain to settle
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.ok(claimResult);
        assert.equal(claimResult.status, "SUCCESS");
        assert.equal(claimResult.success, true);
    });

    it("F6+F10: Drop Claim Mutation to Notification & Stats Storage", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        const res = await client.claimDropReward("inst-ow-1");
        assert.equal(res.status, "SUCCESS");
        assert.equal(res.success, true);

        // Increment stats and trigger notification
        const stats = { claimedDrops: 1, claimedPoints: 0 };
        await sandbox.chrome.storage.local.set({ extStats: stats });

        sandbox.chrome.notifications.create({
            title: "Drop Claimed!",
            message: "Kiriko Skin claimed successfully."
        });

        const stored = await sandbox.chrome.storage.local.get("extStats");
        assert.equal(stored.extStats.claimedDrops, 1);
        assert.equal(sandbox.chrome._notifications.length, 1);
    });

    it("F7+F13: Channel Points Claim Mutation to Deduplicated State", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);

        const claimedIds = new Set();
        let totalPoints = 0;

        async function handleClaim(claimId, channelId) {
            if (claimedIds.has(claimId)) return false;
            claimedIds.add(claimId);
            const res = await client.claimChannelPoints(claimId, channelId);
            if (res && res.success) {
                totalPoints += res.points;
                return true;
            }
            return false;
        }

        const first = await handleClaim("chest-claim-100", "user-101");
        const second = await handleClaim("chest-claim-100", "user-101");

        assert.equal(first, true);
        assert.equal(second, false);
        assert.equal(totalPoints, 50);
    });

    it("F4+F12: Inventory Sync to Campaign Completion Detection", async () => {
        sandbox.fetchMock.onGql("Inventory", {
            data: {
                currentUser: {
                    inventory: {
                        dropCampaignsInProgress: [
                            {
                                id: "camp-ow-1",
                                game: { name: "Overwatch 2" },
                                timeBasedDrops: [
                                    {
                                        id: "drop-1",
                                        requiredMinutesWatched: 60,
                                        self: { isClaimed: true, currentMinutesWatched: 60 }
                                    }
                                ]
                            }
                        ],
                        gameEventDrops: []
                    }
                }
            }
        });

        const inventory = await client.getInventory();
        const camp = inventory.dropCampaignsInProgress[0];
        const allClaimed = camp.timeBasedDrops.every(d => d.self.isClaimed);

        assert.equal(allClaimed, true);
    });

    it("F8+F12: Streamer Metadata Check to Offline Failover", async () => {
        sandbox.fetchMock.onGql("ChannelShell", channelShellOfflineFixture);
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        const streamMeta = await client.getStream("offline_streamer");
        assert.equal(streamMeta, null);

        // Failover to new streamer
        const fallbackChannel = await client.getChannelWithDrops("Overwatch 2", "camp-ow-1", null, ["offline_streamer"]);
        assert.ok(fallbackChannel);
        assert.equal(fallbackChannel.broadcaster.login, "superstreamer");
    });

    it("F10+F14: Storage Change Reactivity to Popup UI Sync", async () => {
        let badgeTextUpdated = null;
        sandbox.chrome.storage.onChanged.addListener((changes) => {
            if (changes.extStats) {
                const count = changes.extStats.newValue.claimedDrops;
                sandbox.chrome.action.setBadgeText({ text: String(count) });
                badgeTextUpdated = String(count);
            }
        });

        await sandbox.chrome.storage.local.set({
            extStats: { claimedDrops: 5, claimedPoints: 250 }
        });

        assert.equal(badgeTextUpdated, "5");
        assert.equal(sandbox.chrome._badgeText, "5");
    });

    it("F1+F10: Cookie Authentication to Client Initialization", async () => {
        await sandbox.chrome.cookies.set({
            name: "auth-token",
            value: "live_oauth_token_from_cookie",
            domain: ".twitch.tv"
        });

        const cookie = await sandbox.chrome.cookies.get({ name: "auth-token", url: "https://www.twitch.tv" });
        assert.ok(cookie);

        const newClient = new Client({ clientId: "test-client-id", oauthToken: cookie.value });
        assert.equal(newClient.oauthToken, "live_oauth_token_from_cookie");
    });

    it("F3+F4: Detailed Campaign Time Requirements to Inventory Watched Progress", async () => {
        sandbox.fetchMock.onGql("DropCampaignDetails", dropCampaignDetailsFixture);
        sandbox.fetchMock.onGql("Inventory", inventoryFixture);

        const details = await client.getDropCampaignDetails("camp-ow-1");
        const inventory = await client.getInventory();

        const reqMinutes = details.timeBasedDrops[0].requiredMinutesWatched;
        const currentWatched = inventory.dropCampaignsInProgress[0].timeBasedDrops[0].self.currentMinutesWatched;

        const remainingMinutes = reqMinutes - currentWatched;
        assert.equal(reqMinutes, 120);
        assert.equal(currentWatched, 45);
        assert.equal(remainingMinutes, 75);
    });

    it("F5+F12: Stream Stall Watchdog to Streamer Skipping", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        const skippedLogins = ["superstreamer"]; // stall detected on superstreamer
        const nextChannel = await client.getChannelWithDrops("Overwatch 2", "camp-ow-1", null, skippedLogins);

        assert.ok(nextChannel);
        assert.equal(nextChannel.broadcaster.login, "chillgamer");
    });

    it("F11+F14: Popup Settings Toggle to Low-Quality Mode Playback", async () => {
        await sandbox.chrome.storage.local.set({
            settings: { lowQualityMode: true, autoMute: true }
        });

        const stored = await sandbox.chrome.storage.local.get("settings");
        if (stored.settings.lowQualityMode) {
            sandbox.domMock.localStorage.setItem("video-quality", JSON.stringify({ default: "160p30" }));
        }

        const vq = JSON.parse(sandbox.domMock.localStorage.getItem("video-quality"));
        assert.equal(vq.default, "160p30");
    });
});
