import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";

describe("Tier 2: Boundary - Feature 5: DirectoryPage_Game", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({ clientId: "test-client-id" });
    });

    it("F5-B1: getActiveStreams() handles non-existent / empty game name without error", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [{ data: { game: null } }]);
        const streams = await client.getActiveStreams("");
        assert.ok(Array.isArray(streams));
        assert.equal(streams.length, 0);
    });

    it("F5-B2: getActiveStreams() handles game with zero live streams (empty edges)", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [{
            data: {
                game: {
                    id: "12345",
                    streams: { edges: [] }
                }
            }
        }]);
        const streams = await client.getActiveStreams("Dead Game");
        assert.ok(Array.isArray(streams));
        assert.equal(streams.length, 0);
    });

    it("F5-B3: getActiveStreams() filters out corrupted stream edges missing broadcaster", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [{
            data: {
                game: {
                    id: "12345",
                    streams: {
                        edges: [
                            { node: null },
                            { node: { broadcaster: null } },
                            { node: { broadcaster: { login: "validstreamer", displayName: "ValidStreamer" } } }
                        ]
                    }
                }
            }
        }]);
        const streams = await client.getActiveStreams("Overwatch 2");
        assert.equal(streams.length, 1);
        assert.equal(streams[0].broadcaster.login, "validstreamer");
    });

    it("F5-B4: getChannelWithDrops() returns first available stream when all streamers were skipped", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [{
            data: {
                game: {
                    id: "12345",
                    streams: {
                        edges: [
                            { node: { broadcaster: { login: "streamerA", displayName: "StreamerA" } } }
                        ]
                    }
                }
            }
        }]);
        const channel = await client.getChannelWithDrops("Overwatch 2", "camp-1", null, ["streamerA"]);
        assert.ok(channel);
        assert.equal(channel.broadcaster.login, "streamerA");
    });

    it("F5-B5: getChannelWithDrops() returns null when no live streams exist at all", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [{
            data: {
                game: {
                    id: "12345",
                    streams: { edges: [] }
                }
            }
        }]);
        const channel = await client.getChannelWithDrops("Overwatch 2", "camp-1", null, []);
        assert.equal(channel, null);
    });
});
