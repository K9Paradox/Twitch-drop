import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import {
    claimDropRewardSuccessFixture,
    claimDropRewardEligibleFixture
} from "../fixtures/graphql-fixtures.js";

describe("Tier 1: Feature 6 - GraphQL DropsPage_ClaimDropRewards", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F6-T1: claimDropReward(dropInstanceId) sends mutation with dropInstanceID input", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        const res = await client.claimDropReward("inst-ow-1");

        assert.equal(sandbox.fetchMock.history.length, 1);
        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.operationName, "DropsPage_ClaimDropRewards");
        assert.equal(req.body.variables.input.dropInstanceID, "inst-ow-1");
    });

    it("F6-T2: claimDropReward() attaches OAuth Authorization header", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        await client.claimDropReward("inst-ow-1");

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.headers["Authorization"], "OAuth test-oauth-token-abc");
        assert.equal(req.headers["Client-Id"], "test-client-id");
    });

    it("F6-T3: claimDropReward() returns status SUCCESS on successful claim", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        const res = await client.claimDropReward("inst-ow-1");

        assert.ok(res);
        assert.equal(res.status, "SUCCESS");
        assert.equal(res.dropInstanceID, "inst-ow-1");
        assert.equal(res.success, true);
    });

    it("F6-T4: claimDropReward() returns status ELIGIBLE_FOR_CLAIM when pending", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardEligibleFixture);

        const res = await client.claimDropReward("inst-ow-1");

        assert.ok(res);
        assert.equal(res.status, "ELIGIBLE_FOR_CLAIM");
        assert.equal(res.success, true);
    });

    it("F6-T5: claimDropReward() uses sha256Hash a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        await client.claimDropReward("inst-ow-1");

        const req = sandbox.fetchMock.history[0];
        assert.equal(req.body.extensions.persistedQuery.sha256Hash, "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930");
    });
});
