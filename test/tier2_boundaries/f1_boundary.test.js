import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { gqlAuthErrorFixture } from "../fixtures/error-fixtures.js";

describe("Tier 2: Boundary - Feature 1: CoreActionsCurrentUser", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F1-B1: autoDetectUserId() returns null and does not throw when oauthToken is null", async () => {
        client.oauthToken = null;
        const result = await client.autoDetectUserId();
        assert.equal(result, null);
    });

    it("F1-B2: autoDetectUserId() handles 401 Unauthorized HTTP status gracefully", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", { error: "Unauthorized" }, 401);
        const result = await client.autoDetectUserId();
        assert.equal(result, null);
    });

    it("F1-B3: autoDetectUserId() handles GraphQL error payload gracefully", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", gqlAuthErrorFixture, 200);
        const result = await client.autoDetectUserId();
        assert.equal(result, null);
    });

    it("F1-B4: autoDetectUserId() handles missing currentUser in data", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", { data: { currentUser: null } }, 200);
        const result = await client.autoDetectUserId();
        assert.equal(result, null);
    });

    it("F1-B5: autoDetectUserId() handles network fetch exception gracefully", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", () => {
            throw new TypeError("Failed to fetch");
        });
        const result = await client.autoDetectUserId();
        assert.equal(result, null);
    });
});
