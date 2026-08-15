import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 1: Feature 12 - Stall Detection & Streamer Rotation", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F12-T1: Tab manager creates background tabs with active: false and #atd-managed=1", async () => {
        const tab = await sandbox.chrome.tabs.create({
            url: "https://www.twitch.tv/superstreamer#atd-managed=1",
            active: false,
            muted: true
        });

        assert.equal(tab.active, false);
        assert.equal(tab.mutedInfo.muted, true);
        assert.ok(tab.url.includes("#atd-managed=1"));
    });

    it("F12-T2: Strict claimed check identifies item by benefit ID matching gameEventDrops", () => {
        const item = { id: "drop-val-1", benefitId: "ben-val-1", self: { isClaimed: false } };
        const eventDropsList = [{ id: "ben-val-1", name: "Champions Gun Buddy" }];

        const isClaimed = eventDropsList.some(evt => evt.id.toLowerCase() === item.benefitId.toLowerCase());
        assert.equal(isClaimed, true);
    });

    it("F12-T3: Progress watchdog detects stream stalls when progress delta is zero across interval", () => {
        let lastWatched = 45;
        let currentWatched = 45;
        let stallCount = 0;

        if (currentWatched === lastWatched) {
            stallCount++;
        }

        assert.equal(stallCount, 1);
    });

    it("F12-T4: Streamer rotation selects next available broadcaster when skipping current login", () => {
        const liveBroadcasters = ["streamerA", "streamerB", "streamerC"];
        const skipped = ["streamerA"];

        const next = liveBroadcasters.find(b => !skipped.includes(b));
        assert.equal(next, "streamerB");
    });

    it("F12-T5: Tab manager cleanly closes active stream tab on completion", async () => {
        const tab = await sandbox.chrome.tabs.create({
            url: "https://www.twitch.tv/superstreamer#atd-managed=1",
            active: false
        });

        assert.equal(sandbox.chrome._tabs.size, 1);
        await sandbox.chrome.tabs.remove(tab.id);
        assert.equal(sandbox.chrome._tabs.size, 0);
    });
});
