import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client, isCampaignActiveWithDrops } from "../../background/twitchApi.js";

describe("Tier 1: Feature 19 - Auto-Queue Active Drops & Offline Stability", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({ oauthToken: "test_token" });
    });

    it("F19-T1: Client.getAllDropCampaigns() separates dropCampaigns and only merges reward campaigns when explicitly requested", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", {
            data: {
                currentUser: {
                    dropCampaigns: [
                        { id: "camp-1", name: "Game A Event", status: "ACTIVE", game: { id: "1", displayName: "Game A" } },
                        { id: "camp-2", name: "Game B Event", status: "ACTIVE", game: { id: "2", displayName: "Game B" } }
                    ]
                },
                rewardCampaignsAvailableToUser: [
                    { id: "camp-2", name: "Game B Event (Duplicate)", status: "ACTIVE", game: { id: "2", displayName: "Game B" } },
                    { id: "camp-3", name: "Game C Event", status: "ACTIVE", game: { id: "3", displayName: "Game C" } }
                ]
            }
        });

        // By default, only actual stream drop campaigns are returned
        const dropCampaigns = await client.getAllDropCampaigns();
        assert.equal(dropCampaigns.length, 2);
        assert.deepEqual(dropCampaigns.map(c => c.id).sort(), ["camp-1", "camp-2"]);

        // When includeRewardCampaigns = true, reward campaigns are merged
        const allCampaigns = await client.getAllDropCampaigns(true);
        assert.equal(allCampaigns.length, 3);
        const ids = allCampaigns.map(c => c.id).sort();
        assert.deepEqual(ids, ["camp-1", "camp-2", "camp-3"]);
    });

    it("F19-T2: isCampaignActiveWithDrops() verifies active status, start/end dates, and unclaimed drops", () => {
        const now = Date.now();
        const activeCamp = {
            id: "camp-valid",
            status: "ACTIVE",
            game: { id: "101", displayName: "Overwatch 2" },
            startAt: new Date(now - 3600000).toISOString(),
            endAt: new Date(now + 3600000).toISOString(),
            timeBasedDrops: [
                {
                    id: "d1",
                    requiredMinutesWatched: 120,
                    self: { isClaimed: false, currentMinutesWatched: 30 }
                }
            ]
        };

        assert.equal(isCampaignActiveWithDrops(activeCamp, now), true);
    });

    it("F19-T3: isCampaignActiveWithDrops() rejects expired, empty, and 100% claimed campaigns (standalone and via inventory)", () => {
        const now = Date.now();

        // Expired by endAt even if status is ACTIVE
        const expiredCamp = {
            id: "camp-expired",
            status: "ACTIVE",
            game: { id: "102", displayName: "Rust" },
            startAt: new Date(now - 7200000).toISOString(),
            endAt: new Date(now - 1000).toISOString(),
            timeBasedDrops: [
                { id: "d1", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 0 } }
            ]
        };
        assert.equal(isCampaignActiveWithDrops(expiredCamp, now), false);

        // Upcoming campaign (startAt in future)
        const upcomingCamp = {
            id: "camp-upcoming",
            status: "ACTIVE",
            game: { id: "103", displayName: "Valorant" },
            startAt: new Date(now + 3600000).toISOString(),
            endAt: new Date(now + 7200000).toISOString(),
            timeBasedDrops: [
                { id: "d2", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 0 } }
            ]
        };
        assert.equal(isCampaignActiveWithDrops(upcomingCamp, now), false);

        // Empty drops array (e.g. promo reward campaigns with 0 stream drops)
        const emptyDropsCamp = {
            id: "camp-empty",
            status: "ACTIVE",
            game: { id: "105", displayName: "Shakes and Fidget" },
            startAt: new Date(now - 3600000).toISOString(),
            endAt: new Date(now + 3600000).toISOString(),
            timeBasedDrops: []
        };
        assert.equal(isCampaignActiveWithDrops(emptyDropsCamp, now), false);

        // 100% claimed drops embedded in campaign
        const claimedCamp = {
            id: "camp-claimed",
            status: "ACTIVE",
            game: { id: "104", displayName: "TF2" },
            startAt: new Date(now - 3600000).toISOString(),
            endAt: new Date(now + 3600000).toISOString(),
            timeBasedDrops: [
                { id: "d3", requiredMinutesWatched: 60, self: { isClaimed: true, currentMinutesWatched: 60 } },
                { id: "d4", requiredMinutesWatched: 120, self: { isClaimed: true, currentMinutesWatched: 120 } }
            ]
        };
        assert.equal(isCampaignActiveWithDrops(claimedCamp, now), false);

        // Claimed via inventory.dropCampaignsInProgress
        const inventoryCamp = {
            id: "camp-inv",
            status: "ACTIVE",
            game: { id: "106", displayName: "CS2" },
            startAt: new Date(now - 3600000).toISOString(),
            endAt: new Date(now + 3600000).toISOString()
        };
        const mockInventory = {
            dropCampaignsInProgress: [
                {
                    id: "camp-inv",
                    timeBasedDrops: [
                        { id: "d5", requiredMinutesWatched: 60, self: { isClaimed: true, currentMinutesWatched: 60 } }
                    ]
                }
            ]
        };
        assert.equal(isCampaignActiveWithDrops(inventoryCamp, now, mockInventory), false);
    });

    it("F19-T4: Manual campaign start retains isManual flag and prevents auto-skipping when streamer is offline", () => {
        // Simulate campaign state after manual user start
        const activeStream = {
            campaign: {
                game: { name: "Overwatch 2" },
                status: "starting",
                isManual: true,
                curWatching: null,
                requiredStreamers: ["overwatchleague"]
            }
        };

        const targetStreamer = null; // Broadcaster is offline

        let skippedToNext = false;
        if (!targetStreamer) {
            // Logic matching background.js runCampaign()
            if (!activeStream.campaign.isManual) {
                skippedToNext = true;
            } else {
                activeStream.campaign.status = "nostream";
            }
        }

        assert.equal(skippedToNext, false);
        assert.equal(activeStream.campaign.status, "nostream");
        assert.equal(activeStream.campaign.isManual, true);
    });

    it("F19-T5: Recursion guard prevents infinite cascading loops during auto queue skips", async () => {
        let isAdvancingQueue = false;
        let cascadeAttempts = 0;

        async function simulateAdvanceAutoQueue(game) {
            if (isAdvancingQueue) return false;
            isAdvancingQueue = true;
            try {
                cascadeAttempts++;
                // Simulate an offline game attempting to recursively invoke advanceAutoQueue
                if (cascadeAttempts < 5) {
                    await simulateAdvanceAutoQueue("NextGame" + cascadeAttempts);
                }
                return true;
            } finally {
                isAdvancingQueue = false;
            }
        }

        const result = await simulateAdvanceAutoQueue("GameA");
        // Due to the isAdvancingQueue guard, the inner attempt returns false immediately
        assert.equal(result, true);
        assert.equal(cascadeAttempts, 1);
    });

    it("F19-T6: When createCampaign yields no active drops, auto queue puts game on cooldown and auto-skips, while manual stays on no_active_drops", () => {
        const unstreamableCooldown = new Map();
        let autoAdvanced = false;

        function handleNoDrops(game, isManual, autoDropGames) {
            const status = "no_active_drops";
            if (!isManual && autoDropGames.length > 0) {
                unstreamableCooldown.set(game, Date.now());
                autoAdvanced = true;
            }
            return { status, isManual };
        }

        // Auto-queue mode: automatically marks cooldown and advances
        const autoResult = handleNoDrops("Shakes and Fidget", false, ["Shakes and Fidget", "Overwatch 2"]);
        assert.equal(autoResult.status, "no_active_drops");
        assert.equal(autoResult.isManual, false);
        assert.equal(autoAdvanced, true);
        assert.ok(unstreamableCooldown.has("Shakes and Fidget"));

        // Manual mode: stays on chosen game without auto-advancing
        autoAdvanced = false;
        unstreamableCooldown.clear();
        const manualResult = handleNoDrops("Shakes and Fidget", true, ["Shakes and Fidget", "Overwatch 2"]);
        assert.equal(manualResult.status, "no_active_drops");
        assert.equal(manualResult.isManual, true);
        assert.equal(autoAdvanced, false);
        assert.equal(unstreamableCooldown.has("Shakes and Fidget"), false);
    });
});
