import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { gqlForbiddenErrorFixture } from "../fixtures/error-fixtures.js";

describe("Tier 2: Boundary - Feature 4: Inventory", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F4-B1: getInventory() returns null when oauthToken is missing", async () => {
        client.oauthToken = null;
        const result = await client.getInventory();
        assert.equal(result, null);
    });

    it("F4-B2: getInventory() handles missing currentUser or null inventory", async () => {
        sandbox.fetchMock.onGql("Inventory", { data: { currentUser: null } });
        const result = await client.getInventory();
        assert.equal(result, null);
    });

    it("F4-B3: getInventory() handles empty dropCampaignsInProgress and gameEventDrops", async () => {
        sandbox.fetchMock.onGql("Inventory", {
            data: {
                currentUser: {
                    inventory: {
                        dropCampaignsInProgress: [],
                        gameEventDrops: []
                    }
                }
            }
        });
        const result = await client.getInventory();
        assert.ok(result);
        assert.equal(result.dropCampaignsInProgress.length, 0);
        assert.equal(result.gameEventDrops.length, 0);
    });

    it("F4-B4: getInventory() handles 403 Forbidden GraphQL error response", async () => {
        sandbox.fetchMock.onGql("Inventory", gqlForbiddenErrorFixture, 403);
        const result = await client.getInventory();
        assert.equal(result, null);
    });

    it("F4-B5: getInventory() handles network fetch timeout gracefully", async () => {
        sandbox.fetchMock.onGql("Inventory", () => {
            throw new Error("Socket connection closed prematurely");
        });
        const result = await client.getInventory();
        assert.equal(result, null);
    });
});
