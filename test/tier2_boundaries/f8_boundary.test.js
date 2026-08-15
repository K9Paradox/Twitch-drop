import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";

describe("Tier 2: Boundary - Feature 8: ChannelShell / Stream Metadata", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({ clientId: "test-client-id" });
    });

    it("F8-B1: getStream() handles null / undefined username safely", async () => {
        const stream = await client.getStream(null);
        assert.equal(stream, null);
    });

    it("F8-B2: getStream() handles non-existent or banned channel gracefully", async () => {
        sandbox.fetchMock.onGql("ChannelShell", { data: { userOrError: null } });
        const stream = await client.getStream("banneduser");
        assert.equal(stream, null);
    });

    it("F8-B3: getStreamMetadata() handles missing stream object and returns fallback login", async () => {
        sandbox.fetchMock.onGql("ChannelShell", { data: { userOrError: { stream: null } } });
        const meta = await client.getStreamMetadata("offline_channel");
        assert.ok(meta);
        assert.equal(meta.login, "offline_channel");
        assert.equal(meta.viewers, undefined);
    });

    it("F8-B4: getGameIdFromName() handles non-existent game name by returning null", async () => {
        sandbox.fetchMock.onGql("DirectoryRoot_Directory", { data: { game: null } });
        const gameId = await client.getGameIdFromName("NonExistentGame12345");
        assert.equal(gameId, null);
    });

    it("F8-B5: getStream([]) handles empty array of usernames", async () => {
        const streams = await client.getStream([]);
        assert.ok(Array.isArray(streams));
        assert.equal(streams.length, 0);
    });
});
