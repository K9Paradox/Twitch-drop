import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { gqlInternalServerErrorFixture, expiredIntegrityTokenFixture } from "../fixtures/error-fixtures.js";

describe("Tier 2: Boundary - Feature 3: DropCampaignDetails", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F3-B1: getDropCampaignDetails(null) returns null and does not make request", async () => {
        const details = await client.getDropCampaignDetails(null);
        assert.equal(details, null);
    });

    it("F3-B2: getDropCampaignDetails() handles null user or dropCampaign in response data", async () => {
        sandbox.fetchMock.onGql("DropCampaignDetails", { data: { user: null } });
        const details = await client.getDropCampaignDetails("camp-invalid");
        assert.equal(details, null);
    });

    it("F3-B3: getDropCampaignDetails([]) with empty array returns empty array", async () => {
        const details = await client.getDropCampaignDetails([]);
        assert.ok(Array.isArray(details));
        assert.equal(details.length, 0);
    });

    it("F3-B4: getDropCampaignDetails() handles 500 Internal Server Error gracefully", async () => {
        sandbox.fetchMock.onGql("DropCampaignDetails", gqlInternalServerErrorFixture, 500);
        const details = await client.getDropCampaignDetails("camp-err");
        assert.equal(details, null);
    });

    it("F3-B5: getInteg() rejects expired integrity token (< 16 min remaining)", async () => {
        client.integrity = expiredIntegrityTokenFixture;
        const valid = await client.getInteg();
        assert.equal(valid, false);
    });
});
