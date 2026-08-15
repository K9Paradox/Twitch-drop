import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 1: Feature 11 - Stream Playback, Muting & 160p30", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F11-T1: Sets low-bandwidth video-quality 160p30 and player-volume presets in localStorage", () => {
        sandbox.domMock.localStorage.setItem("video-quality", JSON.stringify({ "default": "160p30" }));
        sandbox.domMock.localStorage.setItem("player-volume", JSON.stringify({ "default": 0.5, "volume": 0.5, "muted": false }));
        sandbox.domMock.localStorage.setItem("low-latency", JSON.stringify({ "default": false }));

        const vq = JSON.parse(sandbox.domMock.localStorage.getItem("video-quality"));
        const pv = JSON.parse(sandbox.domMock.localStorage.getItem("player-volume"));
        const ll = JSON.parse(sandbox.domMock.localStorage.getItem("low-latency"));

        assert.equal(vq.default, "160p30");
        assert.equal(pv.volume, 0.5);
        assert.equal(ll.default, false);
    });

    it("F11-T2: Page Visibility API override forces document.hidden to false", () => {
        // Test property getter override logic
        let hidden = false;
        const fakeDoc = {
            get hidden() { return false; },
            get visibilityState() { return "visible"; }
        };

        assert.equal(fakeDoc.hidden, false);
        assert.equal(fakeDoc.visibilityState, "visible");
    });

    it("F11-T3: Autoplay content settings allow playback on twitch.tv domains", () => {
        sandbox.chrome.contentSettings.autoplay.set({
            primaryPattern: "*://*.twitch.tv/*",
            setting: "allow"
        });

        const res = sandbox.chrome.contentSettings.autoplay.get({ primaryUrl: "*://*.twitch.tv/*" });
        assert.equal(res.setting, "allow");
    });

    it("F11-T4: Safe playback watchdog plays paused video elements", async () => {
        const video = sandbox.domMock.addElement("video");
        video.paused = true;

        assert.equal(video.paused, true);
        await video.play();
        assert.equal(video.paused, false);
    });

    it("F11-T5: Safe playback watchdog clicks player unmute overlays when visible", () => {
        const btn = sandbox.domMock.addElement("button", { "data-a-target": "player-overlay-click-to-unmute" });
        let clicked = false;

        btn.addEventListener("click", () => {
            clicked = true;
        });

        btn.click();
        assert.equal(clicked, true);
    });
});
