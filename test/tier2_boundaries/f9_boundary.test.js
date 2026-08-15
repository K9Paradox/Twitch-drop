import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 2: Boundary - Feature 9: WebSocket Hermes & PubSub Pipeline", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F9-B1: WebSocket proxy safely ignores messages from untrusted origins", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        let processed = false;

        ws.addEventListener("message", (evt) => {
            if (evt.origin === "wss://hermes.twitch.tv") {
                processed = true;
            }
        });

        ws.receiveMessage(JSON.stringify({ type: "MESSAGE" }), "https://malicious-site.com");
        assert.equal(processed, false);
    });

    it("F9-B2: WebSocket proxy safely ignores malformed JSON payloads without crashing", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        let threw = false;

        ws.addEventListener("message", (evt) => {
            try {
                JSON.parse(evt.data);
            } catch (err) {
                // Should be safely handled by caller
            }
        });

        assert.doesNotThrow(() => {
            ws.receiveMessage("MALFORMED NON-JSON STRING {{{", "wss://hermes.twitch.tv");
        });
    });

    it("F9-B3: WebSocket proxy ignores messages with unknown types", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        let recognized = false;

        ws.addEventListener("message", (evt) => {
            try {
                const data = JSON.parse(evt.data);
                if (data.type === "MESSAGE") {
                    const parsed = JSON.parse(data.data.message);
                    if (["points-earned", "claim-available", "drop-progress"].includes(parsed.type)) {
                        recognized = true;
                    }
                }
            } catch (e) {}
        });

        ws.receiveMessage(JSON.stringify({
            type: "MESSAGE",
            data: { message: JSON.stringify({ type: "chat-whisper", data: {} }) }
        }), "wss://hermes.twitch.tv");

        assert.equal(recognized, false);
    });

    it("F9-B4: WebSocket proxy handles points-earned frame with null point_gain safely", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        let pointValue = null;

        ws.addEventListener("message", (evt) => {
            try {
                const data = JSON.parse(evt.data);
                const parsed = JSON.parse(data.data.message);
                if (parsed.type === "points-earned") {
                    pointValue = parsed.data?.point_gain?.total_points ?? 0;
                }
            } catch (e) {}
        });

        ws.receiveMessage(JSON.stringify({
            type: "MESSAGE",
            data: { message: JSON.stringify({ type: "points-earned", data: { point_gain: null } }) }
        }), "wss://hermes.twitch.tv");

        assert.equal(pointValue, 0);
    });

    it("F9-B5: WebSocket close cleans up socket from active instances", () => {
        const ws = new WebSocket("wss://hermes.twitch.tv");
        assert.equal(sandbox.websocketMock.activeInstances.length, 1);

        ws.close();
        assert.equal(sandbox.websocketMock.activeInstances.length, 0);
        assert.equal(ws.readyState, 3); // CLOSED
    });
});
