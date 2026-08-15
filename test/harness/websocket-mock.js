/**
 * Mock WebSocket Engine for Twitch Hermes & PubSub Event Pipelines
 */

import {
    createHermesPointsEarned,
    createHermesClaimAvailable,
    createHermesDropProgress
} from "../fixtures/websocket-fixtures.js";

export class MockWebSocketInstance {
    constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
        this.readyState = 1; // OPEN
        this._listeners = new Map();
        this.sentMessages = [];
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;

        websocketMock.activeInstances.push(this);
    }

    addEventListener(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);
    }

    removeEventListener(event, callback) {
        if (this._listeners.has(event)) {
            this._listeners.get(event).delete(callback);
        }
    }

    send(data) {
        this.sentMessages.push(data);
    }

    close(code = 1000, reason = "") {
        this.readyState = 3; // CLOSED
        const evt = { code, reason, wasClean: true };
        this._trigger("close", evt);
        if (typeof this.onclose === "function") this.onclose(evt);
        const idx = websocketMock.activeInstances.indexOf(this);
        if (idx >= 0) websocketMock.activeInstances.splice(idx, 1);
    }

    _trigger(event, data) {
        if (this._listeners.has(event)) {
            for (const fn of this._listeners.get(event)) {
                try {
                    fn(data);
                } catch (e) {
                    console.error(`Error in WebSocket listener for ${event}:`, e);
                }
            }
        }
    }

    receiveMessage(rawData, origin) {
        const originUrl = origin || (this.url.startsWith("wss://") ? this.url : "wss://hermes.twitch.tv");
        const event = {
            data: typeof rawData === "string" ? rawData : JSON.stringify(rawData),
            origin: originUrl,
            lastEventId: "",
            source: null,
            ports: []
        };
        this._trigger("message", event);
        if (typeof this.onmessage === "function") {
            this.onmessage(event);
        }
    }
}

export class WebSocketMock {
    constructor() {
        this.reset();
    }

    reset() {
        this.activeInstances = [];
    }

    createMockConstructor() {
        const self = this;
        return function MockWebSocket(url, protocols) {
            return new MockWebSocketInstance(url, protocols);
        };
    }

    emitHermesPoints(points = 50, channelId = "user-101") {
        const payload = createHermesPointsEarned(points, channelId);
        for (const inst of this.activeInstances) {
            inst.receiveMessage(payload, "wss://hermes.twitch.tv");
        }
    }

    emitHermesClaimAvailable(claimId = "chest-claim-100", channelId = "user-101") {
        const payload = createHermesClaimAvailable(claimId, channelId);
        for (const inst of this.activeInstances) {
            inst.receiveMessage(payload, "wss://hermes.twitch.tv");
        }
    }

    emitHermesDropProgress(dropId = "drop-ow-1", currentMinutes = 60, requiredMinutes = 120) {
        const payload = createHermesDropProgress(dropId, currentMinutes, requiredMinutes);
        for (const inst of this.activeInstances) {
            inst.receiveMessage(payload, "wss://hermes.twitch.tv");
        }
    }

    emitCustomMessage(urlPattern, rawData, origin) {
        for (const inst of this.activeInstances) {
            if (!urlPattern || inst.url.includes(urlPattern)) {
                inst.receiveMessage(rawData, origin);
            }
        }
    }
}

export const websocketMock = new WebSocketMock();
