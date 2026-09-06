import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";

describe("Tier 1: Feature 17 - Queue & Stream Compatibility Verification", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F17-T1: getLiveBroadcasterForCampaign() returns live broadcaster when restricted streamer is live", async () => {
        sandbox.fetchMock.onGql("ChannelShell", {
            data: {
                userOrError: {
                    __typename: "User",
                    id: "197564016",
                    stream: {
                        id: "stream-999",
                        type: "live",
                        game: {
                            displayName: "Overwatch 2"
                        }
                    }
                }
            }
        });

        const liveStreamer = await client.getLiveBroadcasterForCampaign(
            "Overwatch 2",
            "camp-123",
            "overwatch-2",
            ["overwatchleague"]
        );

        assert.equal(liveStreamer, "overwatchleague");
    });

    it("F17-T2: getLiveBroadcasterForCampaign() returns null when all restricted streamers are offline", async () => {
        sandbox.fetchMock.onGql("ChannelShell", {
            data: {
                userOrError: {
                    __typename: "User",
                    id: "197564016",
                    stream: null
                }
            }
        });

        const liveStreamer = await client.getLiveBroadcasterForCampaign(
            "Overwatch 2",
            "camp-123",
            "overwatch-2",
            ["overwatchleague"]
        );

        // Crucial behavior: offline channel must NOT be returned!
        assert.equal(liveStreamer, null);
    });

    it("F17-T3: getLiveBroadcasterForCampaign() falls back to live stream with drops when no specific streamers are restricted", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", {
            data: {
                game: {
                    id: "515025",
                    displayName: "Overwatch 2",
                    streams: {
                        edges: [
                            {
                                node: {
                                    id: "stream-001",
                                    broadcaster: {
                                        id: "broadcaster-1",
                                        login: "superstreamer",
                                        displayName: "SuperStreamer"
                                    },
                                    freeformTags: [{ name: "DropsEnabled" }]
                                }
                            }
                        ]
                    }
                }
            }
        });

        const liveStreamer = await client.getLiveBroadcasterForCampaign(
            "Overwatch 2",
            "camp-123",
            "overwatch-2",
            []
        );

        assert.equal(liveStreamer, "superstreamer");
    });

    it("F17-T4: getLiveBroadcasterForCampaign() skips broadcasters in skippedLogins list", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", {
            data: {
                game: {
                    id: "515025",
                    displayName: "Overwatch 2",
                    streams: {
                        edges: [
                            {
                                node: {
                                    id: "stream-001",
                                    broadcaster: {
                                        id: "broadcaster-1",
                                        login: "stalledstreamer",
                                        displayName: "StalledStreamer"
                                    },
                                    freeformTags: [{ name: "DropsEnabled" }]
                                }
                            },
                            {
                                node: {
                                    id: "stream-002",
                                    broadcaster: {
                                        id: "broadcaster-2",
                                        login: "workingstreamer",
                                        displayName: "WorkingStreamer"
                                    },
                                    freeformTags: [{ name: "DropsEnabled" }]
                                }
                            }
                        ]
                    }
                }
            }
        });

        const liveStreamer = await client.getLiveBroadcasterForCampaign(
            "Overwatch 2",
            "camp-123",
            "overwatch-2",
            [],
            ["stalledstreamer"]
        );

        assert.equal(liveStreamer, "workingstreamer");
    });

    it("F17-T5: getDropCampaigns filtering isolates ACTIVE campaigns from EXPIRED/UPCOMING ones", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", {
            data: {
                currentUser: {
                    dropCampaigns: [
                        {
                            id: "camp-active-1",
                            name: "Overwatch Flash Ops",
                            status: "ACTIVE",
                            game: { id: "515025", displayName: "Overwatch 2", name: "Overwatch 2" }
                        },
                        {
                            id: "camp-expired-2",
                            name: "Rust Round 20",
                            status: "EXPIRED",
                            game: { id: "263490", displayName: "Rust", name: "Rust" }
                        },
                        {
                            id: "camp-upcoming-3",
                            name: "Valorant Masters",
                            status: "UPCOMING",
                            game: { id: "516575", displayName: "Valorant", name: "Valorant" }
                        }
                    ]
                }
            }
        });

        const campaigns = await client.getDropCampaigns();
        const activeOnlyGames = Array.from(new Set(
            campaigns.filter(c => c && c.status === "ACTIVE" && c.game)
                .map(c => c.game.displayName || c.game.name)
        )).sort((a, b) => a.localeCompare(b));

        assert.deepEqual(activeOnlyGames, ["Overwatch 2"]);
    });
});
