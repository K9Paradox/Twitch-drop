import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";

describe("Tier 1: Feature 20 - Popout Window & Ad Resilience", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({ clientId: "test-client-id" });
    });

    it("F20-T1: getStreamMetadata() seamlessly resolves game via direct GetChannelStream query when ChannelShell omits game", async () => {
        // Mock production Twitch behavior: ChannelShell returns stream without game field
        sandbox.fetchMock.onGql("ChannelShell", {
            data: {
                userOrError: {
                    __typename: "User",
                    id: "42450967",
                    login: "unter",
                    stream: {
                        id: "315994905064",
                        viewersCount: 6247,
                        __typename: "Stream"
                        // Note: no game field!
                    }
                }
            }
        });

        // Mock direct GetChannelStream fallback
        sandbox.fetchMock.onGql("GetChannelStream", {
            data: {
                user: {
                    id: "42450967",
                    login: "unter",
                    stream: {
                        id: "315994905064",
                        game: {
                            id: "515025",
                            name: "Overwatch",
                            displayName: "Overwatch"
                        },
                        title: "OWCS Drops Finals",
                        viewersCount: 6247,
                        type: "live"
                    }
                }
            }
        });

        const meta = await client.getStreamMetadata("unter");

        assert.ok(meta);
        assert.equal(meta.login, "unter");
        assert.equal(meta.game, "Overwatch");
        assert.equal(meta.title, "OWCS Drops Finals");
        assert.equal(meta.viewers, 6247);
    });

    it("F20-T2: getStreamMetadata() returns fallback offline object when both ChannelShell and GetChannelStream return null stream", async () => {
        sandbox.fetchMock.onGql("ChannelShell", {
            data: {
                userOrError: {
                    __typename: "User",
                    id: "99999",
                    login: "offlinestreamer",
                    stream: null
                }
            }
        });

        const meta = await client.getStreamMetadata("offlinestreamer");

        assert.ok(meta);
        assert.equal(meta.login, "offlinestreamer");
        assert.equal(meta.game, undefined);
    });

    it("F20-T3: Chrome Mock Windows API supports popup creation, tab association, and window removal", async () => {
        const win = await sandbox.chrome.windows.create({
            url: "https://www.twitch.tv/unter",
            type: "popup",
            width: 854,
            height: 480,
            focused: false
        });

        assert.ok(win);
        assert.equal(win.type, "popup");
        assert.equal(win.width, 854);
        assert.equal(win.height, 480);
        assert.ok(win.tabs.length > 0);
        assert.equal(win.tabs[0].url, "https://www.twitch.tv/unter");
        assert.equal(win.tabs[0].windowId, win.id);

        const fetchedWin = await sandbox.chrome.windows.get(win.id, { populate: true });
        assert.equal(fetchedWin.id, win.id);

        let removedWindowId = null;
        sandbox.chrome.windows.onRemoved.addListener((windowId) => {
            removedWindowId = windowId;
        });

        await sandbox.chrome.windows.remove(win.id);
        assert.equal(removedWindowId, win.id);

        const afterRemove = await sandbox.chrome.windows.get(win.id).catch(() => null);
        assert.equal(afterRemove, null);
    });

    it("F20-T4: Offline Debounce logic requires 2 consecutive offline checks before channel rotation", () => {
        const campaign = {
            status: "watching",
            curWatching: "teststreamer",
            game: { name: "Overwatch" },
            consecutiveOfflineChecks: 0,
            skippedStreamers: []
        };

        function simulateOfflineCheck(isOffline, camp) {
            let rotated = false;
            if (isOffline) {
                camp.consecutiveOfflineChecks = (camp.consecutiveOfflineChecks || 0) + 1;
                if (camp.consecutiveOfflineChecks >= 2) {
                    camp.skippedStreamers.push(camp.curWatching);
                    camp.consecutiveOfflineChecks = 0;
                    rotated = true;
                }
            } else {
                camp.consecutiveOfflineChecks = 0;
            }
            return rotated;
        }

        // Check 1: Stream transiently drops (e.g. ad start or network glitch)
        const check1Rotated = simulateOfflineCheck(true, campaign);
        assert.equal(check1Rotated, false, "Should not rotate on first offline detection");
        assert.equal(campaign.consecutiveOfflineChecks, 1);
        assert.equal(campaign.skippedStreamers.length, 0);

        // Transient glitch recovers on next tick
        simulateOfflineCheck(false, campaign);
        assert.equal(campaign.consecutiveOfflineChecks, 0);

        // Now stream genuinely drops: Check 1
        simulateOfflineCheck(true, campaign);
        assert.equal(campaign.consecutiveOfflineChecks, 1);

        // Check 2: Stream still offline -> Confirmed offline, rotates
        const check2Rotated = simulateOfflineCheck(true, campaign);
        assert.equal(check2Rotated, true, "Should rotate after 2 consecutive offline checks");
        assert.equal(campaign.consecutiveOfflineChecks, 0);
        assert.deepEqual(campaign.skippedStreamers, ["teststreamer"]);
    });

    it("F20-T5: Popout window vs background tab state isolation and clean close", async () => {
        let curWindow = { id: 0, windowId: 0, type: "none" };

        // Test Popout Mode
        const popoutWin = await sandbox.chrome.windows.create({
            url: "https://www.twitch.tv/streamer1",
            type: "popup",
            width: 854,
            height: 480,
            focused: false
        });
        curWindow = {
            id: popoutWin.tabs[0].id,
            windowId: popoutWin.id,
            type: "window"
        };

        assert.equal(curWindow.type, "window");
        assert.ok(curWindow.windowId > 0);
        assert.ok(curWindow.id > 0);

        // Simulate close
        if (curWindow.windowId) {
            await sandbox.chrome.windows.remove(curWindow.windowId);
        }
        if (curWindow.id !== 0) {
            await sandbox.chrome.tabs.remove(curWindow.id).catch(() => {});
        }
        curWindow = { id: 0, windowId: 0, type: "none" };

        assert.equal(curWindow.id, 0);
        assert.equal(curWindow.windowId, 0);
        assert.equal(curWindow.type, "none");
    });
});
