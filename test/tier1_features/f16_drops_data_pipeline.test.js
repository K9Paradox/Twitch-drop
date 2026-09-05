import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";

describe("Tier 1: Feature 16 - Drops Data Pipeline & Inventory Normalization", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("F16-T1: postAuthorized() accepts partial GraphQL data when json.errors is present with valid json.data", async () => {
        const partialFixture = {
            data: {
                currentUser: {
                    id: "12345",
                    displayName: "TestUser",
                    login: "testuser"
                }
            },
            errors: [
                {
                    message: "Non-critical GraphQL resolution error in unrelated field",
                    path: ["someUnusedField"]
                }
            ]
        };

        sandbox.fetchMock.onGql("CoreActionsCurrentUser", partialFixture);

        const userId = await client.autoDetectUserId();
        assert.equal(userId, "12345");
    });

    it("F16-T2: getInventory() normalizes gameEventDropsConnection.edges into gameEventDrops array", async () => {
        const modernInventoryFixture = {
            data: {
                currentUser: {
                    inventory: {
                        dropCampaignsInProgress: [],
                        gameEventDropsConnection: {
                            edges: [
                                {
                                    node: {
                                        id: "claim-drop-101",
                                        name: "Overwatch Contenders Echo Skin",
                                        imageURL: "https://static-cdn.jtvnw.net/drops/echo-skin.png",
                                        game: {
                                            id: "515025",
                                            displayName: "Overwatch 2",
                                            name: "Overwatch 2"
                                        },
                                        lastAwardedAt: "2026-08-20T14:30:00Z"
                                    }
                                },
                                {
                                    node: {
                                        id: "claim-drop-102",
                                        name: "Valorant VCT Spray",
                                        imageURL: "https://static-cdn.jtvnw.net/drops/vct-spray.png",
                                        game: {
                                            id: "516575",
                                            displayName: "Valorant",
                                            name: "Valorant"
                                        },
                                        lastAwardedAt: "2026-08-19T10:15:00Z"
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        };

        sandbox.fetchMock.onGql("Inventory", modernInventoryFixture);

        const inventory = await client.getInventory();
        assert.ok(inventory);
        assert.ok(Array.isArray(inventory.gameEventDrops));
        assert.equal(inventory.gameEventDrops.length, 2);
        assert.equal(inventory.gameEventDrops[0].id, "claim-drop-101");
        assert.equal(inventory.gameEventDrops[0].name, "Overwatch Contenders Echo Skin");
        assert.equal(inventory.gameEventDrops[0].imageURL, "https://static-cdn.jtvnw.net/drops/echo-skin.png");
        assert.equal(inventory.gameEventDrops[0].game.displayName, "Overwatch 2");
        assert.equal(inventory.gameEventDrops[1].name, "Valorant VCT Spray");
    });

    it("F16-T3: getInventory() preserves legacy gameEventDrops array if already provided", async () => {
        const legacyInventoryFixture = {
            data: {
                currentUser: {
                    inventory: {
                        dropCampaignsInProgress: [],
                        gameEventDrops: [
                            {
                                id: "legacy-drop-1",
                                name: "Legacy Gun Buddy",
                                imageURL: "https://static-cdn.jtvnw.net/drops/legacy.png",
                                game: { name: "Apex Legends" }
                            }
                        ]
                    }
                }
            }
        };

        sandbox.fetchMock.onGql("Inventory", legacyInventoryFixture);

        const inventory = await client.getInventory();
        assert.ok(inventory);
        assert.ok(Array.isArray(inventory.gameEventDrops));
        assert.equal(inventory.gameEventDrops.length, 1);
        assert.equal(inventory.gameEventDrops[0].id, "legacy-drop-1");
        assert.equal(inventory.gameEventDrops[0].name, "Legacy Gun Buddy");
    });

    it("F16-T4: getDropCampaigns() handles campaigns without active drops cleanly", async () => {
        const dashboardFixture = {
            data: {
                currentUser: {
                    dropCampaigns: [
                        {
                            id: "camp-inactive-1",
                            name: "Overwatch 2 Past Campaign",
                            status: "EXPIRED",
                            game: {
                                id: "515025",
                                displayName: "Overwatch 2",
                                name: "Overwatch 2"
                            }
                        },
                        {
                            id: "camp-active-1",
                            name: "Rust Twitch Drops",
                            status: "ACTIVE",
                            game: {
                                id: "263490",
                                displayName: "Rust",
                                name: "Rust"
                            }
                        }
                    ]
                }
            }
        };

        sandbox.fetchMock.onGql("ViewerDropsDashboard", dashboardFixture);

        const dashboard = await client.getDropCampaigns();
        assert.ok(dashboard);
        assert.equal(dashboard.length, 2);
        assert.equal(dashboard[0].status, "EXPIRED");
        assert.equal(dashboard[1].status, "ACTIVE");
    });

    it("F16-T5: postAuthorized() throws when json.errors is present and json.data is empty or missing", async () => {
        const errorFixture = {
            errors: [
                {
                    message: "Must be authenticated",
                    path: ["currentUser"]
                }
            ],
            data: null
        };

        sandbox.fetchMock.onGql("CoreActionsCurrentUser", errorFixture);

        await assert.rejects(
            async () => {
                await client.postAuthorized({
                    operationName: "CoreActionsCurrentUser"
                });
            },
            {
                name: "TwitchApiError",
                message: /Must be authenticated/
            }
        );
    });
});
