import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 2: Boundary - Feature 14: Popup State Sync & Storage Reactivity", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F14-B1: storage.onChanged safely handles undefined newValue on key removal", async () => {
        let removedDetected = false;
        sandbox.chrome.storage.onChanged.addListener((changes) => {
            if (changes.tempKey && changes.tempKey.newValue === undefined) {
                removedDetected = true;
            }
        });

        await sandbox.chrome.storage.local.set({ tempKey: "testValue" });
        await sandbox.chrome.storage.local.remove("tempKey");

        assert.equal(removedDetected, true);
    });

    it("F14-B2: sendMessage handles missing listeners without unhandled promise rejection", async () => {
        await assert.doesNotReject(async () => {
            await sandbox.chrome.runtime.sendMessage({ type: "p:unhandledEvent" });
        });
    });

    it("F14-B3: Badge text updates handle empty string or null gracefully", () => {
        sandbox.chrome.action.setBadgeText({ text: "" });
        assert.equal(sandbox.chrome._badgeText, "");

        sandbox.chrome.action.setBadgeText({ text: null });
        assert.equal(sandbox.chrome._badgeText, null);
    });

    it("F14-B4: AutoDropGames queue setting update handles empty array", async () => {
        await sandbox.chrome.storage.local.set({ autoDropGames: [] });
        const stored = await sandbox.chrome.storage.local.get("autoDropGames");

        assert.ok(Array.isArray(stored.autoDropGames));
        assert.equal(stored.autoDropGames.length, 0);
    });

    it("F14-B5: Concurrent storage writes merge without data corruption", async () => {
        await Promise.all([
            sandbox.chrome.storage.local.set({ key1: "value1" }),
            sandbox.chrome.storage.local.set({ key2: "value2" }),
            sandbox.chrome.storage.local.set({ key3: "value3" })
        ]);

        const all = await sandbox.chrome.storage.local.get(["key1", "key2", "key3"]);
        assert.equal(all.key1, "value1");
        assert.equal(all.key2, "value2");
        assert.equal(all.key3, "value3");
    });
});
