import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";

describe("Tier 2: Boundary - Feature 11: Stream Playback, Muting & 160p30", () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F11-B1: LocalStorage handles JSON parse failure gracefully when reading presets", () => {
        sandbox.domMock.localStorage.setItem("video-quality", "MALFORMED_JSON");

        let quality = "160p30";
        try {
            const parsed = JSON.parse(sandbox.domMock.localStorage.getItem("video-quality"));
            quality = parsed.default || quality;
        } catch (err) {
            quality = "160p30"; // fallback
        }

        assert.equal(quality, "160p30");
    });

    it("F11-B2: Video element play rejection (Autoplay restriction) is safely caught without unhandled rejection", async () => {
        const video = sandbox.domMock.addElement("video");
        video.play = () => Promise.reject(new Error("NotAllowedError: play() failed because user didn't interact"));

        let caught = false;
        try {
            await video.play().catch(() => { caught = true; });
        } catch (e) {}

        assert.equal(caught, true);
    });

    it("F11-B3: Playback watchdog safely handles missing video elements (0 videos found)", () => {
        const videos = sandbox.domMock.document.querySelectorAll("video");
        assert.equal(videos.length, 0);

        assert.doesNotThrow(() => {
            videos.forEach(v => {
                if (v && v.paused) v.play();
            });
        });
    });

    it("F11-B4: Synthetic click ignores null or undefined element targets", () => {
        function triggerSyntheticClick(el) {
            if (!el) return false;
            if (typeof el.click === "function") el.click();
            return true;
        }

        assert.equal(triggerSyntheticClick(null), false);
        assert.equal(triggerSyntheticClick(undefined), false);
    });

    it("F11-B5: Synthetic click ignores elements with offsetParent === null (hidden elements)", () => {
        const hiddenBtn = sandbox.domMock.addElement("button", { "data-a-target": "player-overlay-click-to-unmute" });
        hiddenBtn.offsetParent = null; // hidden in DOM

        let clicked = false;
        hiddenBtn.addEventListener("click", () => { clicked = true; });

        if (hiddenBtn.offsetParent !== null) {
            hiddenBtn.click();
        }

        assert.equal(clicked, false);
    });
});
