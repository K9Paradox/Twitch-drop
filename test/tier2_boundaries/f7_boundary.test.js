import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";

describe("Tier 2: Boundary - Feature 7: ClaimCommunityPoints", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F7-B1: claimChannelPoints() rejects when client has no oauthToken", async () => {
        client.oauthToken = null;
        await assert.rejects(async () => {
            await client.claimChannelPoints("chest-123", "user-101");
        }, /OAuth token/);
    });

    it("F7-B2: claimChannelPoints() rejects when response error object is present", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", {
            data: {
                claimCommunityPoints: {
                    claim: null,
                    error: {
                        code: "CLAIM_EXPIRED",
                        message: "The community points claim has expired."
                    }
                }
            }
        });
        await assert.rejects(async () => {
            await client.claimChannelPoints("chest-expired", "user-101");
        }, /CLAIM_EXPIRED/);
    });

    it("F7-B3: claimChannelPoints() rejects on 503 Service Unavailable HTTP error", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", { error: "Service Unavailable" }, 503);
        await assert.rejects(async () => {
            await client.claimChannelPoints("chest-123", "user-101");
        }, /503/);
    });

    it("F7-B4: claimChannelPoints() falls back to 50 points if pointsEarnedTotal is missing", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", {
            data: {
                claimCommunityPoints: {
                    claim: {
                        id: "chest-123",
                        pointsEarnedTotal: null
                    },
                    error: null
                }
            }
        });
        const result = await client.claimChannelPoints("chest-123", "user-101");
        assert.ok(result);
        assert.equal(result.success, true);
        assert.equal(result.points, 50);
    });

    it("F7-B5: claimChannelPoints() rejects on network DNS or connection failure", async () => {
        sandbox.fetchMock.onGql("ClaimCommunityPoints", () => {
            throw new Error("DNS lookup failure");
        });
        await assert.rejects(async () => {
            await client.claimChannelPoints("chest-123", "user-101");
        }, /DNS lookup failure/);
    });
});
