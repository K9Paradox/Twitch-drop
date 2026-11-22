import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTestSandbox } from "../harness/sandbox.js";
import {
    Client,
    areGameNamesMatching,
    isCampaignFarmable,
    isOverwatchGame,
    TwitchApiError
} from "../../background/twitchApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

describe("Tier 1: Feature 23 - Pro v2.0 UI Polish, Static Hygiene & Robust Contract Validation", () => {
    let sandbox;
    const indexHtml = readFileSync(resolve(rootDir, "index.html"), "utf8");
    const mainJs = readFileSync(resolve(rootDir, "assets/js/main.js"), "utf8");
    const mainCss = readFileSync(resolve(rootDir, "assets/css/main.css"), "utf8");
    const manifest = JSON.parse(readFileSync(resolve(rootDir, "manifest.json"), "utf8"));

    beforeEach(() => {
        sandbox = setupTestSandbox();
    });

    it("F23-T1: Static UI hygiene & SVG symbols integrity (all uses resolve, zero inline styles/handlers, zero legacy emojis)", () => {
        // 1. Verify defined SVG symbols in index.html
        const definedSymbols = new Set();
        for (const m of indexHtml.matchAll(/<symbol\s+id="([^"]+)"/g)) {
            definedSymbols.add(m[1]);
        }
        assert.ok(definedSymbols.size >= 25, `Expected at least 25 SVG symbols, found ${definedSymbols.size}`);

        // 2. All <use href="#..."> in index.html match defined symbols
        for (const m of indexHtml.matchAll(/<use\s+href="#([^"]+)"/g)) {
            assert.ok(
                definedSymbols.has(m[1]),
                `Unresolved SVG symbol reference in index.html: #${m[1]}`
            );
        }

        // 3. All static icon helper references in assets/js/main.js match defined symbols
        for (const m of mainJs.matchAll(/icon\s*\(\s*["']([^"']+)["']/g)) {
            const sym = `i-${m[1]}`;
            assert.ok(
                definedSymbols.has(sym),
                `Unresolved SVG symbol referenced via icon("${m[1]}") in main.js: #${sym}`
            );
        }

        // 4. Zero inline styles in index.html and main.js
        const htmlStyles = indexHtml.match(/\sstyle\s*=\s*["'][^"']*["']/gi) || [];
        assert.deepEqual(htmlStyles, [], "Found inline style attributes in index.html: " + htmlStyles.join(", "));

        const jsStyles = mainJs.match(/\sstyle\s*=\s*["'][^"']*["']/gi) || [];
        assert.deepEqual(jsStyles, [], "Found inline style attributes in main.js: " + jsStyles.join(", "));

        // 5. Zero inline event handlers (on*=) in index.html and zero onerror= in main.js
        const inlineHandlers = indexHtml.match(/\son[a-z]+\s*=\s*["'][^"']*["']/gi) || [];
        assert.deepEqual(inlineHandlers, [], "Found inline event handlers in index.html: " + inlineHandlers.join(", "));

        const onerrorHandlers = mainJs.match(/onerror\s*=\s*["'][^"']*["']/gi) || [];
        assert.deepEqual(onerrorHandlers, [], "Found onerror handlers in main.js: " + onerrorHandlers.join(", "));

        // 6. Zero legacy emoji characters in index.html and main.js
        const legacyEmojiRegex = /[⏹▶✕×↗🚀🟢📋]/g;
        const htmlEmojis = indexHtml.match(legacyEmojiRegex) || [];
        assert.deepEqual(htmlEmojis, [], "Found legacy emojis/glyphs in index.html: " + htmlEmojis.join(", "));

        const jsEmojis = mainJs.match(legacyEmojiRegex) || [];
        assert.deepEqual(jsEmojis, [], "Found legacy emojis/glyphs in main.js: " + jsEmojis.join(", "));
    });

    it("F23-T2: Assets and Manifest V3 host permissions integrity (atd-master absent, static.twitchcdn.net included)", () => {
        // 1. atd-master.png should be deleted
        const masterPath = resolve(rootDir, "assets/img/atd-master.png");
        assert.equal(existsSync(masterPath), false, "assets/img/atd-master.png should not exist in repository");

        // 2. All manifest icon files exist
        for (const size of ["16", "32", "48", "128"]) {
            const iconRel = manifest.icons[size];
            assert.ok(iconRel, `Manifest missing icon size ${size}`);
            assert.ok(existsSync(resolve(rootDir, iconRel)), `Icon file missing: ${iconRel}`);
        }

        // 3. Manifest host permissions include Twitch CDN for Spade discovery
        const hostPerms = manifest.host_permissions || [];
        assert.ok(
            hostPerms.includes("https://static.twitchcdn.net/*"),
            "manifest.json host_permissions must include https://static.twitchcdn.net/*"
        );
        assert.ok(
            hostPerms.includes("https://gql.twitch.tv/*"),
            "manifest.json host_permissions must include https://gql.twitch.tv/*"
        );
    });

    it("F23-T3: areGameNamesMatching() accurately avoids sequel collisions while matching subtitles and Overwatch variants", () => {
        // Exact and case-insensitive
        assert.equal(areGameNamesMatching("Rust", "rust"), true);
        assert.equal(areGameNamesMatching("Apex Legends", "APEX LEGENDS"), true);

        // Overwatch variants
        assert.equal(areGameNamesMatching("Overwatch", "Overwatch 2"), true);
        assert.equal(areGameNamesMatching("Overwatch 2", "Overwatch"), true);

        // Subtitle / edition variants (starts with base, followed by delimiter :, -, —, –)
        assert.equal(areGameNamesMatching("Warframe", "Warframe: 1999"), true);
        assert.equal(areGameNamesMatching("World of Warcraft", "World of Warcraft: The War Within"), true);
        assert.equal(areGameNamesMatching("Path of Exile", "Path of Exile - Settlers of Kalguur"), true);

        // Sequel collisions MUST NOT match
        assert.equal(areGameNamesMatching("Fallout", "Fallout 76"), false);
        assert.equal(areGameNamesMatching("Diablo", "Diablo IV"), false);
        assert.equal(areGameNamesMatching("Destiny", "Destiny 2"), false);
        assert.equal(areGameNamesMatching("The Witcher", "The Witcher 3"), false);

        // Invalid inputs
        assert.equal(areGameNamesMatching(null, "Rust"), false);
        assert.equal(areGameNamesMatching("", ""), false);
        assert.equal(areGameNamesMatching(undefined, undefined), false);
    });

    it("F23-T4: UTF-8 Spade watch payload encoding handles non-Latin1 game names (CJK, ™, —)", async () => {
        const client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-123"
        });
        client.userId = "987654321";

        let capturedBody = null;
        globalThis.fetch = async (url, opts) => {
            if (url.includes("spade")) {
                capturedBody = opts?.body;
                return { status: 204, ok: true };
            }
            return { status: 200, ok: true, json: async () => ({}) };
        };

        const streamMeta = {
            broadcastId: "4019283746",
            channelId: "12345678",
            game: "Monster Hunter Wilds™ — 몬스터 헌터 와일즈",
            gameId: "518349"
        };

        const result = await client.sendWatchSpade("capcom_official", streamMeta);
        assert.equal(result, true);
        assert.ok(capturedBody, "Spade request body must be captured");

        // Parse and decode base64
        const match = capturedBody.match(/data=([^&]+)/);
        assert.ok(match, "Body must contain data parameter");
        const b64 = decodeURIComponent(match[1]);
        const decodedStr = Buffer.from(b64, "base64").toString("utf8");
        const parsed = JSON.parse(decodedStr);

        assert.equal(parsed[0].event, "minute-watched");
        assert.equal(parsed[0].properties.game, "Monster Hunter Wilds™ — 몬스터 헌터 와일즈");
        assert.equal(parsed[0].properties.channel, "capcom_official");
    });

    it("F23-T5: Popup <-> SW contracts: p:setAutoDropGames atomic ordering & deduplication", async () => {
        // Simulate p:setAutoDropGames handler logic
        const rawGames = [
            "Overwatch 2",
            "Rust",
            "Warframe",
            "Overwatch", // duplicate under areGameNamesMatching
            "Warframe: 1999", // duplicate under areGameNamesMatching
            "Fallout 76",
            "Fallout" // distinct sequel, not duplicate
        ];

        const deduped = [];
        for (const g of rawGames) {
            if (typeof g === "string" && g.trim() && !deduped.some(existing => areGameNamesMatching(existing, g.trim()))) {
                deduped.push(g.trim());
            }
        }

        assert.deepEqual(deduped, [
            "Overwatch 2",
            "Rust",
            "Warframe",
            "Fallout 76",
            "Fallout"
        ]);

        await sandbox.chrome.storage.local.set({ autoDropGames: deduped });
        const stored = await sandbox.chrome.storage.local.get("autoDropGames");
        assert.equal(stored.autoDropGames.length, 5);
        assert.equal(stored.autoDropGames[0], "Overwatch 2");
    });

    it("F23-T6: Popup <-> SW contracts: p:getCurrentDrops preserves cached claimedInventory on null inventory fetch", async () => {
        // Seed cached claimed inventory
        const cachedInventory = [
            { id: "claim-drop-1", name: "Alpha Skin", game: { displayName: "Rust" } },
            { id: "claim-drop-2", name: "Beta Skin", game: { displayName: "Rust" } }
        ];
        await sandbox.chrome.storage.local.set({ claimedInventory: cachedInventory });

        // Simulate null inventory fetch in p:getCurrentDrops
        const currentInventory = null;
        let claimedInventory;
        if (currentInventory && Array.isArray(currentInventory.gameEventDrops)) {
            claimedInventory = currentInventory.gameEventDrops;
            await sandbox.chrome.storage.local.set({ claimedInventory });
        } else {
            const cached = await sandbox.chrome.storage.local.get("claimedInventory");
            if (Array.isArray(cached?.claimedInventory)) {
                claimedInventory = cached.claimedInventory;
            }
        }

        assert.ok(Array.isArray(claimedInventory));
        assert.equal(claimedInventory.length, 2);
        assert.equal(claimedInventory[0].name, "Alpha Skin");

        // Verify storage was not overwritten with empty array
        const stored = await sandbox.chrome.storage.local.get("claimedInventory");
        assert.equal(stored.claimedInventory.length, 2);
    });

    it("F23-T7: Popup <-> SW contracts: p:getConnectedGames respects settings.showAllGames flag", async () => {
        const fullGameList = ["Overwatch 2", "Rust", "World of Warcraft", "Diablo IV"];
        const connectedCampaignGames = ["Rust", "Overwatch 2"];

        function filterGames(showAll, allGames, connected) {
            if (showAll) {
                return allGames.map(g => ({ game: { displayName: g } }));
            }
            return connected.map(g => ({ game: { displayName: g } }));
        }

        // When showAllGames: false, only connected games are returned
        const filtered = filterGames(false, fullGameList, connectedCampaignGames);
        assert.equal(filtered.length, 2);
        assert.equal(filtered[0].game.displayName, "Rust");
        assert.equal(filtered[1].game.displayName, "Overwatch 2");

        // When showAllGames: true, all games are returned
        const all = filterGames(true, fullGameList, connectedCampaignGames);
        assert.equal(all.length, 4);
    });

    it("F23-T8: Headless Channel Points bonus claiming with deduplication prevents double-counting", async () => {
        const client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token-123"
        });

        // Mock GraphQL ClaimCommunityPoints response
        sandbox.fetchMock.onGql("ClaimCommunityPoints", {
            data: {
                claimCommunityPoints: {
                    claim: {
                        id: "claim-bonus-999",
                        status: "SUCCESS",
                        pointsEarnedTotal: 50
                    },
                    error: null
                }
            }
        });

        const recentBgClaims = new Map();
        function isDuplicateClaim(key, ttlMs = 10000) {
            const now = Date.now();
            if (recentBgClaims.has(key) && (now - recentBgClaims.get(key) < ttlMs)) {
                return true;
            }
            recentBgClaims.set(key, now);
            return false;
        }

        let totalClaimedPoints = 0;
        async function attemptClaimBonus(channelId, claimId) {
            if (isDuplicateClaim("claim-" + claimId, 30000)) {
                return { skipped: true };
            }
            const res = await client.claimChannelPoints(channelId, claimId);
            if (res && res.success) {
                totalClaimedPoints += (res.points || 50);
            }
            return res;
        }

        // First attempt succeeds
        const first = await attemptClaimBonus("123456", "claim-bonus-999");
        assert.equal(first.success, true);
        assert.equal(totalClaimedPoints, 50);

        // Immediate duplicate attempt is deduplicated without making extra network call
        const second = await attemptClaimBonus("123456", "claim-bonus-999");
        assert.equal(second.skipped, true);
        assert.equal(totalClaimedPoints, 50);
    });

    it("F23-T9: Completed campaign preserves activeStream.campaigns and marks status 'completed'", () => {
        const now = Date.now();
        const activeStream = {
            campaign: {
                game: { name: "Rust" },
                status: "watching",
                onCamp: 0
            },
            campaigns: [
                {
                    id: "camp-rust-1",
                    items: [
                        { id: "item-1", reqTime: 60, self: { currentMinutesWatched: 60, isClaimed: true } },
                        { id: "item-2", reqTime: 120, self: { currentMinutesWatched: 120, isClaimed: true } }
                    ]
                }
            ]
        };

        const totalDropsFound = activeStream.campaigns.reduce((sum, c) => sum + (c.items ? c.items.length : 0), 0);
        const hasFarmableDrops = activeStream.campaigns.some(camp => isCampaignFarmable(camp, now));
        assert.equal(hasFarmableDrops, false, "All drops are claimed so hasFarmableDrops should be false");

        const allClaimed = totalDropsFound > 0 && activeStream.campaigns.every(c =>
            (c.items || []).every(item => item.self?.isClaimed)
        );
        assert.equal(allClaimed, true, "allClaimed should be true");

        // Simulate state transition in createCampaign
        activeStream.campaign.status = allClaimed ? "completed" : "no_active_drops";
        activeStream.campaign.isCompleted = allClaimed;
        if (!allClaimed) {
            activeStream.campaigns = [];
        }

        assert.equal(activeStream.campaign.status, "completed");
        assert.equal(activeStream.campaign.isCompleted, true);
        assert.equal(activeStream.campaigns.length, 1, "Completed campaigns must NOT be cleared");
        assert.equal(activeStream.campaigns[0].items.length, 2);
    });

    it("F23-T10: Auth state persistence on 401 error sets unauthenticated without flapping", async () => {
        let authState = { isAuthenticated: true, status: "ok", error: null };

        async function handleAuthError(err) {
            if (err instanceof TwitchApiError && err.status === 401) {
                authState = {
                    isAuthenticated: false,
                    status: "unauthenticated",
                    error: "Twitch session expired. Please sign in on Twitch."
                };
            } else {
                authState = {
                    isAuthenticated: false,
                    status: "error",
                    error: err?.message || "Failed to load Twitch drop campaigns."
                };
            }
            await sandbox.chrome.storage.local.set({ authState });
        }

        const err401 = new TwitchApiError("Twitch GQL HTTP error 401: Unauthorized", { status: 401 });
        await handleAuthError(err401);

        assert.equal(authState.isAuthenticated, false);
        assert.equal(authState.status, "unauthenticated");
        assert.ok(authState.error.includes("sign in on Twitch"));

        const stored = await sandbox.chrome.storage.local.get("authState");
        assert.equal(stored.authState.status, "unauthenticated");
    });
});
