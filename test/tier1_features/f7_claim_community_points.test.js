import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import {
    claimCommunityPointsSuccessFixture,
    claimCommunityPointsErrorFixture
} from "../fixtures/graphql-fixtures.js";

describe("Tier 1: Feature 7 - GraphQL ClaimCommunityPoints", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F7-T1: claimChannelPoints(channelId, claimId) sends mutation with input parameters", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);

        await client.claimChannelPoints("user-101", "chest-claim-100");

        assert.equal(sandbox.fetchMock.history.length, 1);
        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.operationName, "ClaimCommunityPoints");
        assert.equal(req.body.variables.input.channelID, "user-101");
        assert.equal(req.body.variables.input.claimID, "chest-claim-100");
    });

    it("F7-T2: claimChannelPoints() returns { success: true, points: 50 } on valid claim", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);

        const result = await client.claimChannelPoints("user-101", "chest-claim-100");

        assert.ok(result);
        assert.equal(result.success, true);
        assert.equal(result.points, 50);
    });

    it("F7-T3: claimChannelPoints() extracts dynamic pointsEarnedTotal from response", async () => {
        const customPointsFixture = {
            data: {
                claimCommunityPoints: {
                    claim: {
                        id: "chest-claim-custom",
                        pointsEarnedTotal: 100
                    },
                    error: null
                }
            }
        };
        sandbox.fetchMock.onGql("ClaimCommunityPoints", customPointsFixture);

        const result = await client.claimChannelPoints("user-101", "chest-claim-custom");

        assert.ok(result);
        assert.equal(result.success, true);
        assert.equal(result.points, 100);
    });

    it("F7-T4: claimChannelPoints() rejects with TwitchApiError when response contains error", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsErrorFixture);

        await assert.rejects(async () => {
            await client.claimChannelPoints("user-101", "chest-claim-err");
        }, /CLAIM_NOT_FOUND/);
    });

    it("F7-T5: claimChannelPoints() uses sha256Hash 46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);

        await client.claimChannelPoints("user-101", "chest-claim-100");

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.extensions.persistedQuery.sha256Hash, "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0");
    });
});
