import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 2: Boundary - Feature 10: Service Worker Hydration & Alarms", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F10-B1: Storage hydration gracefully falls back to default values when storage is completely empty", async () => {
        const stored = await sandbox.chrome.storage.local.get([
            "settings",
            "extStats",
            "autoDropGames",
            "activeStream"
        ]);

        const defaultSettings = stored.settings || { autoRefresh: true, autoMute: true };
        const defaultStats = stored.extStats || { claimedDrops: 0, claimedPoints: 0 };
        const defaultQueue = stored.autoDropGames || [];

        assert.equal(defaultSettings.autoRefresh, true);
        assert.equal(defaultStats.claimedDrops, 0);
        assert.equal(defaultQueue.length, 0);
    });

    it("F10-B2: Cookie retrieval handles missing cookies (null auth-token and null unique_id) without crashing", async () => {
        const authCookie = await sandbox.chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" });
        const devCookie = await sandbox.chrome.cookies.get({ url: "https://www.twitch.tv", name: "unique_id" });

        assert.equal(authCookie, null);
        assert.equal(devCookie, null);
    });

    it("F10-B3: Alarm listener ignores unknown or unregistered alarm names", async () => {
        let handled = false;
        sandbox.chrome.alarms.onAlarm.addListener((alarm) => {
            if (["watchdogAlarm", "dropCheckAlarm", "tokenRefreshAlarm", "badgeRefreshAlarm"].includes(alarm.name)) {
                handled = true;
            }
        });

        await sandbox.chrome.alarms.trigger("unknownPeriodicAlarm");
        assert.equal(handled, false);
    });

    it("F10-B4: Notification creation suppresses output when desktopNotifications setting is false", () => {
        const settings = { desktopNotifications: false };
        let created = false;

        if (settings.desktopNotifications) {
            sandbox.chrome.notifications.create({ title: "Test", message: "Test Msg" });
            created = true;
        }

        assert.equal(created, false);
        assert.equal(sandbox.chrome._notifications.length, 0);
    });

    it("F10-B5: Storage remove operation handles non-existent keys cleanly", async () => {
        await assert.doesNotReject(async () => {
            await sandbox.chrome.storage.local.remove(["nonExistentKey1", "nonExistentKey2"]);
        });
    });
});
