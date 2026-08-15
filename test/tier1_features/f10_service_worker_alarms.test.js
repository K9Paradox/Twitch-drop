import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 1: Feature 10 - Service Worker Hydration & Alarms", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F10-T1: Alarms manager registers all 4 service worker periodic alarms", async () => {
        sandbox.chrome.alarms.create("watchdogAlarm", { periodInMinutes: 0.5 });
        sandbox.chrome.alarms.create("dropCheckAlarm", { periodInMinutes: 3 });
        sandbox.chrome.alarms.create("tokenRefreshAlarm", { periodInMinutes: 15 });
        sandbox.chrome.alarms.create("badgeRefreshAlarm", { periodInMinutes: 10 });

        const allAlarms = await sandbox.chrome.alarms.getAll();
        assert.equal(allAlarms.length, 4);
        assert.ok(allAlarms.some(a => a.name === "watchdogAlarm" && a.periodInMinutes === 0.5));
        assert.ok(allAlarms.some(a => a.name === "dropCheckAlarm" && a.periodInMinutes === 3));
        assert.ok(allAlarms.some(a => a.name === "tokenRefreshAlarm" && a.periodInMinutes === 15));
        assert.ok(allAlarms.some(a => a.name === "badgeRefreshAlarm" && a.periodInMinutes === 10));
    });

    it("F10-T2: Storage hydration restores settings, stats, and activeStream from chrome.storage.local", async () => {
        await sandbox.chrome.storage.local.set({
            settings: { autoRefresh: true, autoMute: true, lowQualityMode: true },
            extStats: { claimedDrops: 12, claimedPoints: 450 },
            activeStream: { campaign: { id: "camp-1", status: "watching" } },
            autoDropGames: ["Overwatch 2", "Valorant"]
        });

        const hydrated = await sandbox.chrome.storage.local.get([
            "settings",
            "extStats",
            "activeStream",
            "autoDropGames"
        ]);

        assert.equal(hydrated.settings.autoRefresh, true);
        assert.equal(hydrated.extStats.claimedDrops, 12);
        assert.equal(hydrated.activeStream.campaign.id, "camp-1");
        assert.deepEqual(hydrated.autoDropGames, ["Overwatch 2", "Valorant"]);
    });

    it("F10-T3: Cookie manager retrieves auth-token and unique_id cookies", async () => {
        await sandbox.chrome.cookies.set({
            url: "https://www.twitch.tv",
            name: "auth-token",
            value: "oauth_test_cookie_123",
            domain: ".twitch.tv"
        });
        await sandbox.chrome.cookies.set({
            url: "https://www.twitch.tv",
            name: "unique_id",
            value: "device_test_cookie_456",
            domain: ".twitch.tv"
        });

        const authCookie = await sandbox.chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" });
        const deviceCookie = await sandbox.chrome.cookies.get({ url: "https://www.twitch.tv", name: "unique_id" });

        assert.ok(authCookie);
        assert.equal(authCookie.value, "oauth_test_cookie_123");
        assert.ok(deviceCookie);
        assert.equal(deviceCookie.value, "device_test_cookie_456");
    });

    it("F10-T4: Alarm event dispatcher triggers registered alarm listeners", async () => {
        let triggeredAlarm = null;
        sandbox.chrome.alarms.onAlarm.addListener((alarm) => {
            triggeredAlarm = alarm.name;
        });

        sandbox.chrome.alarms.create("watchdogAlarm", { periodInMinutes: 0.5 });
        await sandbox.chrome.alarms.trigger("watchdogAlarm");

        assert.equal(triggeredAlarm, "watchdogAlarm");
    });

    it("F10-T5: Notifications API creates desktop notifications with correct metadata", () => {
        const notifId = sandbox.chrome.notifications.create("drop-claimed-1", {
            type: "basic",
            iconUrl: "assets/img/atd-128.png",
            title: "Drop Claimed",
            message: "Kiriko Mythic Skin has been claimed!"
        });

        assert.equal(notifId, "drop-claimed-1");
        assert.equal(sandbox.chrome._notifications.length, 1);
        assert.equal(sandbox.chrome._notifications[0].title, "Drop Claimed");
    });
});
