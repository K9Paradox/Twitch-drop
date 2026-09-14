import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client, isOverwatchGame, areGameNamesMatching, isCampaignActiveWithDrops } from "../../background/twitchApi.js";

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
});
