/**
 * Test Sandbox Environment Coordinator
 * Sets up global chrome, fetch, WebSocket, and window mocks before tests
 */

import { chromeMock } from "./chrome-mock.js";
import { fetchMock } from "./fetch-mock.js";
import { websocketMock } from "./websocket-mock.js";
import { domMock } from "./dom-mock.js";

export function setupTestSandbox() {
    chromeMock.reset();
    fetchMock.reset();
    websocketMock.reset();
    domMock.reset();

    // Assign to globals
    globalThis.chrome = chromeMock;
    globalThis.fetch = fetchMock.fetch.bind(fetchMock);
    globalThis.WebSocket = websocketMock.createMockConstructor();
    globalThis.window = domMock.window;
    globalThis.document = domMock.document;
    globalThis.localStorage = domMock.localStorage;

    return {
        chrome: chromeMock,
        fetchMock: fetchMock,
        websocketMock: websocketMock,
        domMock: domMock
    };
}

export function resetTestSandbox() {
    chromeMock.reset();
    fetchMock.reset();
    websocketMock.reset();
    domMock.reset();
}
