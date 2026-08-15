/**
 * Adversarial & Empirical Challenge Test Suite for Twitch GraphQL Client (`background/twitchApi.js`)
 * 
 * Challenger 1 - Milestone 1 Verification
 * Comprehensive tests covering:
 * 1. All 9 GraphQL operations with valid mock responses (contract validation)
 * 2. HTTP error status codes (400, 401, 403, 429, 500, 503) throwing TwitchApiError
 * 3. GraphQL error payloads ({ errors: [...] }) throwing TwitchApiError
 * 4. Batched operations with partial errors, empty arrays, and mixed responses
 * 5. Malformed JSON, network aborts, timeouts, and boundary parameter edge cases
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "./harness/sandbox.js";
import { Client, TwitchApiError } from "../background/twitchApi.js";
import {
    currentUserFixture,
    directoryRootFixture,
    viewerDropsDashboardFixture,
    dropCampaignDetailsFixture,
    inventoryFixture,
    directoryPageGameFixture,
    claimDropRewardSuccessFixture,
    claimDropRewardEligibleFixture,
    claimCommunityPointsSuccessFixture,
    claimCommunityPointsErrorFixture,
    channelShellLiveFixture,
    channelShellOfflineFixture
} from "./fixtures/graphql-fixtures.js";
import {
    gqlAuthErrorFixture,
    gqlForbiddenErrorFixture,
    gqlRateLimitErrorFixture,
    gqlInternalServerErrorFixture,
    expiredIntegrityTokenFixture,
    validIntegrityTokenFixture,
    malformedJsonString
} from "./fixtures/error-fixtures.js";

describe("Adversarial Suite: Twitch GraphQL Client (`background/twitchApi.js`)", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko",
            oauthToken: "test_oauth_token_12345",
            deviceId: "device_abc_999",
            integrity: "integrity_token_jwt_xyz",
            userId: "12345678",
            uuid: "session_uuid_001"
        });
    });

    // =========================================================================
    // SECTION 1: Valid Mock Responses & Schema Contracts for all 9 Operations
    // =========================================================================
    describe("Section 1: All 9 GraphQL Operations Contract & Consumer Field Verification", () => {

        it("Op 1: CoreActionsCurrentUser via autoDetectUserId() / getUserId()", async () => {
            sandbox.fetchMock.onGql("CoreActionsCurrentUser", currentUserFixture);

            const userId = await client.autoDetectUserId();
            assert.equal(userId, "12345678");
            assert.equal(client.userId, "12345678");

            const stored = await sandbox.chrome.storage.local.get("userId");
            assert.equal(stored.userId, "12345678");

            const req = sandbox.fetchMock.history.find(h => h.body?.operationName === "CoreActionsCurrentUser");
            assert.ok(req);
            assert.equal(req.headers["Client-Id"], "kimne78kx3ncx6brgo4mv6wki5h1ko");
            assert.equal(req.headers["Authorization"], "OAuth test_oauth_token_12345");
            assert.equal(req.headers["X-Device-Id"], "device_abc_999");
            assert.equal(req.headers["Client-Integrity"], "integrity_token_jwt_xyz");
            assert.equal(req.headers["Client-Session-Id"], "session_uuid_001");
        });

        it("Op 2: DirectoryRoot_Directory via getGameIdFromName()", async () => {
            sandbox.fetchMock.onGql("DirectoryRoot_Directory", directoryRootFixture);

            const gameId = await client.getGameIdFromName("Overwatch 2");
            assert.equal(gameId, "515025");

            const req = sandbox.fetchMock.history.find(h => h.body?.operationName === "DirectoryRoot_Directory");
            assert.ok(req);
            assert.equal(req.body.variables.name, "overwatch 2"); // lowercased
        });

        it("Op 3: ViewerDropsDashboard via getDropCampaigns() & getConnectedGames()", async () => {
            sandbox.fetchMock.onGql("ViewerDropsDashboard", viewerDropsDashboardFixture);

            const campaigns = await client.getDropCampaigns();
            assert.ok(Array.isArray(campaigns));
            assert.equal(campaigns.length, 1);
            assert.equal(campaigns[0].id, "camp-ow-1");
            assert.equal(campaigns[0].game.name, "Overwatch 2");
            assert.equal(campaigns[0].status, "ACTIVE");

            // Test getConnectedGames filters out EXPIRED campaigns
            const connectedGames = await client.getConnectedGames();
            assert.ok(Array.isArray(connectedGames));
            assert.equal(connectedGames.length, 1);
            assert.equal(connectedGames[0].id, "camp-ow-1");

            // Test unauthenticated fallback
            client.oauthToken = null;
            const unauthCampaigns = await client.getDropCampaigns();
            assert.ok(Array.isArray(unauthCampaigns));
        });

        it("Op 4: DropCampaignDetails via getDropCampaignDetails() - Single & Batched", async () => {
            sandbox.fetchMock.onGql("DropCampaignDetails", dropCampaignDetailsFixture);

            // Single ID
            const singleDetails = await client.getDropCampaignDetails("camp-ow-1");
            assert.ok(singleDetails);
            assert.equal(singleDetails.id, "camp-ow-1");
            assert.equal(singleDetails.name, "Overwatch 2 Season 10 Drops");
            assert.equal(singleDetails.timeBasedDrops.length, 1);
            assert.equal(singleDetails.timeBasedDrops[0].requiredMinutesWatched, 120);

            // Batched IDs
            sandbox.fetchMock.onGql("DropCampaignDetails", [dropCampaignDetailsFixture, dropCampaignDetailsFixture]);
            const batchDetails = await client.getDropCampaignDetails(["camp-ow-1", "camp-ow-2"]);
            assert.ok(Array.isArray(batchDetails));
            assert.equal(batchDetails.length, 2);
        });

        it("Op 5: Inventory via getInventory()", async () => {
            sandbox.fetchMock.onGql("Inventory", inventoryFixture);

            const inventory = await client.getInventory();
            assert.ok(inventory);
            assert.ok(Array.isArray(inventory.dropCampaignsInProgress));
            assert.equal(inventory.dropCampaignsInProgress.length, 1);
            assert.equal(inventory.dropCampaignsInProgress[0].id, "camp-ow-1");
            assert.ok(Array.isArray(inventory.gameEventDrops));
            assert.equal(inventory.gameEventDrops[0].id, "drop-val-1");
        });

        it("Op 6: DirectoryPage_Game via getActiveStreams() & getChannelWithDrops()", async () => {
            sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

            const streams = await client.getActiveStreams("Overwatch 2", null);
            assert.ok(Array.isArray(streams));
            assert.equal(streams.length, 3);
            assert.equal(streams[0].broadcaster.login, "superstreamer");
            assert.equal(streams[0].broadcaster.displayName, "SuperStreamer");
            assert.equal(streams[1].broadcaster.login, "chillgamer");

            // getChannelWithDrops with skipping
            const picked = await client.getChannelWithDrops("Overwatch 2", "camp-ow-1", null, ["superstreamer"]);
            assert.ok(picked);
            assert.equal(picked.broadcaster.login, "chillgamer");
        });

        it("Op 7: DropsPage_ClaimDropRewards via claimDropReward()", async () => {
            sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

            const result = await client.claimDropReward("inst-ow-1");
            assert.ok(result);
            assert.equal(result.status, "SUCCESS");
            assert.equal(result.dropInstanceID, "inst-ow-1");
            assert.equal(result.success, true);

            // Test ELIGIBLE_FOR_CLAIM status
            sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardEligibleFixture);
            const eligibleResult = await client.claimDropReward("inst-ow-1");
            assert.equal(eligibleResult.status, "ELIGIBLE_FOR_CLAIM");
            assert.equal(eligibleResult.success, true);
        });

        it("Op 8: ClaimCommunityPoints via claimChannelPoints()", async () => {
            sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);

            // Standard signature: (channelID, claimID)
            const res1 = await client.claimChannelPoints("user-101", "chest-claim-100");
            assert.ok(res1);
            assert.equal(res1.status, "SUCCESS");
            assert.equal(res1.claimID, "chest-claim-100");
            assert.equal(res1.points, 50);
            assert.equal(res1.success, true);

            // Swapped signature: (claimID with dash, channelID without dash)
            const res2 = await client.claimChannelPoints("chest-claim-100", "user101");
            assert.equal(res2.claimID, "chest-claim-100");
            assert.equal(res2.success, true);

            // Object signature: { channelID, claimID }
            const res3 = await client.claimChannelPoints({ channelID: "user-101", claimID: "chest-claim-100" });
            assert.equal(res3.claimID, "chest-claim-100");
            assert.equal(res3.success, true);
        });

        it("Op 9: ChannelShell via getStream() & getStreamMetadata()", async () => {
            sandbox.fetchMock.onGql("ChannelShell", channelShellLiveFixture);

            const stream = await client.getStream("superstreamer");
            assert.ok(stream);
            assert.equal(stream.id, "stream-101");
            assert.equal(stream.type, "live");
            assert.equal(stream.viewersCount, 12500);
            assert.equal(stream.game.displayName, "Overwatch 2");

            const metadata = await client.getStreamMetadata("superstreamer");
            assert.ok(metadata);
            assert.equal(metadata.login, "superstreamer");
            assert.equal(metadata.game, "Overwatch 2");
            assert.equal(metadata.title, "[DROPS ENABLED] Grinding Top 500 Overwatch 2");
            assert.equal(metadata.viewers, 12500);

            // Offline channel
            sandbox.fetchMock.onGql("ChannelShell", channelShellOfflineFixture);
            const offlineStream = await client.getStream("offline_streamer");
            assert.equal(offlineStream, null);
        });
    });

    // =========================================================================
    // SECTION 2: HTTP Error Scenarios (400, 401, 403, 429, 500, 503)
    // =========================================================================
    describe("Section 2: HTTP Error Scenarios & TwitchApiError Verification", () => {
        const httpStatuses = [
            { code: 400, text: "Bad Request" },
            { code: 401, text: "Unauthorized" },
            { code: 403, text: "Forbidden" },
            { code: 429, text: "Too Many Requests" },
            { code: 500, text: "Internal Server Error" },
            { code: 503, text: "Service Unavailable" }
        ];

        for (const { code, text } of httpStatuses) {
            it(`post() throws TwitchApiError on HTTP ${code} ${text}`, async () => {
                sandbox.fetchMock.onGql("DirectoryRoot_Directory", { error: text }, code);

                try {
                    await client.post({
                        operationName: "DirectoryRoot_Directory",
                        variables: { name: "overwatch" }
                    });
                    assert.fail(`Expected HTTP ${code} to throw TwitchApiError`);
                } catch (err) {
                    assert.ok(err instanceof TwitchApiError, `Error should be TwitchApiError, got: ${err.constructor.name}`);
                    assert.equal(err.status, code);
                    assert.equal(err.operationName, "DirectoryRoot_Directory");
                    assert.ok(err.message.includes(String(code)));
                }
            });

            it(`postAuthorized() throws TwitchApiError on HTTP ${code} ${text}`, async () => {
                sandbox.fetchMock.onGql("Inventory", { error: text }, code);

                try {
                    await client.postAuthorized({
                        operationName: "Inventory"
                    });
                    assert.fail(`Expected HTTP ${code} to throw TwitchApiError`);
                } catch (err) {
                    assert.ok(err instanceof TwitchApiError, `Error should be TwitchApiError, got: ${err.constructor.name}`);
                    assert.equal(err.status, code);
                    assert.equal(err.operationName, "Inventory");
                    assert.ok(err.message.includes(String(code)));
                }
            });
        }

        it("postAuthorized() throws TwitchApiError status 401 before network when oauthToken is missing", async () => {
            client.oauthToken = null;

            try {
                await client.postAuthorized({
                    operationName: "CoreActionsCurrentUser"
                });
                assert.fail("Expected missing oauthToken to throw TwitchApiError");
            } catch (err) {
                assert.ok(err instanceof TwitchApiError);
                assert.equal(err.status, 401);
                assert.equal(err.operationName, "CoreActionsCurrentUser");
                assert.ok(err.message.includes("Unauthorized: Missing OAuth token"));
            }
        });

        it("claimDropReward() propagates HTTP 401 / 429 / 500 TwitchApiError", async () => {
            sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", { error: "Rate Limited" }, 429);

            try {
                await client.claimDropReward("inst-123");
                assert.fail("Should throw on 429");
            } catch (err) {
                assert.ok(err instanceof TwitchApiError);
                assert.equal(err.status, 429);
                assert.equal(err.operationName, "DropsPage_ClaimDropRewards");
            }
        });

        it("claimChannelPoints() propagates HTTP 503 TwitchApiError", async () => {
            sandbox.fetchMock.onGql("ClaimCommunityPoints", { error: "Service Unavailable" }, 503);

            try {
                await client.claimChannelPoints("user-101", "chest-123");
                assert.fail("Should throw on 503");
            } catch (err) {
                assert.ok(err instanceof TwitchApiError);
                assert.equal(err.status, 503);
                assert.equal(err.operationName, "ClaimCommunityPoints");
            }
        });
    });

    // =========================================================================
    // SECTION 3: GraphQL Error Payloads with HTTP 200
    // =========================================================================
    describe("Section 3: GraphQL Error Payloads ({ errors: [...] }) Handling", () => {

        it("post() throws TwitchApiError when response contains top-level errors array", async () => {
            sandbox.fetchMock.onGql("DirectoryRoot_Directory", {
                errors: [
                    { message: "PersistedQueryNotFound", path: ["game"] }
                ]
            }, 200);

            try {
                await client.post({ operationName: "DirectoryRoot_Directory" });
                assert.fail("Expected GraphQL error payload to throw");
            } catch (err) {
                assert.ok(err instanceof TwitchApiError);
                assert.equal(err.status, 200);
                assert.ok(err.message.includes("PersistedQueryNotFound"));
                assert.ok(Array.isArray(err.errors));
                assert.equal(err.errors.length, 1);
                assert.equal(err.errors[0].message, "PersistedQueryNotFound");
            }
        });

        it("postAuthorized() throws TwitchApiError aggregating multiple error messages", async () => {
            sandbox.fetchMock.onGql("Inventory", {
                errors: [
                    { message: "Service degradation in inventory cluster" },
                    { message: "User session expired" }
                ]
            }, 200);

            try {
                await client.postAuthorized({ operationName: "Inventory" });
                assert.fail("Expected multi-error payload to throw");
            } catch (err) {
                assert.ok(err instanceof TwitchApiError);
                assert.equal(err.status, 200);
                assert.ok(err.message.includes("Service degradation"));
                assert.ok(err.message.includes("User session expired"));
                assert.equal(err.errors.length, 2);
            }
        });

        it("claimCommunityPoints throws TwitchApiError on inner error payload", async () => {
            sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsErrorFixture);

            try {
                await client.claimChannelPoints("user-101", "chest-100");
                assert.fail("Expected claimCommunityPoints error payload to throw");
            } catch (err) {
                assert.ok(err instanceof TwitchApiError);
                assert.ok(err.message.includes("CLAIM_NOT_FOUND"));
                assert.ok(err.errors);
                assert.equal(err.errors[0].code, "CLAIM_NOT_FOUND");
            }
        });

        it("claimDropReward throws TwitchApiError when response has empty / null claimDropReward", async () => {
            sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", {
                data: {
                    claimDropReward: null
                }
            });

            try {
                await client.claimDropReward("inst-empty");
                assert.fail("Expected null claimDropReward to throw");
            } catch (err) {
                assert.ok(err instanceof TwitchApiError);
                assert.ok(err.message.includes("empty or invalid response"));
            }
        });
    });

    // =========================================================================
    // SECTION 4: Batched Operations with Partial Errors and Array Unwrapping
    // =========================================================================
    describe("Section 4: Batched Operations & Array Handling", () => {

        it("post() with array returns full array directly without throwing on element errors", async () => {
            const batchPayload = [
                { data: { userOrError: { login: "streamer1", stream: { id: "s1" } } } },
                { errors: [{ message: "Channel not found" }] }
            ];
            sandbox.fetchMock.onGql("ChannelShell", batchPayload);

            const result = await client.post([
                { operationName: "ChannelShell", variables: { login: "streamer1" } },
                { operationName: "ChannelShell", variables: { login: "streamer2" } }
            ]);

            assert.ok(Array.isArray(result));
            assert.equal(result.length, 2);
            assert.ok(result[0].data);
            assert.ok(result[1].errors);
        });

        it("extractOperationName properly handles batch arrays and joins op names", () => {
            const opName = client.extractOperationName([
                { operationName: "ChannelShell" },
                { operationName: "DirectoryPage_Game" }
            ]);
            assert.equal(opName, "ChannelShell,DirectoryPage_Game");
        });

        it("getDropCampaignDetails([]) returns [] immediately without fetch", async () => {
            const result = await client.getDropCampaignDetails([]);
            assert.deepEqual(result, []);
            assert.equal(sandbox.fetchMock.history.length, 0);
        });

        it("getStream([]) returns [] immediately without fetch", async () => {
            const result = await client.getStream([]);
            assert.deepEqual(result, []);
            assert.equal(sandbox.fetchMock.history.length, 0);
        });

        it("getActiveStreams() handles empty edges or missing stream data safely", async () => {
            sandbox.fetchMock.onGql("DirectoryPage_Game", [{
                data: {
                    game: {
                        streams: {
                            edges: [
                                { node: { id: "bad-1", broadcaster: null } },
                                { node: null }
                            ]
                        }
                    }
                }
            }]);

            const streams = await client.getActiveStreams("Overwatch 2", null);
            assert.deepEqual(streams, []);
        });
    });

    // =========================================================================
    // SECTION 5: Malformed JSON, Network Timeouts, Aborts & Boundary Checks
    // =========================================================================
    describe("Section 5: Malformed JSON, Network Aborts, Timeouts & Boundary Robustness", () => {

        it("post() throws SyntaxError on malformed JSON response body", async () => {
            sandbox.fetchMock.onUrl("gql.twitch.tv", () => {
                return {
                    status: 200,
                    ok: true,
                    statusText: "OK",
                    json: async () => { throw new SyntaxError("Unexpected token in JSON"); }
                };
            });

            await assert.rejects(async () => {
                await client.post({ operationName: "DirectoryRoot_Directory" });
            }, /SyntaxError|JSON/);
        });

        it("autoDetectUserId() safely catches network throw and returns fallback userId", async () => {
            client.userId = null;
            sandbox.fetchMock.onGql("CoreActionsCurrentUser", () => {
                throw new Error("ETIMEDOUT: Connection timed out");
            });

            const userId = await client.autoDetectUserId();
            assert.equal(userId, null);

            // If userId was already set, network failure preserves current userId
            client.userId = "cached_user_123";
            const preservedUserId = await client.autoDetectUserId();
            assert.equal(preservedUserId, "cached_user_123");
        });

        it("getGameIdFromName() safely catches network throw and returns null", async () => {
            sandbox.fetchMock.onGql("DirectoryRoot_Directory", () => {
                throw new Error("ENOTFOUND: DNS lookup failed");
            });

            const gameId = await client.getGameIdFromName("Overwatch 2");
            assert.equal(gameId, null);
        });

        it("getDropCampaigns() safely catches network throw and returns empty array", async () => {
            sandbox.fetchMock.onGql("ViewerDropsDashboard", () => {
                throw new Error("ECONNRESET: Connection reset by peer");
            });

            const campaigns = await client.getDropCampaigns();
            assert.deepEqual(campaigns, []);
        });

        it("getDropCampaignDetails() safely catches network throw and returns null", async () => {
            sandbox.fetchMock.onGql("DropCampaignDetails", () => {
                throw new Error("Fetch Aborted");
            });

            const details = await client.getDropCampaignDetails("camp-123");
            assert.equal(details, null);
        });

        it("getInventory() safely catches network throw and returns null", async () => {
            sandbox.fetchMock.onGql("Inventory", () => {
                throw new Error("504 Gateway Timeout");
            });

            const inv = await client.getInventory();
            assert.equal(inv, null);
        });

        it("getActiveStreams() safely catches network throw and returns empty array", async () => {
            sandbox.fetchMock.onGql("DirectoryPage_Game", () => {
                throw new Error("Socket Hangup");
            });

            const streams = await client.getActiveStreams("Overwatch 2", null);
            assert.deepEqual(streams, []);
        });

        it("getStreamMetadata() safely catches network throw and returns fallback { login }", async () => {
            sandbox.fetchMock.onGql("ChannelShell", () => {
                throw new Error("Network timeout");
            });

            const meta = await client.getStreamMetadata("superstreamer");
            assert.deepEqual(meta, { login: "superstreamer" });
        });

        it("claimDropReward() throws TwitchApiError when dropInstanceId is missing or empty", async () => {
            await assert.rejects(async () => {
                await client.claimDropReward(null);
            }, (err) => {
                return err instanceof TwitchApiError && err.message.includes("dropInstanceID is required");
            });

            await assert.rejects(async () => {
                await client.claimDropReward("");
            }, (err) => {
                return err instanceof TwitchApiError && err.message.includes("dropInstanceID is required");
            });
        });

        it("claimChannelPoints() throws TwitchApiError when channelID or claimID is missing", async () => {
            await assert.rejects(async () => {
                await client.claimChannelPoints(null, "chest-1");
            }, (err) => {
                return err instanceof TwitchApiError && err.message.includes("Both channelID and claimID are required");
            });

            await assert.rejects(async () => {
                await client.claimChannelPoints("user-1", null);
            }, (err) => {
                return err instanceof TwitchApiError && err.message.includes("Both channelID and claimID are required");
            });
        });

        it("getInteg() rejects integrity token expiring in less than 16 minutes", async () => {
            client.integrity = {
                token: "expiring-token",
                expiration: Date.now() + 500000 // ~8.3 min remaining (< 16 min / 960000 ms)
            };

            const integ = await client.getInteg();
            assert.equal(integ, false);
        });

        it("getInteg() accepts fresh integrity token expiring in more than 16 minutes", async () => {
            client.integrity = {
                token: "fresh-token",
                expiration: Date.now() + 3600000 // 60 min remaining
            };

            const integ = await client.getInteg();
            assert.ok(integ);
            assert.equal(integ.token, "fresh-token");
        });

        it("updateUserInfo() safely merges parameters without wiping unspecified fields", async () => {
            client.updateUserInfo({
                oauthToken: "new_oauth_token",
                deviceId: "new_device_id"
            });

            assert.equal(client.oauthToken, "new_oauth_token");
            assert.equal(client.deviceId, "new_device_id");
            assert.equal(client.clientId, "kimne78kx3ncx6brgo4mv6wki5h1ko"); // preserved
            assert.equal(client.userId, "12345678"); // preserved
        });
    });

    // =========================================================================
    // SECTION 6: Aggressive Stress Tests, Concurrency & Extreme Attack Vectors
    // =========================================================================
    describe("Section 6: Aggressive Stress Tests, Concurrency & Attack Scenarios", () => {

        it("extractOperationName handles hostile/malformed payloads safely", () => {
            assert.equal(client.extractOperationName(null), null);
            assert.equal(client.extractOperationName(undefined), null);
            assert.equal(client.extractOperationName(""), null);
            assert.equal(client.extractOperationName(123), null);
            assert.equal(client.extractOperationName({}), null);
            assert.equal(client.extractOperationName([]), "");
            assert.equal(client.extractOperationName([{}]), "");
            assert.equal(client.extractOperationName([{ operationName: null }]), "");
            assert.equal(client.extractOperationName([{ operationName: "Op1" }, null, { operationName: "Op2" }]), "Op1,Op2");
        });

        it("buildHeaders handles integrity objects and strings properly", () => {
            // String integrity
            client.integrity = "raw_token_string";
            let headers = client.buildHeaders(true);
            assert.equal(headers["Client-Integrity"], "raw_token_string");

            // Object integrity
            client.integrity = { token: "object_token_string", expiration: Date.now() + 3600000 };
            headers = client.buildHeaders(true);
            assert.equal(headers["Client-Integrity"], "object_token_string");

            // Null integrity
            client.integrity = null;
            headers = client.buildHeaders(true);
            assert.equal(headers["Client-Integrity"], undefined);
        });

        it("getActiveStreams sanitizes extreme game titles with symbols and punctuation into valid slugs", async () => {
            sandbox.fetchMock.onGql("DirectoryPage_Game", [directoryPageGameFixture]);

            await client.getActiveStreams("!!! Counter-Strike: Global Offensive (CS:GO) @@@", null);
            const req = sandbox.fetchMock.history.find(h => Array.isArray(h.body) && h.body[0]?.operationName === "DirectoryPage_Game");
            assert.ok(req);
            const sentSlug = req.body[0].variables.slug;
            assert.equal(sentSlug, "counter-strike-global-offensive-cs-go");
        });

        it("claimDropReward status evaluation matrix produces expected success booleans", async () => {
            const testCases = [
                { status: "SUCCESS", expectedSuccess: true },
                { status: "ELIGIBLE_FOR_CLAIM", expectedSuccess: true },
                { status: "DROP_INSTANCE_ALREADY_CLAIMED", expectedSuccess: true },
                { status: "FAILED", expectedSuccess: false },
                { status: "EXPIRED", expectedSuccess: false },
                { status: "INVALID_INSTANCE", expectedSuccess: false }
            ];

            for (const { status, expectedSuccess } of testCases) {
                sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", {
                    data: {
                        claimDropReward: {
                            status: status,
                            dropInstanceID: "inst-test"
                        }
                    }
                });

                const res = await client.claimDropReward("inst-test");
                assert.equal(res.status, status);
                assert.equal(res.success, expectedSuccess, `Status ${status} should yield success: ${expectedSuccess}`);
            }
        });

        it("Concurrency Stress: 50 concurrent GraphQL queries settle reliably without race conditions", async () => {
            sandbox.fetchMock.onGql("CoreActionsCurrentUser", currentUserFixture);
            sandbox.fetchMock.onGql("DirectoryRoot_Directory", directoryRootFixture);
            sandbox.fetchMock.onGql("Inventory", inventoryFixture);

            const promises = [];
            for (let i = 0; i < 50; i++) {
                if (i % 3 === 0) promises.push(client.autoDetectUserId());
                else if (i % 3 === 1) promises.push(client.getGameIdFromName("Overwatch 2"));
                else promises.push(client.getInventory());
            }

            const results = await Promise.all(promises);
            assert.equal(results.length, 50);
            for (const res of results) {
                assert.ok(res !== null && res !== undefined);
            }
        });
    });
});
