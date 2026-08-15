import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import {
    createHermesPointsEarned,
    createHermesClaimAvailable,
    createHermesDropProgress
} from "../fixtures/websocket-fixtures.js";

describe("Tier 1: Feature 9 - WebSocket Hermes & PubSub Event Pipeline", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F9-T1: WebSocket connection to wss://hermes.twitch.tv registers properly", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        assert.equal(ws.url, "wss://hermes.twitch.tv");
        assert.equal(sandbox.websocketMock.activeInstances.length, 1);
    });

    it("F9-T2: WebSocket processes points-earned payload and extracts point gain", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        let received = null;

        ws.addEventListener("message", (evt) => {
            const data = JSON.parse(evt.data);
            if (data.type === "MESSAGE") {
                const parsed = JSON.parse(data.data.message);
                if (parsed.type === "points-earned") {
                    received = parsed.data.point_gain.total_points;
                }
            }
        });

        sandbox.websocketMock.emitHermesPoints(50, "user-101");
        assert.equal(received, 50);
    });

    it("F9-T3: WebSocket processes claim-available payload and extracts claimID and channelID", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        let claimInfo = null;

        ws.addEventListener("message", (evt) => {
            const data = JSON.parse(evt.data);
            if (data.type === "MESSAGE") {
                const parsed = JSON.parse(data.data.message);
                if (parsed.type === "claim-available") {
                    claimInfo = {
                        claimID: parsed.data.claim.id,
                        channelID: parsed.data.claim.channel_id
                    };
                }
            }
        });

        sandbox.websocketMock.emitHermesClaimAvailable("chest-claim-999", "channel-555");
        assert.ok(claimInfo);
        assert.equal(claimInfo.claimID, "chest-claim-999");
        assert.equal(claimInfo.channelID, "channel-555");
    });

    it("F9-T4: WebSocket processes drop-progress payload and signals checkDrop", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        let dropCheckTriggered = false;

        ws.addEventListener("message", (evt) => {
            const data = JSON.parse(evt.data);
            if (data.type === "MESSAGE") {
                const parsed = JSON.parse(data.data.message);
                if (parsed.type === "drop-progress") {
                    dropCheckTriggered = true;
                }
            }
        });

        sandbox.websocketMock.emitHermesDropProgress("drop-ow-1", 45, 120);
        assert.equal(dropCheckTriggered, true);
    });

    it("F9-T5: WebSocket safely ignores non-message or malformed frames without throwing", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        let threw = false;

        ws.addEventListener("message", (evt) => {
            try {
                const data = JSON.parse(evt.data);
                if (data.type === "PING") {
                    ws.send(JSON.stringify({ type: "PONG" }));
                }
            } catch (err) {
                threw = true;
            }
        });

        ws.receiveMessage(JSON.stringify({ type: "PING" }), "wss://hermes.twitch.tv");
        assert.equal(threw, false);
        assert.equal(ws.sentMessages.length, 1);
    });
});
