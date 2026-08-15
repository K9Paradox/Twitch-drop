import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { gqlRateLimitErrorFixture } from "../fixtures/error-fixtures.js";

describe("Tier 2: Boundary - Feature 2: ViewerDropsDashboard", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F2-B1: getDropCampaigns() handles empty campaigns array cleanly", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", { data: { currentUser: { dropCampaigns: [] } } });
        const campaigns = await client.getDropCampaigns();
        assert.ok(Array.isArray(campaigns));
        assert.equal(campaigns.length, 0);
    });

    it("F2-B2: getDropCampaigns() handles 429 Rate Limit response gracefully", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", gqlRateLimitErrorFixture, 429);
        const campaigns = await client.getDropCampaigns();
        assert.ok(Array.isArray(campaigns));
        assert.equal(campaigns.length, 0);
    });

    it("F2-B3: getConnectedGames() filters out EXPIRED campaigns", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", {
            data: {
                currentUser: {
                    dropCampaigns: [
                        { id: "camp-1", status: "EXPIRED", game: { id: "g1", name: "Game 1" } },
                        { id: "camp-2", status: "ACTIVE", game: { id: "g2", name: "Game 2" } }
                    ]
                }
            }
        });
        const games = await client.getConnectedGames();
        assert.equal(games.length, 1);
        assert.equal(games[0].id, "camp-2");
    });

    it("F2-B4: getConnectedGames() safely ignores campaigns missing game object", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", {
            data: {
                currentUser: {
                    dropCampaigns: [
                        { id: "camp-1", status: "ACTIVE", game: null },
                        { id: "camp-2", status: "ACTIVE", game: { id: "g2", name: "Game 2" } }
                    ]
                }
            }
        });
        const games = await client.getConnectedGames();
        assert.equal(games.length, 1);
        assert.equal(games[0].id, "camp-2");
    });

    it("F2-B5: getDropCampaigns() handles network failure without throwing", async () => {
        sandbox.fetchMock.onGql("ViewerDropsDashboard", () => {
            throw new TypeError("Network connection lost");
        });
        const campaigns = await client.getDropCampaigns();
        assert.ok(Array.isArray(campaigns));
        assert.equal(campaigns.length, 0);
    });
});
