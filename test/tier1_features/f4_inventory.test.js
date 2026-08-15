import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { inventoryFixture } from "../fixtures/graphql-fixtures.js";

describe("Tier 1: Feature 4 - GraphQL Inventory", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F4-T1: getInventory() calls postAuthorized with Inventory query", async () => {
        sandbox.fetchMock.onGql("Inventory", inventoryFixture);

        const inventory = await client.getInventory();

        assert.ok(inventory);
        assert.ok(Array.isArray(inventory.dropCampaignsInProgress));
        assert.ok(Array.isArray(inventory.gameEventDrops));
    });

    it("F4-T2: getInventory() returns dropCampaignsInProgress with timeBasedDrops", async () => {
        sandbox.fetchMock.onGql("Inventory", inventoryFixture);

        const inventory = await client.getInventory();
        const camp = inventory.dropCampaignsInProgress[0];

        assert.equal(camp.id, "camp-ow-1");
        assert.equal(camp.timeBasedDrops.length, 2);
        assert.equal(camp.timeBasedDrops[0].self.currentMinutesWatched, 45);
        assert.equal(camp.timeBasedDrops[0].self.isClaimed, false);
    });

    it("F4-T3: getInventory() returns gameEventDrops with benefitId and lastAwardedAt", async () => {
        sandbox.fetchMock.onGql("Inventory", inventoryFixture);

        const inventory = await client.getInventory();
        const eventDrop = inventory.gameEventDrops[0];

        assert.equal(eventDrop.id, "drop-val-1");
        assert.equal(eventDrop.benefitId, "ben-val-1");
        assert.equal(eventDrop.game.name, "Valorant");
    });

    it("F4-T4: getInventory() attaches Authorization and Client-Id headers", async () => {
        sandbox.fetchMock.onGql("Inventory", inventoryFixture);

        await client.getInventory();

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.headers["Authorization"], "OAuth test-oauth-token-abc");
        assert.equal(req.headers["Client-Id"], "test-client-id");
    });

    it("F4-T5: getInventory() uses sha256Hash d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b", async () => {
        sandbox.fetchMock.onGql("Inventory", inventoryFixture);

        await client.getInventory();

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.extensions.persistedQuery.sha256Hash, "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b");
    });
});
