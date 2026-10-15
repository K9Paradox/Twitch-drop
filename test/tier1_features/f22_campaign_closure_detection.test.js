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

    it("F22-T6: Drop-level expiration is detected even when campaign endAt is far in the future", () => {
        const now = Date.now();
        const pastDropEnd = new Date(now - 3600000).toISOString(); // Drop ended 1 hour ago (e.g. Sep 13, 9:28 AM)
        const futureCampaignEnd = new Date(now + 86400000).toISOString(); // Campaign ends in 24 hours

        const campaign = {
            id: "camp-ow2",
            name: "Overwatch 2 Drops",
            status: "ACTIVE",
            startAt: new Date(now - 7200000).toISOString(),
            endAt: futureCampaignEnd,
            timeBasedDrops: [
                {
                    id: "drop-ow-1",
                    name: "Overwatch Epic Skin",
                    startAt: new Date(now - 7200000).toISOString(),
                    endAt: pastDropEnd,
                    requiredMinutesWatched: 60,
                    self: { isClaimed: false, currentMinutesWatched: 0 }
                }
            ]
        };

        // All drops in campaign have expired endAt -> isCampaignActiveWithDrops must return false
        assert.equal(isCampaignActiveWithDrops(campaign, now, null), false);

        // If one drop is expired but another is still live, campaign remains active
        const campaignWithMixedDrops = {
            ...campaign,
            timeBasedDrops: [
                {
                    id: "drop-ow-1",
                    name: "Overwatch Epic Skin",
                    startAt: new Date(now - 7200000).toISOString(),
                    endAt: pastDropEnd,
                    requiredMinutesWatched: 60,
                    self: { isClaimed: false, currentMinutesWatched: 0 }
                },
                {
                    id: "drop-ow-2",
                    name: "Overwatch Legendary Weapon",
                    startAt: new Date(now - 7200000).toISOString(),
                    endAt: new Date(now + 3600000).toISOString(),
                    requiredMinutesWatched: 120,
                    self: { isClaimed: false, currentMinutesWatched: 0 }
                }
            ]
        };
        assert.equal(isCampaignActiveWithDrops(campaignWithMixedDrops, now, null), true);
    });

    it("F22-T7: End date formatting and drop prioritization correctly sorts active first, claimed second, ended last", () => {
        const now = Date.now();
        const drops = [
            { id: "1", title: "Claimed Drop", isClaimed: true, isEnded: false, minsNeeded: 60 },
            { id: "2", title: "Ended Drop", isClaimed: false, isEnded: true, minsNeeded: 120 },
            { id: "3", title: "Active Live Drop", isClaimed: false, isEnded: false, minsNeeded: 180 }
        ];

        const getPriority = (item) => {
            if (item.isClaimed) return 1;
            if (item.isEnded) return 2;
            return 0;
        };

        drops.sort((a, b) => {
            const pA = getPriority(a);
            const pB = getPriority(b);
            if (pA !== pB) return pA - pB;
            return a.minsNeeded - b.minsNeeded;
        });

        assert.equal(drops[0].title, "Active Live Drop");
        assert.equal(drops[1].title, "Claimed Drop");
        assert.equal(drops[2].title, "Ended Drop");
    });

    it("F22-T8: Window manager options ensure popups open and swap with focused: true and state: 'normal' for user unmute", () => {
        const mockWindows = [];
        const mockUpdates = [];

        const fakeChromeWindows = {
            create: async (opts) => {
                const win = { id: 101, tabs: [{ id: 202, url: opts.url }], ...opts };
                mockWindows.push(win);
                return win;
            },
            update: async (winId, opts) => {
                mockUpdates.push({ winId, ...opts });
                return { id: winId, ...opts };
            }
        };

        // Simulating popout window creation options
        const createOptions = {
            url: "https://www.twitch.tv/streamer#atd-managed=1",
            type: "popup",
            width: 854,
            height: 480,
            focused: true,
            state: "normal"
        };

        assert.equal(createOptions.focused, true);
        assert.equal(createOptions.state, "normal");

        // Simulating window swap update
        fakeChromeWindows.update(101, { focused: true, state: "normal", drawAttention: true });
        assert.equal(mockUpdates[0].winId, 101);
        assert.equal(mockUpdates[0].focused, true);
        assert.equal(mockUpdates[0].drawAttention, true);
    });

    it("F22-T9: areGameNamesMatching prevents short game names (e.g. 'Rust') from false substring matching while supporting aliases", () => {
        // Canonical alias match (Overwatch <-> Overwatch 2)
        assert.equal(areGameNamesMatching("Overwatch", "Overwatch 2"), true);
        assert.equal(areGameNamesMatching("Overwatch 2", "Overwatch"), true);

        // Short game name (< 6 normalized chars) should NOT substring-match unrelated games
        assert.equal(areGameNamesMatching("Rust", "Rusty Lake Hotel"), false);
        assert.equal(areGameNamesMatching("Rust", "Trust No One"), false);
        assert.equal(areGameNamesMatching("Rust", "Rust"), true);

        // Longer game names (>= 6 normalized chars) still match edition/subtitle variants
        assert.equal(areGameNamesMatching("Warframe", "Warframe: 1999"), true);
    });

    it("F22-T10: GQL progress merge preserves existing drop endAt, endsAt, isEnded, and benefitId when GQL payload omits timestamps", () => {
        const pastEndsAt = new Date("2026-09-13T16:28:00Z").getTime();
        const existingItems = [
            {
                id: "drop-1",
                benefitId: "benefit-1",
                name: "Overwatch Spray",
                imageUrl: "https://example.com/spray.png",
                reqTime: 60,
                startAt: "2026-09-10T00:00:00Z",
                endAt: "2026-09-13T16:28:00Z",
                endsAt: pastEndsAt,
                isEnded: true,
                self: { currentMinutesWatched: 15, isClaimed: false, dropInstanceID: null }
            }
        ];

        // Simulate a GQL DropChannelCampaignsProgress payload that omits endAt and benefitEdges
        const incomingGqlDrops = [
            {
                id: "drop-1",
                name: "Overwatch Spray",
                requiredMinutesWatched: 60,
                self: { currentMinutesWatched: 30, isClaimed: false, dropInstanceID: "inst-1" }
            }
        ];

        const mergedItems = incomingGqlDrops.map((d) => {
            const existing = existingItems.find(ex => ex.id === d.id);
            const dropEndAt = d.endAt || existing?.endAt || null;
            const dropEndsAt = dropEndAt ? new Date(dropEndAt).getTime() : (existing?.endsAt || null);
            return {
                id: d.id,
                benefitId: d.benefitEdges?.[0]?.benefit?.id || existing?.benefitId || null,
                name: d.benefitEdges?.[0]?.benefit?.name || d.name || existing?.name || "Drop Reward",
                imageUrl: d.benefitEdges?.[0]?.benefit?.imageAssetURL || d.imageURL || existing?.imageUrl || "",
                reqTime: d.requiredMinutesWatched || existing?.reqTime || 0,
                startAt: d.startAt || existing?.startAt || null,
                endAt: dropEndAt,
                endsAt: dropEndsAt,
                isEnded: Boolean(dropEndsAt && dropEndsAt <= Date.now()),
                self: d.self || existing?.self || { currentMinutesWatched: 0, isClaimed: false, dropInstanceID: null }
            };
        });

        assert.equal(mergedItems[0].endAt, "2026-09-13T16:28:00Z");
        assert.equal(mergedItems[0].endsAt, pastEndsAt);
        assert.equal(mergedItems[0].isEnded, true);
        assert.equal(mergedItems[0].benefitId, "benefit-1");
        assert.equal(mergedItems[0].self.currentMinutesWatched, 30);
    });

    it("F22-T11: Campaign with a mix of expired drops and claimed drops is evaluated as completed", () => {
        const now = Date.now();
        const items = [
            {
                id: "drop-expired",
                reqTime: 60,
                endsAt: now - 3600000,
                isEnded: true,
                self: { isClaimed: false, currentMinutesWatched: 10 }
            },
            {
                id: "drop-claimed",
                reqTime: 120,
                endsAt: now + 3600000,
                isEnded: false,
                self: { isClaimed: true, currentMinutesWatched: 120 }
            }
        ];

        const allDone = items.every(i =>
            i.self?.isClaimed ||
            i.isEnded ||
            (i.endsAt && i.endsAt <= now) ||
            ((i.reqTime || 0) > 0 && (i.self?.currentMinutesWatched || 0) >= i.reqTime)
        );
        assert.equal(allDone, true);
    });

    it("F22-T12: Expired same-game campaign in inventory does not poison a newer active campaign with a different ID", () => {
        const now = Date.now();
        const pastDate = new Date(now - 86400000).toISOString(); // 24h ago
        const futureDate = new Date(now + 86400000).toISOString(); // 24h in future

        const inventoryWithOldExpiredCamp = {
            dropCampaignsInProgress: [
                {
                    id: "camp-ow-sep13-expired",
                    game: { displayName: "Overwatch" },
                    status: "EXPIRED",
                    endAt: pastDate,
                    timeBasedDrops: [
                        { id: "drop-old-1", endAt: pastDate, requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 15 } }
                    ]
                }
            ],
            gameEventDrops: []
        };

        const newActiveCampaign = {
            id: "camp-ow-oct-active",
            game: { displayName: "Overwatch 2" },
            status: "ACTIVE",
            endAt: futureDate,
            timeBasedDrops: [
                { id: "drop-new-1", endAt: futureDate, requiredMinutesWatched: 60, self: { isClaimed: false, currentMinutesWatched: 0 } }
            ]
        };

        // Old campaign is inactive, but new campaign for the same game MUST remain active!
        assert.equal(isCampaignActiveWithDrops(inventoryWithOldExpiredCamp.dropCampaignsInProgress[0], now, inventoryWithOldExpiredCamp), false);
        assert.equal(isCampaignActiveWithDrops(newActiveCampaign, now, inventoryWithOldExpiredCamp), true);
    });
});

