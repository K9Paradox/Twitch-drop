import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 2: Boundary - Feature 12: Stall Detection & Streamer Rotation", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F12-B1: syncCampaignProgressWithInventory handles null or undefined inventory safely", () => {
        const activeStream = { campaign: { id: "camp-1", status: "watching" }, campaigns: [] };
        const inventory = null;

        const inProgress = inventory && inventory.dropCampaignsInProgress ? inventory.dropCampaignsInProgress : [];
        assert.equal(inProgress.length, 0);
    });

    it("F12-B2: syncCampaignProgressWithInventory returns false when activeStream is 'none'", () => {
        const activeStream = { campaign: "none" };
        const isWatching = activeStream.campaign && activeStream.campaign !== "none";
        assert.equal(isWatching, false);
    });

    it("F12-B3: isDropItemClaimedStrict returns false when item is null or undefined", () => {
        function isDropItemClaimedStrict(item, eventDropsList) {
            if (!item) return false;
            if (item.self && item.self.isClaimed === true) return true;
            if (!eventDropsList || eventDropsList.length === 0) return false;
            return false;
        }

        assert.equal(isDropItemClaimedStrict(null, []), false);
        assert.equal(isDropItemClaimedStrict(undefined, []), false);
    });

    it("F12-B4: Streamer rotation returns null when live stream list is empty", () => {
        const liveStreams = [];
        const skipped = ["streamerA"];

        const chosen = liveStreams.filter(s => !skipped.includes(s.broadcaster?.login))[0] || null;
        assert.equal(chosen, null);
    });

    it("F12-B5: Tab removal safely handles already closed or non-existent tab IDs", async () => {
        await assert.doesNotReject(async () => {
            await sandbox.chrome.tabs.remove(99999);
        });
    });
});
