import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 1: Feature 14 - Popup State Sync & Storage Reactivity", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F14-T1: storage.onChanged fires listener whenever local storage changes", async () => {
        let detectedChanges = null;
        sandbox.chrome.storage.onChanged.addListener((changes, area) => {
            if (area === "local") {
                detectedChanges = changes;
            }
        });

        await sandbox.chrome.storage.local.set({
            activeStream: { campaign: { id: "camp-ow-1", status: "watching" } }
        });

        assert.ok(detectedChanges);
        assert.ok(detectedChanges.activeStream);
        assert.equal(detectedChanges.activeStream.newValue.campaign.id, "camp-ow-1");
    });

    it("F14-T2: Action badge reflects progress percentage or active count", () => {
        sandbox.chrome.action.setBadgeText({ text: "75%" });
        sandbox.chrome.action.setBadgeBackgroundColor({ color: "#9146FF" });

        assert.equal(sandbox.chrome._badgeText, "75%");
        assert.equal(sandbox.chrome._badgeColor, "#9146FF");
    });

    it("F14-T3: Settings changes sync into chrome.storage.local", async () => {
        const newSettings = {
            autoRefresh: false,
            autoMute: true,
            lowQualityMode: true,
            desktopNotifications: false
        };

        await sandbox.chrome.storage.local.set({ settings: newSettings });
        const retrieved = await sandbox.chrome.storage.local.get("settings");

        assert.equal(retrieved.settings.autoRefresh, false);
        assert.equal(retrieved.settings.desktopNotifications, false);
    });

    it("F14-T4: Runtime message p:sendCurrentDrops communicates active drops to popup", async () => {
        let received = null;
        sandbox.chrome.runtime.onMessage.addListener((msg) => {
            if (msg.type === "p:sendCurrentDrops") {
                received = msg.data;
            }
        });

        const activeDropPayload = {
            activeStream: {
                campaign: { id: "camp-ow-1", minutesWatched: 60, minutesNeeded: 120 }
            }
        };

        await sandbox.chrome.runtime.sendMessage({
            type: "p:sendCurrentDrops",
            data: activeDropPayload
        });

        assert.ok(received);
        assert.equal(received.activeStream.campaign.id, "camp-ow-1");
    });

    it("F14-T5: Queue toggle updates autoDropGames in persistent storage", async () => {
        const queue = ["Valorant", "Apex Legends", "Overwatch 2"];
        await sandbox.chrome.storage.local.set({ autoDropGames: queue });

        const stored = await sandbox.chrome.storage.local.get("autoDropGames");
        assert.equal(stored.autoDropGames.length, 3);
        assert.equal(stored.autoDropGames[1], "Apex Legends");
    });
});
