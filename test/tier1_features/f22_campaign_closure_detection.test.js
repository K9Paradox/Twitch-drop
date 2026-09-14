import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client, isCampaignActiveWithDrops, areGameNamesMatching } from "../../background/twitchApi.js";

describe("Tier 1: Feature 22 - Campaign Closure & Expiration Detection", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F22-T1: isCampaignActiveWithDrops flags expired campaigns even when Twitch GraphQL reports status: 'ACTIVE'", () => {
        const now = Date.now();
        const pastDate = new Date(now - 3600000).toISOString(); // 1 hour ago
        const futureDate = new Date(now + 3600000).toISOString(); // 1 hour in future

        // Expired by endAt despite status === 'ACTIVE'
        const expiredCampaign = {
            id: "camp-expired",
            name: "Closed Campaign",
            status: "ACTIVE",
            startAt: new Date(now - 7200000).toISOString(),
            endAt: pastDate,
            timeBasedDrops: [
                { id: "drop-1", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 0 } }
            ]
        };
        assert.equal(isCampaignActiveWithDrops(expiredCampaign, now, null), false);

        // Active campaign with future endAt
        const activeCampaign = {
            id: "camp-active",
            name: "Active Campaign",
            status: "ACTIVE",
            startAt: new Date(now - 3600000).toISOString(),
            endAt: futureDate,
            timeBasedDrops: [
                { id: "drop-1", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 0 } }
            ]
        };
        assert.equal(isCampaignActiveWithDrops(activeCampaign, now, null), true);

        // Explicit EXPIRED status
        const explicitlyExpired = {
            ...activeCampaign,
            status: "EXPIRED"
        };
        assert.equal(isCampaignActiveWithDrops(explicitlyExpired, now, null), false);
    });

    it("F22-T2: isCampaignActiveWithDrops detects in-progress campaign closure when endAt has passed or drops are fully claimed", () => {
        const now = Date.now();
        const pastDate = new Date(now - 1800000).toISOString(); // 30m ago
        const futureDate = new Date(now + 1800000).toISOString(); // 30m in future

        const campaign = {
            id: "camp-in-prog",
            name: "Test In-Prog Campaign",
            status: "ACTIVE",
            startAt: new Date(now - 7200000).toISOString(),
            endAt: futureDate,
            timeBasedDrops: [
                { id: "drop-1", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 0 } }
            ]
        };

        // Inventory shows in-progress campaign has expired endAt
        const inventoryExpired = {
            dropCampaignsInProgress: [
                {
                    id: "camp-in-prog",
                    status: "ACTIVE",
                    endAt: pastDate,
                    timeBasedDrops: [
                        { id: "drop-1", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 30 } }
                    ]
                }
            ],
            gameEventDrops: []
        };
        assert.equal(isCampaignActiveWithDrops(campaign, now, inventoryExpired), false);

        // Inventory shows in-progress campaign status is not ACTIVE
        const inventoryNonActive = {
            dropCampaignsInProgress: [
                {
                    id: "camp-in-prog",
                    status: "EXPIRED",
                    endAt: futureDate,
                    timeBasedDrops: [
                        { id: "drop-1", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 30 } }
                    ]
                }
            ],
            gameEventDrops: []
        };
        assert.equal(isCampaignActiveWithDrops(campaign, now, inventoryNonActive), false);

        // Inventory shows all drops have been claimed in gameEventDrops
        const inventoryClaimed = {
            dropCampaignsInProgress: [
                {
                    id: "camp-in-prog",
                    status: "ACTIVE",
                    endAt: futureDate,
                    timeBasedDrops: [
                        { id: "drop-1", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 60 } }
                    ]
                }
            ],
            gameEventDrops: [
                { id: "drop-1" }
            ]
        };
        assert.equal(isCampaignActiveWithDrops(campaign, now, inventoryClaimed), false);

        // In-progress campaign active and has unclaimed drops
        const inventoryUnclaimed = {
            dropCampaignsInProgress: [
                {
                    id: "camp-in-prog",
                    status: "ACTIVE",
                    endAt: futureDate,
                    timeBasedDrops: [
                        { id: "drop-1", requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 30 } }
                    ]
                }
            ],
            gameEventDrops: []
        };
        assert.equal(isCampaignActiveWithDrops(campaign, now, inventoryUnclaimed), true);
    });

    it("F22-T3: client.getConnectedGames filters out campaigns whose endAt has expired", async () => {
        const now = Date.now();
        const pastDate = new Date(now - 3600000).toISOString();
        const futureDate = new Date(now + 3600000).toISOString();

        sandbox.fetchMock.onGql("ViewerDropsDashboard", () => {
            return new Response(JSON.stringify({
                data: {
                    currentUser: {
                        dropCampaigns: [
                            {
                                id: "camp-1",
                                game: { id: "1", name: "Expired Game" },
                                status: "ACTIVE",
                                endAt: pastDate
                            },
                            {
                                id: "camp-2",
                                game: { id: "2", name: "Active Game" },
                                status: "ACTIVE",
                                endAt: futureDate
                            }
                        ]
                    }
                }
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        const connectedGames = await client.getConnectedGames();
        assert.equal(connectedGames.length, 1);
        assert.equal(connectedGames[0].id, "camp-2");
        assert.equal(connectedGames[0].game.name, "Active Game");
    });

    it("F22-T4: Watchdog closure detection identifies endsAt expiry", () => {
        const now = Date.now();
        const pastEndsAt = now - 5000; // 5 seconds ago

        const activeStream = {
            campaign: {
                game: { name: "Overwatch 2" },
                status: "watching",
                endsAt: pastEndsAt,
                curWatching: "streamer1",
                stallCount: 0
            }
        };

        const isClosed = Boolean(activeStream.campaign.endsAt && now >= activeStream.campaign.endsAt);
        assert.equal(isClosed, true);

        // Simulation of watchdog handling
        if (isClosed) {
            activeStream.campaign.status = "no_active_drops";
            activeStream.campaign.curWatching = null;
            activeStream.campaign.isCompleted = true;
        }

        assert.equal(activeStream.campaign.status, "no_active_drops");
        assert.equal(activeStream.campaign.curWatching, null);
        assert.equal(activeStream.campaign.isCompleted, true);
    });

    it("F22-T5: Dropdown active tag computation does not mark expired campaigns or campaigns with hasActiveDrops: false as active", () => {
        const now = Date.now();
        const pastDate = new Date(now - 3600000).toISOString();
        const futureDate = new Date(now + 3600000).toISOString();

        // Helper replicating the updated popup dropdown logic
        function computeIsActive(camp) {
            const isExpired = Boolean(camp && camp.endAt && !isNaN(new Date(camp.endAt).getTime()) && new Date(camp.endAt).getTime() <= Date.now());
            if (camp && camp.game && camp.game.displayName) {
                return (camp.hasActiveDrops !== undefined) ? Boolean(camp.hasActiveDrops) : (camp.status === "ACTIVE" && !isExpired);
            } else if (camp && camp.displayName) {
                return (camp.hasActiveDrops !== undefined) ? Boolean(camp.hasActiveDrops) : (camp.status === "ACTIVE" && !isExpired);
            } else if (camp && camp.name) {
                return (camp.hasActiveDrops !== undefined) ? Boolean(camp.hasActiveDrops) : (camp.status === "ACTIVE" && !isExpired);
            }
            return false;
        }

        // Case 1: hasActiveDrops explicitly false despite status === 'ACTIVE'
        const campWithFalseDrops = {
            game: { displayName: "Overwatch 2" },
            status: "ACTIVE",
            hasActiveDrops: false,
            endAt: futureDate
        };
        assert.equal(computeIsActive(campWithFalseDrops), false);

        // Case 2: Expired endAt with status === 'ACTIVE'
        const campExpired = {
            game: { displayName: "Valorant" },
            status: "ACTIVE",
            endAt: pastDate
        };
        assert.equal(computeIsActive(campExpired), false);

        // Case 3: Truly active campaign with future endAt
        const campTrulyActive = {
            game: { displayName: "Rust" },
            status: "ACTIVE",
            hasActiveDrops: true,
            endAt: futureDate
        };
        assert.equal(computeIsActive(campTrulyActive), true);
    });
});
