import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { viewerDropsDashboardFixture } from "../fixtures/graphql-fixtures.js";

describe("Tier 1: Feature 2 - GraphQL ViewerDropsDashboard", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F2-T1: getDropCampaigns() authenticated retrieves currentUser dropCampaigns", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);

        const campaigns = await client.getDropCampaigns();

        assert.ok(Array.isArray(campaigns));
        assert.equal(campaigns.length, 1);
        assert.equal(campaigns[0].id, "camp-ow-1");
        assert.equal(campaigns[0].game.name, "Overwatch 2");
    });

    it("F2-T2: getDropCampaigns() unauthenticated falls back to unauthenticated POST", async () => {
        client.oauthToken = null;
        sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);

        const campaigns = await client.getDropCampaigns();

        assert.ok(Array.isArray(campaigns));
        assert.equal(campaigns.length, 1);
        assert.equal(campaigns[0].id, "camp-val-1");
    });

    it("F2-T3: getConnectedGames() extracts non-expired campaigns with valid game objects", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);

        const games = await client.getConnectedGames();

        assert.ok(Array.isArray(games));
        assert.equal(games.length, 1);
        assert.equal(games[0].game.name, "Overwatch 2");
    });

    it("F2-T4: getDropCampaigns() sends fetchRewardCampaigns: true variable", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);

        await client.getDropCampaigns();

        assert.equal(sandbox.fetchMock.history.length, 1);
        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.variables.fetchRewardCampaigns, true);
    });

    it("F2-T5: getDropCampaigns() uses sha256Hash 5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);

        await client.getDropCampaigns();

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.extensions.persistedQuery.sha256Hash, "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619");
    });
});
