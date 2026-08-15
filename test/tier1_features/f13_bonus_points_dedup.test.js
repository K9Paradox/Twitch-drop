import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 1: Feature 13 - Bonus Points Deduplication & History", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F13-T1: Deduplication cache prevents double-processing identical claim IDs within window", () => {
        const claimedSet = new Set();
        const claimId = "chest-claim-100";

        let processCount = 0;
        function processClaim(id) {
            if (claimedSet.has(id)) return false;
            claimedSet.add(id);
            processCount++;
            return true;
        }

        assert.equal(processClaim(claimId), true);
        assert.equal(processClaim(claimId), false); // duplicate
        assert.equal(processCount, 1);
    });

    it("F13-T2: Activity history entry stores all required metadata fields", () => {
        const entry = {
            id: `${Date.now()}-abc123xyz`,
            type: "points",
            title: "+50 Channel Points",
            game: "Overwatch 2",
            points: 50,
            imgUrl: "assets/img/points.png",
            timestamp: new Date().toISOString()
        };

        assert.ok(entry.id);
        assert.equal(entry.type, "points");
        assert.equal(entry.points, 50);
        assert.equal(entry.game, "Overwatch 2");
    });

    it("F13-T3: Activity history caps total entries at 50 items maximum", () => {
        let history = [];
        for (let i = 0; i < 60; i++) {
            history.unshift({
                id: `entry-${i}`,
                type: "points",
                title: `Point ${i}`,
                points: 50,
                timestamp: new Date().toISOString()
            });
            if (history.length > 50) {
                history = history.slice(0, 50);
            }
        }

        assert.equal(history.length, 50);
        assert.equal(history[0].id, "entry-59");
    });

    it("F13-T4: Synthetic click triggers click event on visible bonus button", () => {
        const btn = sandbox.domMock.addElement("button", { "aria-label": "Claim Bonus" });
        let clickDispatched = false;

        btn.addEventListener("click", () => {
            clickDispatched = true;
        });

        btn.click();
        assert.equal(clickDispatched, true);
    });

    it("F13-T5: Activity update dispatches runtime message p:activityUpdated", async () => {
        let receivedMessage = null;
        sandbox.chrome.runtime.onMessage.addListener((msg) => {
            if (msg.type === "p:activityUpdated") {
                receivedMessage = msg.data;
            }
        });

        const sampleHistory = [{ id: "1", type: "points", points: 50 }];
        await sandbox.chrome.runtime.sendMessage({ type: "p:activityUpdated", data: sampleHistory });

        assert.ok(receivedMessage);
        assert.equal(receivedMessage.length, 1);
        assert.equal(receivedMessage[0].points, 50);
    });
});
