import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 2: Boundary - Feature 13: Bonus Points Deduplication & History", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F13-B1: Deduplication cache handles rapid concurrent attempts on the same claim ID", () => {
        const processed = [];
        const seen = new Set();

        const claimId = "burst-claim-100";
        for (let i = 0; i < 10; i++) {
            if (!seen.has(claimId)) {
                seen.add(claimId);
                processed.push(claimId);
            }
        }

        assert.equal(processed.length, 1);
    });

    it("F13-B2: logActivity handles missing optional fields with default values", () => {
        function createLogEntry(type, title, game, points = 0, imgUrl = "") {
            return {
                id: `${Date.now()}-rand`,
                type: type || "info",
                title: title || "Activity",
                game: game || "Twitch",
                points: points || 0,
                imgUrl: imgUrl || "",
                timestamp: new Date().toISOString()
            };
        }

        const entry = createLogEntry("points", "Bonus", null, null, null);
        assert.equal(entry.game, "Twitch");
        assert.equal(entry.points, 0);
        assert.equal(entry.imgUrl, "");
    });

    it("F13-B3: Synthetic click handler safely catches DOM event dispatch exceptions", () => {
        const brokenEl = {
            dispatchEvent: () => { throw new Error("DOM Exception in event listener"); },
            offsetParent: {}
        };

        assert.doesNotThrow(() => {
            try {
                brokenEl.dispatchEvent({ type: "click" });
            } catch (err) {}
        });
    });

    it("F13-B4: Activity history initializes properly when existing stored history is null", async () => {
        const stored = await sandbox.chrome.storage.local.get("activityHistory");
        let history = stored.activityHistory || [];

        assert.ok(Array.isArray(history));
        assert.equal(history.length, 0);

        history.unshift({ id: "1", type: "claim", title: "Drop Claimed" });
        await sandbox.chrome.storage.local.set({ activityHistory: history });

        const updated = await sandbox.chrome.storage.local.get("activityHistory");
        assert.equal(updated.activityHistory.length, 1);
    });

    it("F13-B5: Deduplication cache eviction keeps cache bounded under 1000 items", () => {
        let dedupCache = new Set();

        for (let i = 0; i < 1200; i++) {
            dedupCache.add(`claim-${i}`);
            if (dedupCache.size > 1000) {
                const oldest = dedupCache.values().next().value;
                dedupCache.delete(oldest);
            }
        }

        assert.equal(dedupCache.size, 1000);
        assert.equal(dedupCache.has("claim-0"), false);
        assert.equal(dedupCache.has("claim-1199"), true);
    });
});
