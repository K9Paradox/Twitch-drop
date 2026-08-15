import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import {
    channelShellLiveFixture,
    channelShellOfflineFixture,
    directoryRootFixture
} from "../fixtures/graphql-fixtures.js";

describe("Tier 1: Feature 8 - GraphQL ChannelShell / Stream Metadata", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({ clientId: "test-client-id" });
    });

    it("F8-T1: getStream(username) retrieves stream details for single user", async () => {
        sandbox.fetchMock.onGql("ChannelShell", channelShellLiveFixture);

        const stream = await client.getStream("superstreamer");

        assert.ok(stream);
        assert.equal(stream.id, "stream-101");
        assert.equal(stream.type, "live");
        assert.equal(stream.viewersCount, 12500);
        assert.equal(stream.game.name, "Overwatch 2");
    });

    it("F8-T2: getStream([u1, u2]) sends batched array query", async () => {
        sandbox.fetchMock.onGql("ChannelShell", [channelShellLiveFixture, channelShellOfflineFixture]);

        const streamAry = await client.getStream(["superstreamer", "offlineuser"]);

        assert.ok(Array.isArray(streamAry));
        assert.equal(sandbox.fetchMock.history.length, 1);
        const req = sandbox.fetchMock.history[0];
        assert.ok(Array.isArray(req.body));
        assert.equal(req.body.length, 2);
    });

    it("F8-T3: getStreamMetadata(channelLogin) returns structured metadata object", async () => {
        sandbox.fetchMock.onGql("ChannelShell", channelShellLiveFixture);

        const meta = await client.getStreamMetadata("superstreamer");

        assert.ok(meta);
        assert.equal(meta.login, "superstreamer");
        assert.equal(meta.game, "Overwatch 2");
        assert.equal(meta.title, "[DROPS ENABLED] Grinding Top 500 Overwatch 2");
        assert.equal(meta.viewers, 12500);
    });

    it("F8-T4: getStreamMetadata() returns fallback object with login when offline", async () => {
        sandbox.fetchMock.onGql("ChannelShell", channelShellOfflineFixture);

        const meta = await client.getStreamMetadata("offlineuser");

        assert.ok(meta);
        assert.equal(meta.login, "offlineuser");
        assert.equal(meta.game, undefined);
    });

    it("F8-T5: getGameIdFromName(name) queries DirectoryRoot_Directory and returns game ID", async () => {
        sandbox.fetchMock.onGql("DirectoryRoot_Directory", directoryRootFixture);

        const gameId = await client.getGameIdFromName("Overwatch 2");

        assert.equal(gameId, "515025");
        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.variables.name, "overwatch 2");
    });
});
