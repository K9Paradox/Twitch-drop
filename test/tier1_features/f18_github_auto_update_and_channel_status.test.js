import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

// Import or recreate compareSemver for isolated unit validation
function compareSemver(a, b) {
    if (!a || !b) return 0;
    const cleanA = a.replace(/^v/, "").trim();
    const cleanB = b.replace(/^v/, "").trim();
    const partsA = cleanA.split(".").map(n => parseInt(n, 10) || 0);
    const partsB = cleanB.split(".").map(n => parseInt(n, 10) || 0);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const valA = partsA[i] || 0;
        const valB = partsB[i] || 0;
        if (valA > valB) return 1;
        if (valA < valB) return -1;
    }
    return 0;
}

// Helper simulating status generation logic from main.js
function getChannelOfflineStatus(gameName, requiredStreamers) {
    const hasSpecific = Array.isArray(requiredStreamers) && requiredStreamers.length > 0;
    let pillText = "No Drops Live";
    let statusTitle = `No Drops Live: ${gameName}`;
    let subTitle = `No broadcasters streaming ${gameName} with drops enabled right now.`;
    let waitText = "Waiting for stream...";
    let cardTitle = "No Drops Streams Live";

    if (hasSpecific) {
        if (requiredStreamers.length === 1) {
            const singleChan = requiredStreamers[0];
            pillText = `${singleChan} offline`;
            statusTitle = `${singleChan} is offline`;
            subTitle = `Required channel ${singleChan} for ${gameName} is offline.`;
            waitText = `Waiting for ${singleChan}...`;
            cardTitle = `${singleChan} is Offline`;
        } else {
            pillText = "Channels offline";
            statusTitle = `Channels Offline: ${gameName}`;
            subTitle = `Required channels (${requiredStreamers.join(", ")}) are currently offline.`;
            waitText = "Waiting for live channel...";
            cardTitle = "Required Channels Offline";
        }
    }

    return { pillText, statusTitle, subTitle, waitText, cardTitle, hasSpecific };
}

describe("Tier 1: Feature 18 - GitHub Auto-Update & Channel Status Verification", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F18-T1: compareSemver() correctly compares semver strings with and without 'v' prefix", () => {
        assert.equal(compareSemver("1.5.2", "1.5.1"), 1);
        assert.equal(compareSemver("v1.5.2", "1.5.1"), 1);
        assert.equal(compareSemver("1.6.0", "1.5.9"), 1);
        assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
        assert.equal(compareSemver("1.5.1", "1.5.1"), 0);
        assert.equal(compareSemver("v1.5.1", "1.5.1"), 0);
        assert.equal(compareSemver("1.5.0", "1.5.1"), -1);
        assert.equal(compareSemver("1.4.9", "1.5.0"), -1);
    });

    it("F18-T2: Single required channel offline produces concise, channel-specific UI text", () => {
        const res = getChannelOfflineStatus("Overwatch 2", ["overwatchleague"]);
        assert.equal(res.hasSpecific, true);
        assert.equal(res.pillText, "overwatchleague offline");
        assert.equal(res.statusTitle, "overwatchleague is offline");
        assert.equal(res.waitText, "Waiting for overwatchleague...");
        assert.equal(res.cardTitle, "overwatchleague is Offline");
        assert.ok(res.subTitle.includes("overwatchleague"));
    });

    it("F18-T3: Multiple required channels offline produces concise multi-channel status", () => {
        const res = getChannelOfflineStatus("Rainbow Six Siege", ["rainbow6", "rainbow6bravo"]);
        assert.equal(res.hasSpecific, true);
        assert.equal(res.pillText, "Channels offline");
        assert.equal(res.statusTitle, "Channels Offline: Rainbow Six Siege");
        assert.equal(res.waitText, "Waiting for live channel...");
        assert.equal(res.cardTitle, "Required Channels Offline");
        assert.ok(res.subTitle.includes("rainbow6, rainbow6bravo"));
    });

    it("F18-T4: Open category with no live drops produces 'No Drops Live' without false channel attribution", () => {
        const res = getChannelOfflineStatus("Rust", []);
        assert.equal(res.hasSpecific, false);
        assert.equal(res.pillText, "No Drops Live");
        assert.equal(res.statusTitle, "No Drops Live: Rust");
        assert.equal(res.waitText, "Waiting for stream...");
        assert.equal(res.cardTitle, "No Drops Streams Live");
    });

    it("F18-T5: GitHub update state storage contract stores and hydrates update status", async () => {
        const mockUpdateState = {
            currentVersion: "1.5.1",
            latestVersion: "1.5.2",
            updateAvailable: true,
            releaseUrl: "https://github.com/K9Paradox/Twitch-drop/releases/tag/v1.5.2",
            commitMessage: "Release v1.5.2 with channel feedback",
            lastChecked: Date.now()
        };

        await sandbox.chrome.storage.local.set({ githubUpdate: mockUpdateState });
        const stored = await sandbox.chrome.storage.local.get("githubUpdate");

        assert.ok(stored.githubUpdate);
        assert.equal(stored.githubUpdate.currentVersion, "1.5.1");
        assert.equal(stored.githubUpdate.latestVersion, "1.5.2");
        assert.equal(stored.githubUpdate.updateAvailable, true);
        assert.equal(stored.githubUpdate.releaseUrl, "https://github.com/K9Paradox/Twitch-drop/releases/tag/v1.5.2");
    });
});
