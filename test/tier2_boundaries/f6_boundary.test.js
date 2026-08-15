import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";
import { gqlRateLimitErrorFixture } from "../fixtures/error-fixtures.js";

describe("Tier 2: Boundary - Feature 6: DropsPage_ClaimDropRewards", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F6-B1: claimDropReward() rejects with error when client is unauthenticated", async () => {
        client.oauthToken = null;
        await assert.rejects(async () => {
            await client.claimDropReward("inst-123");
        }, /OAuth token/);
    });

    it("F6-B2: claimDropReward() rejects on 401 Unauthorized token expiration", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", { error: "Unauthorized" }, 401);
        await assert.rejects(async () => {
            await client.claimDropReward("inst-123");
        }, /401/);
    });

    it("F6-B3: claimDropReward() rejects on 429 Rate Limit error response", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", gqlRateLimitErrorFixture, 429);
        await assert.rejects(async () => {
            await client.claimDropReward("inst-123");
        }, /429/);
    });

    it("F6-B4: claimDropReward() handles already-claimed status safely", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", {
            data: {
                claimDropReward: {
                    status: "DROP_INSTANCE_ALREADY_CLAIMED",
                    dropInstanceID: "inst-123"
                }
            }
        });
        const result = await client.claimDropReward("inst-123");
        assert.ok(result);
        assert.equal(result.status, "DROP_INSTANCE_ALREADY_CLAIMED");
        assert.equal(result.success, true);
    });

    it("F6-B5: claimDropReward() rejects on network connection abort", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", () => {
            throw new Error("Network request aborted");
        });
        await assert.rejects(async () => {
            await client.claimDropReward("inst-123");
        }, /Network request aborted/);
    });
});
