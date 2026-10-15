import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client, isOverwatchGame, areGameNamesMatching, isCampaignActiveWithDrops, isCampaignFarmable } from "../../background/twitchApi.js";

describe("Tier 1: Feature 21 - Overwatch Rebranding & Alias Compatibility Verification", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F21-T1: areGameNamesMatching and isOverwatchGame recognize Overwatch and Overwatch 2 symmetrically", () => {
        // isOverwatchGame verification
        assert.equal(isOverwatchGame("Overwatch"), true);
        assert.equal(isOverwatchGame("Overwatch 2"), true);
        assert.equal(isOverwatchGame("overwatch-2"), true);
        assert.equal(isOverwatchGame("OVERWATCH"), true);
        assert.equal(isOverwatchGame("Overwatch 2: Invasion"), false);
        assert.equal(isOverwatchGame("Apex Legends"), false);
        assert.equal(isOverwatchGame(null), false);

        // areGameNamesMatching symmetry
        assert.equal(areGameNamesMatching("Overwatch", "Overwatch 2"), true);
        assert.equal(areGameNamesMatching("Overwatch 2", "Overwatch"), true);
        assert.equal(areGameNamesMatching("overwatch", "OVERWATCH 2"), true);
        assert.equal(areGameNamesMatching("Overwatch", "Overwatch"), true);
        assert.equal(areGameNamesMatching("overwatch-2", "Overwatch"), true);

        // Negative cases
        assert.equal(areGameNamesMatching("Overwatch", "Valorant"), false);
        assert.equal(areGameNamesMatching("Overwatch 2", "Apex Legends"), false);
        assert.equal(areGameNamesMatching(null, "Overwatch"), false);
    });

    it("F21-T2: getActiveStreams() falls back to alternate directory slug when initial query yields 0 streams for Overwatch", async () => {
        let queriedSlugs = [];

        sandbox.fetchMock.onGql("DirectoryPage_Game", (url, opts, body) => {
            const slug = body?.variables?.slug;
            queriedSlugs.push(slug);

            if (slug === "overwatch-2") {
                // Blizzard rebranded directory: old slug returns 0 streams
                return new Response(JSON.stringify({
                    data: {
                        game: {
                            id: "515025",
                            displayName: "Overwatch 2",
                            streams: { edges: [] }
                        }
                    }
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            } else if (slug === "overwatch") {
                // New rebranded directory: returns active streams with drops
                return new Response(JSON.stringify({
                    data: {
                        game: {
                            id: "488552",
                            displayName: "Overwatch",
                            streams: {
                                edges: [
                                    {
                                        node: {
                                            id: "stream-ow-1",
                                            broadcaster: {
                                                id: "broadcaster-ow-1",
                                                login: "ml7support",
                                                displayName: "ML7support"
                                            },
                                            freeformTags: [{ name: "DropsEnabled" }]
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ data: { game: null } }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        const streams = await client.getActiveStreams("Overwatch 2", "overwatch-2");

        // Verify fallback was invoked and streams returned
        assert.deepEqual(queriedSlugs, ["overwatch-2", "overwatch"]);
        assert.equal(streams.length, 1);
        assert.equal(streams[0].broadcaster.login, "ml7support");
    });

    it("F21-T3: isCampaignActiveWithDrops() matches campaign when inventory uses counterpart Overwatch name", () => {
        const campaign = {
            id: "camp-ow-123",
            status: "ACTIVE",
            startAt: new Date(Date.now() - 3600000).toISOString(),
            endAt: new Date(Date.now() + 3600000).toISOString(),
            game: {
                displayName: "Overwatch",
                name: "Overwatch"
            },
            timeBasedDrops: [
                {
                    id: "drop-1",
                    requiredMinutesWatched: 120,
                    self: { isClaimed: false, currentMinutesWatched: 45 }
                }
            ]
        };

        // Inventory lists the game under "Overwatch 2"
        const inventory = {
            dropCampaignsInProgress: [
                {
                    id: "other-camp-id",
                    game: {
                        displayName: "Overwatch 2",
                        name: "Overwatch 2"
                    },
                    timeBasedDrops: [
                        {
                            id: "drop-1",
                            requiredMinutesWatched: 120,
                            self: { isClaimed: false, currentMinutesWatched: 45 }
                        }
                    ]
                }
            ],
            gameEventDrops: []
        };

        const isActive = isCampaignActiveWithDrops(campaign, Date.now(), inventory);
        assert.equal(isActive, true);
    });

    it("F21-T4: getGameIdFromName() falls back between Overwatch and Overwatch 2 on null result", async () => {
        sandbox.fetchMock.onGql("SearchFor", (url, opts, body) => {
            const query = body?.variables?.query;
            if (query === "overwatch") {
                return new Response(JSON.stringify({
                    data: {
                        games: {
                            edges: []
                        }
                    }
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            } else if (query === "overwatch 2") {
                return new Response(JSON.stringify({
                    data: {
                        games: {
                            edges: [
                                {
                                    node: {
                                        id: "515025",
                                        name: "Overwatch 2",
                                        displayName: "Overwatch 2"
                                    }
                                }
                            ]
                        }
                    }
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ data: { games: { edges: [] } } }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        const gameId = await client.getGameIdFromName("Overwatch");
        assert.equal(gameId, "515025");
    });

    it("F21-T5: Watchdog category verification accurately prevents channel rotation between Overwatch aliases", () => {
        const metaGameA = "Overwatch";
        const targetGameA = "Overwatch 2";
        const gameChangedA = !areGameNamesMatching(metaGameA, targetGameA);
        assert.equal(gameChangedA, false, "Overwatch vs Overwatch 2 must not trigger gameChanged");

        const metaGameB = "Overwatch 2";
        const targetGameB = "Overwatch";
        const gameChangedB = !areGameNamesMatching(metaGameB, targetGameB);
        assert.equal(gameChangedB, false, "Overwatch 2 vs Overwatch must not trigger gameChanged");

        const metaGameC = "Valorant";
        const targetGameC = "Overwatch";
        const gameChangedC = !areGameNamesMatching(metaGameC, targetGameC);
        assert.equal(gameChangedC, true, "Valorant vs Overwatch must trigger gameChanged");
    });

    it("F21-T6: isCampaignFarmable distinguishes between ended OWCS Kickoff and active Reign of Talon campaign", () => {
        const nowTs = new Date("2026-10-14T20:00:00Z").getTime();

        const owcsCampaign = {
            id: "owcs-stage3-asia",
            name: "OWCS Stage 3 Asia Kickoff",
            status: "ACTIVE",
            startAt: "2026-10-10T00:00:00Z",
            endAt: "2026-10-13T12:00:00Z",
            endsAt: new Date("2026-10-13T12:00:00Z").getTime(),
            streamers: ["ow_esports", "ow_esports_jp"],
            items: [
                {
                    id: "drop-owcs-1",
                    name: "OWCS Spray",
                    endAt: "2026-10-13T12:00:00Z",
                    endsAt: new Date("2026-10-13T12:00:00Z").getTime(),
                    isEnded: true,
                    reqTime: 120,
                    self: { isClaimed: false, currentMinutesWatched: 0 }
                }
            ]
        };

        const reignOfTalonCampaign = {
            id: "reign-of-talon-s5",
            name: "Reign of Talon S5 Launch",
            status: "ACTIVE",
            startAt: "2026-10-10T00:00:00Z",
            endAt: "2026-11-02T08:00:00Z",
            endsAt: new Date("2026-11-02T08:00:00Z").getTime(),
            streamers: [],
            items: [
                {
                    id: "drop-rot-1",
                    name: "Reign of Talon Name Card",
                    endAt: "2026-11-02T08:00:00Z",
                    endsAt: new Date("2026-11-02T08:00:00Z").getTime(),
                    isEnded: false,
                    reqTime: 120,
                    self: { isClaimed: false, currentMinutesWatched: 15 }
                },
                {
                    id: "drop-rot-2",
                    name: "Reign of Talon Skin",
                    endAt: "2026-11-02T08:00:00Z",
                    endsAt: new Date("2026-11-02T08:00:00Z").getTime(),
                    isEnded: false,
                    reqTime: 240,
                    self: { isClaimed: false, currentMinutesWatched: 0 }
                }
            ]
        };

        assert.equal(isCampaignFarmable(owcsCampaign, nowTs), false, "OWCS campaign with past end date must not be farmable");
        assert.equal(isCampaignFarmable(reignOfTalonCampaign, nowTs), true, "Reign of Talon with active unended drops must be farmable");

        // When all drops are claimed
        const fullyClaimedRot = {
            ...reignOfTalonCampaign,
            items: reignOfTalonCampaign.items.map(i => ({
                ...i,
                self: { isClaimed: true, currentMinutesWatched: i.reqTime }
            }))
        };
        assert.equal(isCampaignFarmable(fullyClaimedRot, nowTs), false, "Reign of Talon with all drops claimed must not be farmable");
    });

    it("F21-T7: Multi-campaign sorting prioritizes farmable, open-streamer Reign of Talon over ended OWCS", () => {
        const nowTs = new Date("2026-10-14T20:00:00Z").getTime();

        const owcsCampaign = {
            id: "owcs-stage3-asia",
            name: "OWCS Stage 3 Asia Kickoff",
            endsAt: new Date("2026-10-13T12:00:00Z").getTime(),
            streamers: ["ow_esports", "ow_esports_jp"],
            items: [
                {
                    id: "drop-owcs-1",
                    endsAt: new Date("2026-10-13T12:00:00Z").getTime(),
                    isEnded: true,
                    self: { isClaimed: false, currentMinutesWatched: 0 }
                }
            ]
        };

        const reignOfTalonCampaign = {
            id: "reign-of-talon-s5",
            name: "Reign of Talon S5 Launch",
            endsAt: new Date("2026-11-02T08:00:00Z").getTime(),
            streamers: [],
            items: [
                {
                    id: "drop-rot-1",
                    endsAt: new Date("2026-11-02T08:00:00Z").getTime(),
                    isEnded: false,
                    reqTime: 120,
                    self: { isClaimed: false, currentMinutesWatched: 0 }
                }
            ]
        };

        // Inventory returned campaigns with OWCS first
        const campaigns = [owcsCampaign, reignOfTalonCampaign];

        campaigns.sort((a, b) => {
            const aFarmable = isCampaignFarmable(a, nowTs);
            const bFarmable = isCampaignFarmable(b, nowTs);
            if (aFarmable !== bFarmable) return aFarmable ? -1 : 1;
            const aOpen = (!a.streamers || a.streamers.length === 0);
            const bOpen = (!b.streamers || b.streamers.length === 0);
            if (aOpen !== bOpen) return aOpen ? -1 : 1;
            const aEnd = a.endsAt || Infinity;
            const bEnd = b.endsAt || Infinity;
            return aEnd - bEnd;
        });

        assert.equal(campaigns[0].id, "reign-of-talon-s5", "Farmable Reign of Talon must sort ahead of ended OWCS");
        assert.equal(campaigns[1].id, "owcs-stage3-asia", "Ended OWCS must sort behind farmable campaign");

        const firstFarmableIdx = campaigns.findIndex(c => isCampaignFarmable(c, nowTs));
        assert.equal(firstFarmableIdx, 0, "firstFarmableIdx should point to Reign of Talon at index 0");
    });

    it("F21-T8: Sibling campaign failover selects open Overwatch streamer when restricted streamers are offline", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", (url, opts, body) => {
            return new Response(JSON.stringify({
                data: {
                    game: {
                        id: "515025",
                        displayName: "Overwatch 2",
                        streams: {
                            edges: [
                                {
                                    node: {
                                        id: "stream-super-1",
                                        broadcaster: {
                                            id: "broadcaster-super",
                                            login: "supertf",
                                            displayName: "supertf"
                                        },
                                        freeformTags: [{ name: "DropsEnabled" }]
                                    }
                                }
                            ]
                        }
                    }
                }
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        // Querying restricted streamers via ChannelShell returns stream: null (offline)
        sandbox.fetchMock.onGql("ChannelShell", (url, opts, body) => {
            const login = body?.variables?.login;
            if (login === "ow_esports" || login === "ow_esports_jp") {
                return new Response(JSON.stringify({
                    data: { userOrError: { stream: null } }
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({
                data: { userOrError: { stream: { id: "live-stream" } } }
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        });

        const owcsStreamer = await client.getLiveBroadcasterForCampaign(
            "Overwatch",
            "owcs-stage3-asia",
            "overwatch",
            ["ow_esports", "ow_esports_jp"],
            []
        );
        assert.equal(owcsStreamer, null, "Restricted channels are offline");

        // Failover to open sibling campaign with streamers: []
        const rotStreamer = await client.getLiveBroadcasterForCampaign(
            "Overwatch",
            "reign-of-talon-s5",
            "overwatch",
            [],
            []
        );
        assert.equal(rotStreamer, "supertf", "Open sibling campaign must successfully failover to live drops streamer");
    });

    it("F21-T9: Multi-campaign state verifies all drops are aggregated and active campaign advances", () => {
        const nowTs = new Date("2026-10-14T20:00:00Z").getTime();
        const activeStream = {
            campaign: {
                game: { name: "Overwatch" },
                onCamp: 0,
                curWatching: "supertf",
                status: "watching",
                endsAt: new Date("2026-10-13T12:00:00Z").getTime()
            },
            campaigns: [
                {
                    id: "owcs-stage3-asia",
                    name: "OWCS Stage 3 Asia Kickoff",
                    endsAt: new Date("2026-10-13T12:00:00Z").getTime(),
                    streamers: ["ow_esports"],
                    items: [
                        { id: "owcs-1", reqTime: 120, endsAt: new Date("2026-10-13T12:00:00Z").getTime(), self: { isClaimed: false, currentMinutesWatched: 0 } }
                    ]
                },
                {
                    id: "reign-of-talon-s5",
                    name: "Reign of Talon S5 Launch",
                    endsAt: new Date("2026-11-02T08:00:00Z").getTime(),
                    streamers: [],
                    items: [
                        { id: "rot-1", reqTime: 120, endsAt: new Date("2026-11-02T08:00:00Z").getTime(), self: { isClaimed: false, currentMinutesWatched: 30 } },
                        { id: "rot-2", reqTime: 240, endsAt: new Date("2026-11-02T08:00:00Z").getTime(), self: { isClaimed: false, currentMinutesWatched: 0 } }
                    ]
                }
            ]
        };

        // Advance onCamp if onCamp points to an ended campaign
        const currentCamp = activeStream.campaigns[activeStream.campaign.onCamp];
        if (!isCampaignFarmable(currentCamp, nowTs)) {
            const nextIdx = activeStream.campaigns.findIndex(c => isCampaignFarmable(c, nowTs));
            if (nextIdx !== -1) {
                activeStream.campaign.onCamp = nextIdx;
                activeStream.campaign.endsAt = activeStream.campaigns[nextIdx].endsAt;
            }
        }

        assert.equal(activeStream.campaign.onCamp, 1, "onCamp should advance to Reign of Talon");
        assert.equal(activeStream.campaign.endsAt, new Date("2026-11-02T08:00:00Z").getTime(), "endsAt should reflect Reign of Talon end date");
        assert.equal(isCampaignFarmable(activeStream.campaigns[activeStream.campaign.onCamp], nowTs), true);
    });
});
