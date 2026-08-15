import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { currentUserFixture } from "../fixtures/graphql-fixtures.js";

describe("Tier 1: Feature 1 - GraphQL CoreActionsCurrentUser", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc",
            deviceId: "test-device-id-123",
            uuid: "test-uuid-456"
        });
    });

    it("F1-T1: autoDetectUserId() successfully retrieves userId with valid OAuth token", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", currentUserFixture);

        const userId = await client.autoDetectUserId();

        assert.equal(userId, "12345678");
        assert.equal(client.userId, "12345678");
    });

    it("F1-T2: autoDetectUserId() persists userId into chrome.storage.local", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", currentUserFixture);

        await client.autoDetectUserId();
        const stored = await sandbox.chrome.storage.local.get("userId");

        assert.equal(stored.userId, "12345678");
    });

    it("F1-T3: getUserId() delegates to autoDetectUserId() when userId is not set", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", currentUserFixture);

        const userId = await client.getUserId();

        assert.equal(userId, "12345678");
    });

    it("F1-T4: autoDetectUserId() sends proper Authorization and Client-Id headers", async () => {
        sandbox.fetchMock.onGql("CoreActionsCurrentUser", currentUserFixture);

        await client.autoDetectUserId();

        assert.equal(sandbox.fetchMock.history.length, 1);
        const req = sandbox.fetchMock.history[0];
        assert.equal(req.headers["Authorization"], "OAuth test-oauth-token-abc");
        assert.equal(req.headers["Client-Id"], "test-client-id");
        assert.equal(req.headers["X-Device-Id"], "test-device-id-123");
        assert.equal(req.headers["Client-Session-Id"], "test-uuid-456");
    });

    it("F1-T5: updateUserInfo() updates all user fields and persists client integrity", async () => {
        await client.updateUserInfo({
            oauthToken: "new-token-xyz",
            deviceId: "new-device-id",
            userId: "87654321",
            uuid: "new-uuid-789",
            integrity: { token: "new-integ-token", expiration: Date.now() + 1000000 }
        });

        assert.equal(client.oauthToken, "new-token-xyz");
        assert.equal(client.deviceId, "new-device-id");
        assert.equal(client.userId, "87654321");
        assert.equal(client.uuid, "new-uuid-789");
        assert.equal(client.integrity.token, "new-integ-token");
    });
});
