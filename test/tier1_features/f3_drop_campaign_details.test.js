import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { dropCampaignDetailsFixture } from "../fixtures/graphql-fixtures.js";

describe("Tier 1: Feature 3 - GraphQL DropCampaignDetails", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc",
            userId: "user-12345"
        });
    });

    it("F3-T1: getDropCampaignDetails(dropId) retrieves details for single campaign", async () => {
        sandbox.fetchMock.onGql("DropCampaignDetails", dropCampaignDetailsFixture);

        const details = await client.getDropCampaignDetails("camp-ow-1");

        assert.ok(details);
        assert.equal(details.id, "camp-ow-1");
        assert.equal(details.game.name, "Overwatch 2");
        assert.equal(details.timeBasedDrops.length, 1);
        assert.equal(details.timeBasedDrops[0].requiredMinutesWatched, 120);
    });

    it("F3-T2: getDropCampaignDetails([id1, id2]) sends batched array query", async () => {
        sandbox.fetchMock.onGql("DropCampaignDetails", [dropCampaignDetailsFixture, dropCampaignDetailsFixture]);

        const detailsList = await client.getDropCampaignDetails(["camp-ow-1", "camp-ow-2"]);

        assert.ok(Array.isArray(detailsList));
        assert.equal(sandbox.fetchMock.history.length, 1);
        const req = sandbox.fetchMock.history[0];
        assert.ok(Array.isArray(req.body));
        assert.equal(req.body.length, 2);
    });

    it("F3-T3: getDropCampaignDetails() passes dropID and channelLogin in variables", async () => {
        sandbox.fetchMock.onGql("DropCampaignDetails", dropCampaignDetailsFixture);

        await client.getDropCampaignDetails("camp-ow-1");

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.variables.dropID, "camp-ow-1");
        assert.equal(req.body.variables.channelLogin, "user-12345");
    });

    it("F3-T4: getDropCampaignDetails() attaches Client-Integrity header when integrity token is set", async () => {
        client.integrity = { token: "test-integrity-token-123" };
        sandbox.fetchMock.onGql("DropCampaignDetails", dropCampaignDetailsFixture);

        await client.getDropCampaignDetails("camp-ow-1");

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.headers["Client-Integrity"], "test-integrity-token-123");
    });

    it("F3-T5: getDropCampaignDetails() uses persisted query hash 039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1", async () => {
        sandbox.fetchMock.onGql("DropCampaignDetails", dropCampaignDetailsFixture);

        await client.getDropCampaignDetails("camp-ow-1");

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.extensions.persistedQuery.sha256Hash, "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1");
    });
});
