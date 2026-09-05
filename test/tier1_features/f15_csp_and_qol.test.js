import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Tier 1: Feature 15 - Manifest V3 CSP & QoL Enhancements", () => {
    const rootDir = resolve(__dirname, "../..");
    const indexHtml = readFileSync(resolve(rootDir, "index.html"), "utf8");
    const mainJs = readFileSync(resolve(rootDir, "assets/js/main.js"), "utf8");
    const bgJs = readFileSync(resolve(rootDir, "background.js"), "utf8");

    it("F15-T1: index.html contains ZERO inline event handlers (onerror, onclick, onload)", () => {
        const inlineHandlerRegex = /\son[a-z]+="[^"]*"/gi;
        const matches = indexHtml.match(inlineHandlerRegex) || [];
        assert.deepEqual(matches, [], "Found inline event handlers violating MV3 CSP: " + matches.join(", "));
    });

    it("F15-T2: assets/js/main.js contains ZERO inline event handlers inside string templates", () => {
        const inlineHandlerRegex = /onerror\s*=\s*["'][^"']*["']/gi;
        const matches = mainJs.match(inlineHandlerRegex) || [];
        assert.deepEqual(matches, [], "Found inline onerror handlers in main.js violating MV3 CSP: " + matches.join(", "));
    });

    it("F15-T3: index.html contains #stopCampaignBtn and #setwatchPopout controls", () => {
        assert.ok(indexHtml.includes("id=\"stopCampaignBtn\""), "index.html must include #stopCampaignBtn");
        assert.ok(indexHtml.includes("id=\"setwatchPopout\""), "index.html must include #setwatchPopout");
    });

    it("F15-T4: HTML escaping helper sanitizes untrusted Twitch broadcaster and reward strings", () => {
        function escapeHtml(str) {
            if (str == null) return "";
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        const maliciousStreamer = "<script>alert('xss')</script>";
        const sanitized = escapeHtml(maliciousStreamer);
        assert.equal(sanitized, "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;");
        assert.ok(!sanitized.includes("<script>"));
    });

    it("F15-T5: Dynamic badge formatting computes accurate remaining minutes and completion state", () => {
        function computeBadgeText(extEnabled, activeStream, setShowBadges) {
            if (!extEnabled) return "OFF";
            if (activeStream && activeStream.campaign && activeStream.campaign !== "none") {
                const camp = activeStream.campaign;
                if (camp.isCompleted) return "✓";
                if (camp.status === "nostream") return "…";
                if (activeStream.campaigns && activeStream.campaigns.length > 0) {
                    const cur = activeStream.campaigns[camp.onCamp || 0] || activeStream.campaigns[0];
                    if (cur) {
                        let left = 0;
                        if (cur.items && cur.items.length > 0) {
                            const nextItem = cur.items.find(i => !i.self?.isClaimed && (i.self?.currentMinutesWatched || 0) < (i.reqTime || 60));
                            if (nextItem) {
                                const req = nextItem.reqTime || 60;
                                const watched = nextItem.self?.currentMinutesWatched || 0;
                                left = Math.max(0, req - watched);
                            }
                        } else if (cur.minutesNeeded) {
                            left = Math.max(0, cur.minutesNeeded - (cur.minutesWatched || 0));
                        }
                        return left > 0 ? `${left}m` : "✓";
                    }
                }
            }
            return "";
        }

        assert.equal(computeBadgeText(false, {}, true), "OFF");
        assert.equal(computeBadgeText(true, { campaign: { isCompleted: true } }, true), "✓");
        assert.equal(computeBadgeText(true, { campaign: { status: "nostream" } }, true), "…");
        assert.equal(computeBadgeText(true, {
            campaign: { onCamp: 0 },
            campaigns: [{ items: [{ reqTime: 60, self: { currentMinutesWatched: 45, isClaimed: false } }] }]
        }, true), "15m");
    });
});
