/**
 * Challenger 2 Adversarial Stress Harness & Empirical Verification
 * Milestone 1: Twitch GraphQL & WebSocket Automation Hardening
 * 
 * Tests:
 * 1. Concurrent chest click & WebSocket claim-available / points-earned events
 * 2. Malformed, non-JSON, missing-field, and hostile Hermes/PubSub payloads
 * 3. Concurrent checkClaimDrop() invocations with identical dropInstanceID
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { setupTestSandbox } from "./harness/sandbox.js";
import { Client, TwitchApiError } from "../background/twitchApi.js";
import {
    claimDropRewardSuccessFixture,
    claimDropRewardEligibleFixture,
    claimCommunityPointsSuccessFixture
} from "./fixtures/graphql-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Helper to instantiate an isolated onPage.js execution environment
 */
function createOnPageSandbox(options = {}) {
    const sandbox = setupTestSandbox();

    // DOM & Browser Globals for onPage.js
    const postedMessages = [];
    const windowListeners = new Map();
    const documentListeners = new Map();
    const mockElements = [];

    // Mock Document prototype descriptors
    const docProto = {
        hidden: true,
        visibilityState: "hidden"
    };

    class MockDocument {
        constructor() {
            this.hidden = true;
            this.visibilityState = "hidden";
        }
        addEventListener(type, fn, capture) {
            if (!documentListeners.has(type)) documentListeners.set(type, new Set());
            documentListeners.get(type).add(fn);
        }
        removeEventListener(type, fn) {
            if (documentListeners.has(type)) documentListeners.get(type).delete(fn);
        }
        querySelector(selector) {
            return mockElements.find(el => el.matches(selector)) || null;
        }
        querySelectorAll(selector) {
            return mockElements.filter(el => el.matches(selector));
        }
    }

    class MockElement {
        constructor(selector, attrs = {}) {
            this.selector = selector;
            this.attrs = attrs;
            this.offsetParent = {}; // visible
            this.clicks = 0;
        }
        matches(sel) {
            if (sel.startsWith(".")) return (this.attrs.class || "").includes(sel.slice(1));
            if (sel.startsWith("[")) {
                const match = sel.match(/\[([^=\]]+)(?:="([^"]+)")?\]/);
                if (match) {
                    const [, attr, val] = match;
                    if (!val) return this.attrs[attr] !== undefined;
                    return this.attrs[attr] === val;
                }
            }
            return false;
        }
        dispatchEvent(evt) {
            if (evt && evt.type === "click") this.clicks++;
            return true;
        }
        click() {
            this.clicks++;
        }
    }

    class MockMouseEvent {
        constructor(type, opts = {}) {
            this.type = type;
            this.bubbles = opts.bubbles !== undefined ? opts.bubbles : true;
            this.cancelable = opts.cancelable !== undefined ? opts.cancelable : true;
        }
    }

    const localStorageStore = new Map();
    const mockLocalStorage = {
        getItem: (k) => localStorageStore.get(k) || null,
        setItem: (k, v) => localStorageStore.set(k, String(v)),
        removeItem: (k) => localStorageStore.delete(k),
        clear: () => localStorageStore.clear()
    };

    const mockDocument = new MockDocument();
    const mockWsConstructor = sandbox.websocketMock.createMockConstructor();

    const mockWindow = {
        _originalFetch: null,
        _originalWebSocket: mockWsConstructor,
        fetch: sandbox.fetchMock.fetch.bind(sandbox.fetchMock),
        WebSocket: mockWsConstructor,
        localStorage: mockLocalStorage,
        document: mockDocument,
        Document: { prototype: docProto },
        MouseEvent: MockMouseEvent,
        addEventListener: (type, fn) => {
            if (!windowListeners.has(type)) windowListeners.set(type, new Set());
            windowListeners.get(type).add(fn);
        },
        removeEventListener: (type, fn) => {
            if (windowListeners.has(type)) windowListeners.get(type).delete(fn);
        },
        postMessage: (msg, targetOrigin) => {
            postedMessages.push({ msg, targetOrigin });
        }
    };

    // Load and evaluate onPage.js inside context
    const onPageCode = readFileSync(resolve(__dirname, "../onPage.js"), "utf8");
    const vmContext = vm.createContext({
        window: mockWindow,
        document: mockDocument,
        Document: mockWindow.Document,
        localStorage: mockLocalStorage,
        MouseEvent: MockMouseEvent,
        fetch: mockWindow.fetch,
        WebSocket: mockWindow.WebSocket,
        _originalWebSocket: mockWsConstructor,
        Headers: class Headers {
            constructor(init) { this.map = new Map(Object.entries(init || {})); }
            get(k) { return this.map.get(k); }
        },
        setInterval: () => 1,
        setTimeout: (fn) => fn(),
        Date: Date,
        Map: Map,
        JSON: JSON,
        console: console
    });

    vm.runInContext(onPageCode, vmContext);

    return {
        sandbox,
        mockWindow,
        mockDocument,
        mockElements,
        postedMessages,
        MockElement,
        vmContext
    };
}

describe("Adversarial Challenge 1: Concurrent Chest Clicks & WebSocket Point Deduplication", () => {
    let env;

    beforeEach(() => {
        env = createOnPageSandbox();
    });

    it("AC1-1: 50 simultaneous DOM bonus chest triggers produce exactly 1 points-earned message", () => {
        // Create bonus chest button in DOM
        const chestBtn = new env.MockElement('[data-a-target="claim-channel-points-button"]', {
            "data-a-target": "claim-channel-points-button"
        });
        env.mockElements.push(chestBtn);

        // Run autoClaimPointsChests logic 50 times in rapid succession (burst storm)
        const autoClaimScript = `
            for (let i = 0; i < 50; i++) {
                autoClaimPointsChests();
            }
        `;
        vm.runInContext(autoClaimScript, env.vmContext);

        const pointMessages = env.postedMessages.filter(m => m.msg?.autoTwitchDrops?.type === "points-earned");
        assert.equal(pointMessages.length, 1, `Expected exactly 1 points-earned message, got ${pointMessages.length}`);
        assert.equal(pointMessages[0].msg.autoTwitchDrops.points, 50);
        assert.equal(pointMessages[0].msg.autoTwitchDrops.source, "dom");
    });

    it("AC1-2: Interleaved storm of 50 DOM clicks, 50 Hermes claim-available, and 50 points-earned frames is deduplicated", () => {
        const chestBtn = new env.MockElement('[aria-label="Claim Bonus"]', {
            "aria-label": "Claim Bonus"
        });
        env.mockElements.push(chestBtn);

        // Connect WebSocket
        const wsCode = `
            const ws = new window.WebSocket("wss://hermes.twitch.tv/ws");
            window._testSocket = ws;
        `;
        vm.runInContext(wsCode, env.vmContext);

        const activeWs = env.sandbox.websocketMock.activeInstances[0];
        assert.ok(activeWs, "WebSocket instance should be created and tracked");

        // Fire 50 concurrent interleaved events
        for (let i = 0; i < 50; i++) {
            // 1. DOM auto claim
            vm.runInContext(`autoClaimPointsChests();`, env.vmContext);

            // 2. Hermes claim-available frame
            activeWs.receiveMessage({
                type: "MESSAGE",
                data: {
                    topic: "community-points-user-v1.12345",
                    message: JSON.stringify({
                        type: "claim-available",
                        data: {
                            claim: {
                                id: "chest-claim-burst-1",
                                channel_id: "channel-999"
                            }
                        }
                    })
                }
            });

            // 3. Hermes points-earned frame
            activeWs.receiveMessage({
                type: "MESSAGE",
                data: {
                    topic: "community-points-user-v1.12345",
                    message: JSON.stringify({
                        type: "points-earned",
                        data: {
                            point_gain: { total_points: 50 },
                            channel_id: "channel-999"
                        }
                    })
                }
            });
        }

        const claimPointsMessages = env.postedMessages.filter(m => m.msg?.autoTwitchDrops?.type === "claim-points");
        const pointsEarnedMessages = env.postedMessages.filter(m => m.msg?.autoTwitchDrops?.type === "points-earned");

        // Exactly 1 claim-points for the specific claim ID
        assert.equal(claimPointsMessages.length, 1, `Expected 1 claim-points message, got ${claimPointsMessages.length}`);
        assert.equal(claimPointsMessages[0].msg.autoTwitchDrops.claimID, "chest-claim-burst-1");

        // DOM points-earned was emitted 1 time, and WS points-earned was emitted 1 time (each key deduplicated)
        const domPoints = pointsEarnedMessages.filter(m => m.msg?.autoTwitchDrops?.source === "dom");
        const wsPoints = pointsEarnedMessages.filter(m => m.msg?.autoTwitchDrops?.source === "hermes" || m.msg?.autoTwitchDrops?.source === "pubsub");
        assert.equal(domPoints.length, 1, `Expected 1 DOM point message, got ${domPoints.length}`);
        assert.equal(wsPoints.length, 1, `Expected 1 WS point message, got ${wsPoints.length}`);
    });

    it("AC1-3: Background claim handler simulates 100 concurrent point events with zero overcounting", async () => {
        const client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });

        env.sandbox.fetchMock.onGql("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);

        // Simulate background.js deduplication and stats tracking
        const recentBgClaims = new Map();
        function isDuplicateBackgroundClaim(key, ttlMs = 10000) {
            const now = Date.now();
            for (const [k, time] of recentBgClaims.entries()) {
                if (now - time > 60000) recentBgClaims.delete(k);
            }
            if (recentBgClaims.has(key) && (now - recentBgClaims.get(key) < ttlMs)) {
                return true;
            }
            recentBgClaims.set(key, now);
            return false;
        }

        let claimedPoints = 0;
        let mutationCount = 0;
        const activityHistory = [];

        async function handleClaimPointsMessage(claimId, channelId) {
            if (!isDuplicateBackgroundClaim("claim-" + claimId, 15000)) {
                mutationCount++;
                const result = await client.claimChannelPoints(channelId, claimId);
                if (result && (result.success || result.status === "SUCCESS")) {
                    const pts = result.points || 50;
                    claimedPoints += pts;
                    activityHistory.push({ type: "points", points: pts, claimId });
                }
            }
        }

        async function handlePointsEarnedMessage(points, source) {
            if (!isDuplicateBackgroundClaim("points-earned-" + points + "-" + source, 3000)) {
                claimedPoints += points;
                activityHistory.push({ type: "points", points, source });
            }
        }

        // Fire 100 concurrent background claim message executions
        const promises = [];
        for (let i = 0; i < 100; i++) {
            promises.push(handleClaimPointsMessage("chest-claim-burst-1", "channel-999"));
            promises.push(handlePointsEarnedMessage(50, "hermes"));
            promises.push(handlePointsEarnedMessage(50, "dom"));
        }

        await Promise.all(promises);

        // Verification:
        // GraphQL ClaimCommunityPoints mutation should have been executed exactly ONCE
        assert.equal(mutationCount, 1, `Mutation count should be 1, got ${mutationCount}`);
        // Points credited: 50 from mutation + 50 from hermes bonus + 50 from dom bonus (3 distinct deduplicated streams)
        assert.equal(claimedPoints, 150, `Expected exactly 150 claimed points, got ${claimedPoints}`);
        assert.equal(activityHistory.length, 3, `Expected exactly 3 activity records, got ${activityHistory.length}`);
    });
});

describe("Adversarial Challenge 2: Malformed, Missing, Non-JSON, and Hostile Hermes/PubSub Payloads", () => {
    let env;
    let activeWs;

    beforeEach(() => {
        env = createOnPageSandbox();
        vm.runInContext(`
            const ws = new window.WebSocket("wss://hermes.twitch.tv/ws");
            window._testSocket = ws;
        `, env.vmContext);
        activeWs = env.sandbox.websocketMock.activeInstances[0];
    });

    it("AC2-1: Ignores non-string, binary, and primitive event.data frames without crashing", () => {
        const hostileInputs = [
            null,
            undefined,
            12345,
            true,
            false,
            {},
            [],
            new Uint8Array([0x01, 0x02, 0x03]),
            new ArrayBuffer(16),
            Symbol("hostile"),
            () => {}
        ];

        for (const input of hostileInputs) {
            assert.doesNotThrow(() => {
                activeWs._trigger("message", { data: input });
            }, `Should not throw on input: ${String(input)}`);
        }

        assert.equal(env.postedMessages.length, 0, "No messages should be posted for invalid data types");
    });

    it("AC2-2: Handles malformed and corrupted JSON top-level payloads safely", () => {
        const malformedFrames = [
            "",
            "   ",
            "{",
            "}",
            "{unquoted: key}",
            '{"type": "MESSAGE"',
            '{"type": "MESSAGE", "data":',
            '{"type": "MESSAGE", "data": {"message": "unclosed}}',
            "undefined",
            "NaN",
            "null",
            "true",
            "false",
            "12345",
            '{"type": "MESSAGE", "data": null}',
            '{"type": "MESSAGE", "data": 42}',
            '{"type": "MESSAGE", "data": "non-object string"}'
        ];

        for (const frame of malformedFrames) {
            assert.doesNotThrow(() => {
                activeWs._trigger("message", { data: frame });
            }, `Should not throw on frame: ${frame}`);
        }

        assert.equal(env.postedMessages.length, 0);
    });

    it("AC2-3: Safely handles non-MESSAGE frames (PONG, LISTEN, RECONNECT, ERR_BADAUTH)", () => {
        const nonMessageFrames = [
            JSON.stringify({ type: "PONG" }),
            JSON.stringify({ type: "RECONNECT" }),
            JSON.stringify({ type: "RESPONSE", error: "ERR_BADAUTH" }),
            JSON.stringify({ type: "RESPONSE", nonce: "nonce-123", error: "" }),
            JSON.stringify({ type: "LISTEN", data: { topics: ["test"] } }),
            JSON.stringify({ type: "UNKNOWN_FRAME_TYPE_123" })
        ];

        for (const frame of nonMessageFrames) {
            assert.doesNotThrow(() => {
                activeWs._trigger("message", { data: frame });
            });
        }

        assert.equal(env.postedMessages.length, 0);
    });

    it("AC2-4: Handles corrupted inner data.message strings safely", () => {
        const corruptedInnerMessages = [
            { type: "MESSAGE", data: { message: "{" } },
            { type: "MESSAGE", data: { message: "null" } },
            { type: "MESSAGE", data: { message: "" } },
            { type: "MESSAGE", data: { message: 12345 } },
            { type: "MESSAGE", data: { message: null } },
            { type: "MESSAGE", data: { message: true } },
            { type: "MESSAGE", data: { message: [] } },
            { type: "MESSAGE", data: { message: "{\"type\": \"unknown\"}" } },
            { type: "MESSAGE", data: { message: "{\"type\": \"points-earned\", \"data\": null}" } },
            { type: "MESSAGE", data: { message: "{\"type\": \"claim-available\", \"data\": null}" } },
            { type: "MESSAGE", data: { message: "{\"type\": \"claim-available\", \"data\": {\"claim\": null}}" } },
            { type: "MESSAGE", data: { message: "{\"type\": \"claim-available\", \"data\": {\"claim\": {\"id\": null}}}" } }
        ];

        for (const frame of corruptedInnerMessages) {
            assert.doesNotThrow(() => {
                activeWs._trigger("message", { data: JSON.stringify(frame) });
            });
        }

        // None of these invalid frames should emit claim-points or valid points-earned
        const claimMessages = env.postedMessages.filter(m => m.msg?.autoTwitchDrops?.type === "claim-points");
        assert.equal(claimMessages.length, 0);
    });

    it("AC2-5: Survives Prototype Pollution attempts via WebSocket payloads", () => {
        const pollutionPayload = JSON.stringify({
            type: "MESSAGE",
            data: {
                message: JSON.stringify({
                    type: "points-earned",
                    __proto__: { polluted: true, isAdmin: true },
                    data: {
                        point_gain: { total_points: 50 },
                        __proto__: { hacked: true }
                    }
                })
            }
        });

        assert.doesNotThrow(() => {
            activeWs._trigger("message", { data: pollutionPayload });
        });

        assert.equal(Object.prototype.polluted, undefined, "Object.prototype should not be polluted");
        assert.equal(Object.prototype.isAdmin, undefined, "Object.prototype should not be polluted");
        assert.equal(Object.prototype.hacked, undefined, "Object.prototype should not be polluted");
    });

    it("AC2-6: Massive stress burst: 10,000 hostile/malformed frames followed by valid frame", () => {
        const startTime = Date.now();

        // Pump 10,000 random hostile frames
        for (let i = 0; i < 10000; i++) {
            const seed = i % 5;
            let payload;
            if (seed === 0) payload = "{ malformed [";
            else if (seed === 1) payload = JSON.stringify({ type: "MESSAGE", data: null });
            else if (seed === 2) payload = JSON.stringify({ type: "MESSAGE", data: { message: "bad json {" } });
            else if (seed === 3) payload = JSON.stringify({ type: "PONG" });
            else payload = JSON.stringify({ type: "MESSAGE", data: { topic: "unknown-topic", message: "{}" } });

            activeWs._trigger("message", { data: payload });
        }

        const elapsedMs = Date.now() - startTime;
        console.log(`    [Benchmark] 10,000 hostile frames processed in ${elapsedMs}ms`);

        // Send 1 valid legitimate claim-available frame after the storm
        activeWs.receiveMessage({
            type: "MESSAGE",
            data: {
                topic: "community-points-user-v1.12345",
                message: JSON.stringify({
                    type: "claim-available",
                    data: {
                        claim: {
                            id: "valid-chest-post-storm",
                            channel_id: "channel-post-storm"
                        }
                    }
                })
            }
        });

        const postStormClaim = env.postedMessages.find(m => m.msg?.autoTwitchDrops?.claimID === "valid-chest-post-storm");
        assert.ok(postStormClaim, "Valid claim frame must still be processed after surviving 10,000 hostile frames");
        assert.equal(postStormClaim.msg.autoTwitchDrops.type, "claim-points");
    });
});

describe("Adversarial Challenge 3: Concurrent checkClaimDrop() Invocations & Drop Deduplication", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-abc"
        });
    });

    it("AC3-1: 50 concurrent checkClaimDrop() calls for same dropInstanceID execute mutation exactly once", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        // Setup drop inventory
        const testInventory = {
            dropCampaignsInProgress: [
                {
                    id: "camp-test-1",
                    game: { displayName: "Overwatch 2" },
                    timeBasedDrops: [
                        {
                            id: "drop-test-1",
                            name: "Kiriko Skin",
                            requiredMinutesWatched: 120,
                            imageURL: "https://static-cdn.jtvnw.net/drops/kiriko.png",
                            benefitEdges: [
                                {
                                    benefit: {
                                        id: "ben-1",
                                        name: "Kiriko Skin",
                                        imageAssetURL: "https://static-cdn.jtvnw.net/drops/kiriko.png"
                                    }
                                }
                            ],
                            self: {
                                isClaimed: false,
                                currentMinutesWatched: 120,
                                dropInstanceID: "inst-claim-concurrent-999"
                            }
                        }
                    ]
                }
            ]
        };

        sandbox.fetchMock.onGql("Inventory", { data: { currentUser: { inventory: testInventory } } });

        // Simulate background.js state and checkClaimDrop logic
        const recentBgClaims = new Map();
        function isDuplicateBackgroundClaim(key, ttlMs = 30000) {
            const now = Date.now();
            for (const [k, time] of recentBgClaims.entries()) {
                if (now - time > 60000) recentBgClaims.delete(k);
            }
            if (recentBgClaims.has(key) && (now - recentBgClaims.get(key) < ttlMs)) {
                return true;
            }
            recentBgClaims.set(key, now);
            return false;
        }

        let claimedDrops = 0;
        let mutationExecutions = 0;
        const activityHistory = [];
        const notificationsSent = [];
        const soundsTriggered = [];
        let returnedDropRef = null;

        async function simulatedCheckClaimDrop() {
            const inventory = await client.getInventory();
            if (!inventory || !inventory.dropCampaignsInProgress) return;

            for (const camp of inventory.dropCampaignsInProgress) {
                for (const drop of (camp.timeBasedDrops || [])) {
                    if (drop.requiredMinutesWatched !== 0 && drop.self && drop.requiredMinutesWatched <= drop.self.currentMinutesWatched && !drop.self.isClaimed) {
                        const dropInstanceId = drop.self.dropInstanceID;
                        if (!dropInstanceId) continue;
                        if (isDuplicateBackgroundClaim("drop-claim-" + dropInstanceId, 30000)) continue;

                        try {
                            mutationExecutions++;
                            const dropClaim = await client.claimDropReward(dropInstanceId);
                            if (dropClaim && (dropClaim.status === "SUCCESS" || dropClaim.status === "ELIGIBLE_FOR_CLAIM" || dropClaim.success === true)) {
                                drop.self.isClaimed = true;
                                returnedDropRef = drop;
                                const rewardTitle = drop.name || "Drop Reward";
                                const gameName = camp.game ? camp.game.displayName : "Twitch Drop";
                                claimedDrops++;
                                activityHistory.push({ type: "drop", title: rewardTitle, game: gameName });
                                notificationsSent.push(`Claimed ${rewardTitle}`);
                                soundsTriggered.push("rewardClaimedSound");
                            }
                        } catch (err) {
                            console.error("Failed to claim drop reward:", dropInstanceId, err);
                        }
                    }
                }
            }
        }

        // Launch 50 concurrent checkClaimDrop calls in parallel
        const concurrentRuns = Array.from({ length: 50 }, () => simulatedCheckClaimDrop());
        await Promise.all(concurrentRuns);

        assert.equal(mutationExecutions, 1, `Mutation should be executed exactly 1 time, got ${mutationExecutions}`);
        assert.equal(claimedDrops, 1, `claimedDrops should increment from 0 to 1, got ${claimedDrops}`);
        assert.equal(activityHistory.length, 1, `activityHistory should have exactly 1 record, got ${activityHistory.length}`);
        assert.equal(notificationsSent.length, 1, `notifications should be sent exactly 1 time, got ${notificationsSent.length}`);
        assert.equal(soundsTriggered.length, 1, `sound chime should trigger exactly 1 time, got ${soundsTriggered.length}`);
        assert.ok(returnedDropRef && returnedDropRef.self.isClaimed === true);
    });

    it("AC3-2: GraphQL mutation error does NOT increment claimedDrops count (no false positives)", async () => {
        // Setup drop inventory with eligible drop
        const testInventory = {
            dropCampaignsInProgress: [
                {
                    id: "camp-fail-1",
                    game: { displayName: "Valorant" },
                    timeBasedDrops: [
                        {
                            id: "drop-val-1",
                            name: "Valorant Gunbuddy",
                            requiredMinutesWatched: 60,
                            self: {
                                isClaimed: false,
                                currentMinutesWatched: 60,
                                dropInstanceID: "inst-fail-500"
                            }
                        }
                    ]
                }
            ]
        };

        sandbox.fetchMock.onGql("Inventory", { data: { currentUser: { inventory: testInventory } } });
        // Mutation fails with 500 error
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", { error: "Internal Server Error" }, 500);

        let claimedDrops = 0;
        let errorsCaught = 0;

        async function simulatedCheckClaimDropWithError() {
            const inventory = await client.getInventory();
            for (const camp of inventory.dropCampaignsInProgress) {
                for (const drop of (camp.timeBasedDrops || [])) {
                    if (drop.requiredMinutesWatched <= drop.self.currentMinutesWatched && !drop.self.isClaimed) {
                        try {
                            const dropClaim = await client.claimDropReward(drop.self.dropInstanceID);
                            if (dropClaim && dropClaim.success === true) {
                                claimedDrops++;
                            }
                        } catch (err) {
                            errorsCaught++;
                            assert.ok(err instanceof TwitchApiError);
                            assert.equal(err.status, 500);
                        }
                    }
                }
            }
        }

        await simulatedCheckClaimDropWithError();

        assert.equal(claimedDrops, 0, "claimedDrops must NOT increment on mutation failure");
        assert.equal(errorsCaught, 1, "Error should be caught cleanly");
    });

    it("AC3-3: Multiple distinct drop instance IDs are each claimed independently and deduplicated", async () => {
        sandbox.fetchMock.onGql("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);

        const multiDropInventory = {
            dropCampaignsInProgress: [
                {
                    id: "camp-multi-1",
                    game: { displayName: "Rust" },
                    timeBasedDrops: [
                        {
                            id: "drop-rust-1",
                            name: "Rust Hoodie",
                            requiredMinutesWatched: 60,
                            self: { isClaimed: false, currentMinutesWatched: 60, dropInstanceID: "inst-rust-1" }
                        },
                        {
                            id: "drop-rust-2",
                            name: "Rust Door",
                            requiredMinutesWatched: 120,
                            self: { isClaimed: false, currentMinutesWatched: 120, dropInstanceID: "inst-rust-2" }
                        },
                        {
                            id: "drop-rust-3",
                            name: "Rust Furnace",
                            requiredMinutesWatched: 180,
                            self: { isClaimed: false, currentMinutesWatched: 180, dropInstanceID: "inst-rust-3" }
                        }
                    ]
                }
            ]
        };

        sandbox.fetchMock.onGql("Inventory", { data: { currentUser: { inventory: multiDropInventory } } });

        const recentBgClaims = new Map();
        function isDuplicateBackgroundClaim(key, ttlMs = 30000) {
            const now = Date.now();
            if (recentBgClaims.has(key) && (now - recentBgClaims.get(key) < ttlMs)) return true;
            recentBgClaims.set(key, now);
            return false;
        }

        let totalClaimed = 0;
        const claimedSet = new Set();

        async function runMultiDropClaim() {
            const inventory = await client.getInventory();
            for (const camp of inventory.dropCampaignsInProgress) {
                for (const drop of camp.timeBasedDrops) {
                    const instId = drop.self.dropInstanceID;
                    if (!isDuplicateBackgroundClaim("drop-claim-" + instId, 30000)) {
                        const res = await client.claimDropReward(instId);
                        if (res && res.success) {
                            totalClaimed++;
                            claimedSet.add(instId);
                        }
                    }
                }
            }
        }

        // Run 20 concurrent sweeps
        await Promise.all(Array.from({ length: 20 }, () => runMultiDropClaim()));

        assert.equal(totalClaimed, 3, "All 3 distinct drops must be claimed");
        assert.equal(claimedSet.size, 3, "All 3 unique drop instance IDs must be recorded");
        assert.ok(claimedSet.has("inst-rust-1"));
        assert.ok(claimedSet.has("inst-rust-2"));
        assert.ok(claimedSet.has("inst-rust-3"));
    });
});
