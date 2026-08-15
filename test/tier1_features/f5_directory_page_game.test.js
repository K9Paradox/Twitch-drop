import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { directoryPageGameFixture } from "../fixtures/graphql-fixtures.js";

describe("Tier 1: Feature 5 - GraphQL DirectoryPage_Game", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({ clientId: "test-client-id" });
    });

    it("F5-T1: getActiveStreams() automatically formats slug from gameName when slug is omitted", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        const streams = await client.getActiveStreams("Overwatch 2");

        assert.equal(sandbox.fetchMock.history.length, 1);
        const req = sandbox.fetchMock.history[0];
        const body = Array.isArray(req.body) ? req.body[0] : req.body;
        assert.equal(body.variables.slug, "overwatch-2");
        assert.ok(Array.isArray(streams));
        assert.equal(streams.length, 3);
    });

    it("F5-T2: getActiveStreams() uses explicit custom slug when provided", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        await client.getActiveStreams("Overwatch 2", "custom-ow-slug");

        const req = sandbox.fetchMock.history[0];
        const body = Array.isArray(req.body) ? req.body[0] : req.body;
        assert.equal(body.variables.slug, "custom-ow-slug");
    });

    it("F5-T3: getActiveStreams() unwraps stream edges and extracts broadcaster login and displayName", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        const streams = await client.getActiveStreams("Overwatch 2");

        assert.equal(streams[0].broadcaster.login, "superstreamer");
        assert.equal(streams[0].broadcaster.displayName, "SuperStreamer");
        assert.equal(streams[1].broadcaster.login, "chillgamer");
    });

    it("F5-T4: getChannelWithDrops() filters out skippedLogins", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        const chosen = await client.getChannelWithDrops("Overwatch 2", "camp-1", null, ["superstreamer"]);

        assert.ok(chosen);
        assert.equal(chosen.broadcaster.login, "chillgamer");
    });

    it("F5-T5: getAllLiveForGame() returns mapped userOrError stream objects", async () => {
        sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

        const liveList = await client.getAllLiveForGame("Overwatch 2");

        assert.ok(Array.isArray(liveList));
        assert.equal(liveList.length, 3);
        assert.equal(liveList[0].data.userOrError.login, "superstreamer");
    });
});
