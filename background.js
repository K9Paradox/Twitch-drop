/** 
 * Auto Twitch Drops Pro - Background Service Worker (Manifest V3)
 **/
import {
    Client,
    TwitchApiError,
    isCampaignActiveWithDrops,
    isCampaignFarmable,
    isOverwatchGame,
    areGameNamesMatching,
    getTwitchNow,
    setTwitchServerTimeOffset
} from "./background/twitchApi.js";

const DEFAULT_TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

function mergeCampaignsWithInventory(campaigns, inventory) {
    const merged = Array.isArray(campaigns) ? [...campaigns] : [];
    const seen = new Set(merged.map(c => c?.id).filter(Boolean));
    const inProg = Array.isArray(inventory?.dropCampaignsInProgress) ? inventory.dropCampaignsInProgress : [];
    for (const ic of inProg) {
        if (ic && ic.id && !seen.has(ic.id)) {
            seen.add(ic.id);
            merged.push(ic);
        }
    }
    return merged;
}

// Shared helper to extract benefit metadata safely (handles both .benefit and .node)
function extractBenefitInfo(drop) {
    const edge = Array.isArray(drop?.benefitEdges) ? drop.benefitEdges[0] : null;
    const benefit = edge ? (edge.benefit || edge.node || null) : null;
    const benefitId = benefit?.id || "";
    const benefitName = benefit?.name
        ? (drop?.name ? `${drop.name} - ${benefit.name}` : benefit.name)
        : (drop?.name || "Drop Reward");
    const benefitImg = benefit?.imageAssetURL || benefit?.imageURL || drop?.imageURL || drop?.imageAssetURL || "";
    return { benefit, benefitId, benefitName, benefitImg };
}

function isAllCampaignsDone(campaigns, nowTs = getTwitchNow()) {
    if (!Array.isArray(campaigns) || campaigns.length === 0) return false;
    return campaigns.every(c => {
        if (c.items && c.items.length > 0) {
            return c.items.every(i =>
                (i.self && i.self.isClaimed) ||
                (i.endsAt && i.endsAt <= nowTs) ||
                i.isEnded ||
                (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60))
            );
        }
        return c.minutesWatched >= c.minutesNeeded && c.minutesNeeded > 0;
    });
}

// Deduplication cache for background claim and point actions
const recentBgClaims = new Map();
let lastChestPointsClaimTs = 0;
let lastHeadlessCpCheckTs = 0;
function isDuplicateBackgroundClaim(key, ttlMs = 10000) {
    const now = Date.now();
    for (const [k, time] of recentBgClaims.entries()) {
        if (now - time > 60000) recentBgClaims.delete(k);
    }
    if (recentBgClaims.has(key) && (now - recentBgClaims.get(key) < ttlMs)) {
        return true;
    }
    recentBgClaims.set(key, now);
    return false;
}

const POPULAR_DROP_GAMES = [
    "Overwatch",
    "Overwatch 2",
    "Apex Legends",
    "Valorant",
    "World of Warcraft",
    "Rust",
    "Dead by Daylight",
    "Counter-Strike 2",
    "Escape from Tarkov",
    "Fortnite",
    "Palworld",
    "Rainbow Six Siege",
    "League of Legends",
    "Warframe",
    "Destiny 2",
    "Cyberpunk 2077",
    "Genshin Impact",
    "Honkai: Star Rail"
];

let client = null;
let settings = {
    autoRefresh: true,
    showAllGames: true,
    autoGetToken: true,
    autoClaimPoints: true,
    setShowBadges: true,
    soundOnClaim: false,
    desktopNotifications: true,
    autoCheckUpdates: true,
    theme: "auto"
};
let listOfConnected = [...POPULAR_DROP_GAMES];
let autoDropGames = [];
let unstreamableGamesCooldown = new Map();
const UNSTREAMABLE_COOLDOWN_MS = 5 * 60 * 1000;

function persistCooldowns() {
    try {
        if (typeof chrome === "undefined" || !chrome.storage?.local) return;
        const now = Date.now();
        const obj = {};
        for (const [k, ts] of unstreamableGamesCooldown.entries()) {
            if (typeof ts === "number" && now - ts < UNSTREAMABLE_COOLDOWN_MS) {
                obj[k] = ts;
            }
        }
        chrome.storage.local.set({ unstreamableGamesCooldown: obj }).catch(() => {});
    } catch (e) {}
}

function isGameOnCooldown(gameName, now = Date.now()) {
    if (!gameName) return false;
    for (const [cooldownGame, ts] of unstreamableGamesCooldown.entries()) {
        if (areGameNamesMatching(cooldownGame, gameName)) {
            if (now - ts < UNSTREAMABLE_COOLDOWN_MS) {
                return true;
            }
        }
    }
    return false;
}

function setGameCooldown(gameName, ts = Date.now()) {
    if (!gameName) return;
    unstreamableGamesCooldown.set(gameName, ts);
    if (isOverwatchGame(gameName)) {
        unstreamableGamesCooldown.set("Overwatch", ts);
        unstreamableGamesCooldown.set("Overwatch 2", ts);
    }
    persistCooldowns();
}

function clearGameCooldown(gameName) {
    if (!gameName) return;
    let changed = false;
    for (const key of Array.from(unstreamableGamesCooldown.keys())) {
        if (areGameNamesMatching(key, gameName)) {
            unstreamableGamesCooldown.delete(key);
            changed = true;
        }
    }
    if (changed) persistCooldowns();
}

let isAdvancingQueue = false;
let isRunningCampaign = false;
let isCreatingCampaign = false;
let lastAuthStateKey = "";
let rejectedOAuthToken = null;
let extStats = {
    claimedDrops: 0,
    claimedPoints: 0,
    installed: new Date().toISOString(),
    connectedGames: []
};
let activityHistory = [];
let extEnabled = true;
let activeStream = {
    campaign: "none"
};
const INTEGRITY_TAB_COOLDOWN_MS = 15 * 60 * 1000;
let autoGetTokenWindow = 0; // legacy cleanup only
let autoGetTokenTabId = 0;
let lastIntegrityTabAttemptAt = 0;
let clientSessionId = null;
let clientVersion = null;
let integrityRefreshPromise = null;
let integrityRefreshAllowsTab = false;
let pendingIntegrityWaiters = [];
let isHydrated = false;
let hydrationPromise = null;
let headlessWatchInterval = null;
let isSendingWatchPulse = false;

async function setAuthState(status, reason = "") {
    const normalizedStatus = status || "ok";
    const key = `${normalizedStatus}|${reason || ""}`;
    const authState = {
        status: normalizedStatus,
        ...(reason ? { reason } : {}),
        ...(normalizedStatus === "error" && reason ? { error: reason } : {}),
        updatedAt: Date.now()
    };
    const changed = key !== lastAuthStateKey;
    lastAuthStateKey = key;
    if (changed) {
        try {
            if (typeof chrome !== "undefined" && chrome.storage?.local) {
                await chrome.storage.local.set({ authState }).catch(() => {});
            }
            if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage({ type: "p:authStateChanged", data: authState }).catch(() => {});
            }
        } catch (e) {}
    }
}

async function checkHeadlessChannelPoints(streamerLogin) {
    if (!extEnabled || settings.autoClaimPoints === false || !client || !streamerLogin) return false;
    const now = Date.now();
    if (now - lastHeadlessCpCheckTs < 55000) return false;
    if (typeof client.getChannelPointsContext !== "function") return false;

    lastHeadlessCpCheckTs = now;
    try {
        const ctx = await client.getChannelPointsContext(streamerLogin).catch(() => null);
        if (!ctx || !ctx.claimId || !ctx.channelId) return false;
        if (isDuplicateBackgroundClaim("claim-" + ctx.claimId, 30000)) return false;

        const result = await client.claimChannelPoints(ctx.channelId, ctx.claimId);
        if (result && (result.success || result.status === "SUCCESS")) {
            lastChestPointsClaimTs = Date.now();
            const pts = result.points || 50;
            extStats.claimedPoints += pts;
            logActivity("points", `+${pts} Channel Points`, `@${streamerLogin}`, pts);
            await saveState(["extStats", "activityHistory"]);
            chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
            return true;
        }
    } catch (e) {
        // Non-fatal; bonus chest may have already been claimed in another tab
    }
    return false;
}

function applyDropSessionProgress(session, { autoClaim = true } = {}) {
    if (!session || !activeStream || !activeStream.campaign || activeStream.campaign === "none" || !Array.isArray(activeStream.campaigns)) {
        return false;
    }
    const dropData = session.currentDrop || session;
    if (!dropData || typeof dropData.currentMinutesWatched !== "number") {
        return false;
    }
    const watched = dropData.currentMinutesWatched;
    const req = dropData.requiredMinutesWatched || 0;
    const dropId = dropData.dropID || dropData.id || null;

    let changed = false;
    let matchedCamp = null;
    let matchedItem = null;

    if (dropId) {
        for (let idx = 0; idx < activeStream.campaigns.length; idx++) {
            const campObj = activeStream.campaigns[idx];
            if (!Array.isArray(campObj.items)) continue;
            const found = campObj.items.find(i => i && i.id === dropId);
            if (found) {
                matchedCamp = campObj;
                matchedItem = found;
                if (activeStream.campaign.onCamp !== idx) {
                    activeStream.campaign.onCamp = idx;
                    changed = true;
                }
                break;
            }
        }
    }

    if (!matchedCamp) {
        matchedCamp = activeStream.campaigns[activeStream.campaign.onCamp || 0] || activeStream.campaigns[0] || null;
    }
    if (!matchedCamp) return false;

    if (!matchedItem && Array.isArray(matchedCamp.items) && matchedCamp.items.length > 0) {
        const nowTs = getTwitchNow();
        const sortedCandidates = [...matchedCamp.items]
            .filter(i => i && !i.self?.isClaimed && !i.isEnded && !(i.endsAt && i.endsAt <= nowTs))
            .sort((a, b) => (a.reqTime || a.requiredMinutesWatched || 60) - (b.reqTime || b.requiredMinutesWatched || 60));
        matchedItem = matchedCamp.items.find(i => i && i.isSynthetic)
            || (req > 0 ? sortedCandidates.find(i => (i.reqTime || i.requiredMinutesWatched || 60) === req && (i.self?.currentMinutesWatched || 0) < req) : null)
            || (req > 0 ? sortedCandidates.find(i => (i.reqTime || i.requiredMinutesWatched || 60) === req) : null)
            || sortedCandidates.find(i => (i.self?.currentMinutesWatched || 0) < (i.reqTime || i.requiredMinutesWatched || 60))
            || sortedCandidates[0];
    }

    if (matchedItem) {
        const wasSynthetic = Boolean(matchedItem.isSynthetic);
        matchedItem.self = matchedItem.self || {};
        const prevWatched = matchedItem.self.currentMinutesWatched || 0;
        if (watched > prevWatched) {
            matchedItem.self.currentMinutesWatched = watched;
            changed = true;
        }
        if (wasSynthetic && dropId) {
            matchedItem.id = dropId;
            matchedItem.isSynthetic = false;
            changed = true;
        }
        if (matchedItem.id && activeStream.campaign.activeDropId !== matchedItem.id) {
            activeStream.campaign.activeDropId = matchedItem.id;
            changed = true;
        }
        if (req > 0 && (wasSynthetic || matchedItem.isSynthetic || !matchedItem.reqTime)) {
            if (matchedItem.reqTime !== req || wasSynthetic) {
                matchedItem.reqTime = req;
                changed = true;
            }
            if (wasSynthetic) {
                matchedCamp.minutesNeeded = req;
            }
        }
    }

    if (Array.isArray(matchedCamp.items) && matchedCamp.items.length > 0) {
        const nowTs = getTwitchNow();
        const sortedUnclaimed = matchedCamp.items
            .filter(i => i && !i.self?.isClaimed && !i.isEnded && !(i.endsAt && i.endsAt <= nowTs))
            .sort((a, b) => (a.reqTime || 60) - (b.reqTime || 60));
        const activeTierItem = sortedUnclaimed[0];
        if (activeTierItem && activeTierItem !== matchedItem && watched <= (activeTierItem.reqTime || 60)) {
            activeTierItem.self = activeTierItem.self || {};
            if (watched > (activeTierItem.self.currentMinutesWatched || 0)) {
                activeTierItem.self.currentMinutesWatched = watched;
                changed = true;
            }
        }
    }

    if (watched > (matchedCamp.minutesWatched || 0)) {
        matchedCamp.minutesWatched = watched;
        changed = true;
    }
    if (req > (matchedCamp.minutesNeeded || 0)) {
        matchedCamp.minutesNeeded = req;
        changed = true;
    }

    if (changed && activeStream.campaign) {
        if (watched > (activeStream.campaign.lastMinutesWatched || 0)) {
            activeStream.campaign.lastMinutesWatched = watched;
            activeStream.campaign.lastProgressTimestamp = Date.now();
            activeStream.campaign.stallCount = 0;
        }
    }

    if (autoClaim && req > 0 && watched >= req) {
        checkClaimDrop().catch(() => {});
    }

    return changed;
}

async function performHeadlessWatch(preFetchedMeta = null) {
    if (!extEnabled || isSendingWatchPulse) return false;
    if (!activeStream || !activeStream.campaign || activeStream.campaign === "none") return false;
    if (activeStream.campaign.status !== "watching" || !activeStream.campaign.curWatching) return false;

    isSendingWatchPulse = true;
    try {
        if (!client) await fetchTwitchCookiesAndInitClient();
        if (!client) return false;

        const streamer = activeStream.campaign.curWatching;
        const prevMeta = activeStream.campaign.streamMeta;
        let metaOrMethodChanged = false;
        let meta = preFetchedMeta;
        if (meta && meta.channelId && meta.broadcastId) {
            const nextMeta = { ...meta, login: streamer.toLowerCase() };
            if (!prevMeta || prevMeta.channelId !== nextMeta.channelId || prevMeta.broadcastId !== nextMeta.broadcastId || prevMeta.login !== nextMeta.login) {
                metaOrMethodChanged = true;
            }
            activeStream.campaign.streamMeta = nextMeta;
        } else if (
            prevMeta &&
            prevMeta.login === streamer.toLowerCase() &&
            prevMeta.channelId &&
            prevMeta.broadcastId
        ) {
            meta = prevMeta;
        } else if (typeof client.getStreamMetadata === "function") {
            meta = await client.getStreamMetadata(streamer).catch(() => null);
            if (meta && meta.channelId && meta.broadcastId) {
                activeStream.campaign.streamMeta = { ...meta, login: streamer.toLowerCase() };
                metaOrMethodChanged = true;
            }
        }

        const watchRes = await client.sendWatch(streamer, meta || {});
        if (watchRes && watchRes.success) {
            const nowMs = Date.now();
            const nextMethod = watchRes.method || "hls";
            if (activeStream.campaign.watchMethod !== nextMethod) {
                metaOrMethodChanged = true;
            }
            activeStream.campaign.lastWatchPulse = nowMs;
            activeStream.campaign.watchMethod = nextMethod;

            let sessionAdvanced = false;
            if (typeof client.getCurrentDropSession === "function") {
                const session = await client.getCurrentDropSession(meta?.channelId || "", streamer).catch(() => null);
                if (session && applyDropSessionProgress(session)) {
                    sessionAdvanced = true;
                    await saveState(["activeStream"]);
                    updateBadgeUI();
                    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                }
            }

            if (!sessionAdvanced && typeof client.getInventory === "function" && nowMs - (activeStream.campaign.lastInventorySyncTs || 0) >= 55000) {
                activeStream.campaign.lastInventorySyncTs = nowMs;
                const inv = await client.getInventory().catch(() => null);
                if (inv) {
                    const prevMinutes = activeStream.campaigns?.[activeStream.campaign.onCamp || 0]?.minutesWatched || 0;
                    syncCampaignProgressWithInventory(inv);
                    const newMinutes = activeStream.campaigns?.[activeStream.campaign.onCamp || 0]?.minutesWatched || 0;
                    if (newMinutes > prevMinutes) {
                        activeStream.campaign.lastMinutesWatched = newMinutes;
                        activeStream.campaign.lastProgressTimestamp = nowMs;
                        activeStream.campaign.stallCount = 0;
                        await saveState(["activeStream"]);
                        updateBadgeUI();
                        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                    } else if (metaOrMethodChanged) {
                        await saveState(["activeStream"]);
                    }
                }
            } else if (!sessionAdvanced && metaOrMethodChanged) {
                await saveState(["activeStream"]);
            }
            return true;
        }
        return false;
    } catch (e) {
        return false;
    } finally {
        isSendingWatchPulse = false;
    }
}

function startHeadlessWatchLoop() {
    if (headlessWatchInterval) return;
    headlessWatchInterval = setInterval(() => {
        try {
            chrome?.runtime?.getPlatformInfo?.(() => {});
        } catch (e) {}
        if (!extEnabled || !activeStream?.campaign || activeStream.campaign === "none" || activeStream.campaign.status !== "watching") {
            stopHeadlessWatchLoop();
            return;
        }
        performHeadlessWatch().catch(() => {});
    }, 20000);
}

function stopHeadlessWatchLoop() {
    if (headlessWatchInterval) {
        clearInterval(headlessWatchInterval);
        headlessWatchInterval = null;
    }
    if (client && client._streamUrlCache) {
        client._streamUrlCache.clear();
    }
}

// --- State Persistence & Hydration ---

async function saveState(keys = null) {
    try {
        const allState = {
            activeStream,
            extStats,
            settings,
            autoDropGames,
            listOfConnected,
            autoGetTokenWindow,
            autoGetTokenTabId,
            lastIntegrityTabAttemptAt,
            clientSessionId,
            clientVersion,
            activityHistory: activityHistory.slice(0, 50)
        };
        if (Array.isArray(keys) && keys.length > 0) {
            const partial = {};
            for (const k of keys) {
                if (Object.prototype.hasOwnProperty.call(allState, k)) {
                    partial[k] = allState[k];
                }
            }
            if (Object.keys(partial).length > 0) {
                await chrome.storage.local.set(partial);
            }
            return;
        }
        await chrome.storage.local.set(allState);
    } catch (e) {
        console.warn("Error saving state to storage:", e);
    }
}

async function hydrateState() {
    if (isHydrated) return;
    if (hydrationPromise) {
        return await hydrationPromise;
    }

    hydrationPromise = (async () => {
        try {
            const val = await chrome.storage.local.get([
                "exEnabled",
                "settings",
                "autoDropGames",
                "extStats",
                "listOfConnected",
                "activeStream",
                "autoGetTokenWindow",
                "autoGetTokenTabId",
                "lastIntegrityTabAttemptAt",
                "clientSessionId",
                "clientVersion",
                "activityHistory",
                "oauthToken",
                "deviceId",
                "userId",
                "twitchInteg",
                "twitchServerTimeOffset",
                "unstreamableGamesCooldown"
            ]);

            if (typeof val.twitchServerTimeOffset === "number" && Number.isFinite(val.twitchServerTimeOffset)) {
                setTwitchServerTimeOffset(val.twitchServerTimeOffset, true, false);
            }

            if (val.unstreamableGamesCooldown && typeof val.unstreamableGamesCooldown === "object") {
                const now = Date.now();
                unstreamableGamesCooldown.clear();
                for (const [k, ts] of Object.entries(val.unstreamableGamesCooldown)) {
                    if (typeof ts === "number" && now - ts < UNSTREAMABLE_COOLDOWN_MS) {
                        unstreamableGamesCooldown.set(k, ts);
                    }
                }
            }

            extEnabled = val.exEnabled !== undefined ? val.exEnabled : true;
            if (val.settings) settings = { ...settings, ...val.settings };
            if (val.autoDropGames) autoDropGames = val.autoDropGames;
            if (val.listOfConnected && val.listOfConnected.length > 0) {
                listOfConnected = Array.from(new Set([...val.listOfConnected, ...POPULAR_DROP_GAMES]));
            }
            if (val.activityHistory) activityHistory = val.activityHistory;
            if (val.extStats) extStats = { ...extStats, ...val.extStats };

            if (typeof val.autoGetTokenWindow === "number") autoGetTokenWindow = val.autoGetTokenWindow;
            if (typeof val.autoGetTokenTabId === "number") autoGetTokenTabId = val.autoGetTokenTabId;
            if (typeof val.lastIntegrityTabAttemptAt === "number" && Number.isFinite(val.lastIntegrityTabAttemptAt)) {
                lastIntegrityTabAttemptAt = val.lastIntegrityTabAttemptAt;
            }
            if (typeof val.clientSessionId === "string" && val.clientSessionId) clientSessionId = val.clientSessionId;
            if (typeof val.clientVersion === "string" && val.clientVersion) clientVersion = val.clientVersion;
            if (val.activeStream && val.activeStream.campaign && val.activeStream.campaign !== "none") {
                if (val.activeStream.campaign.status === "starting" && (!val.activeStream.campaigns || val.activeStream.campaigns.length === 0)) {
                    activeStream = { campaign: "none" };
                } else {
                    activeStream = val.activeStream;
                }
            }

            await fetchTwitchCookiesAndInitClient();
            isHydrated = true;
            updateBadgeUI();
        } catch (e) {
            console.warn("Error hydrating state:", e);
        } finally {
            hydrationPromise = null;
        }
    })();

    return await hydrationPromise;
}

function notifyUser(title, message) {
    if (settings.desktopNotifications !== false && chrome.notifications) {
        try {
            chrome.notifications.create({
                type: "basic",
                iconUrl: "assets/img/atd-128.png",
                title: title,
                message: message,
                priority: 2
            });
        } catch (e) {}
    }
}

function logActivity(type, title, game, points = 0, imgUrl = "") {
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        type,
        title,
        game,
        points,
        imgUrl,
        timestamp: new Date().toISOString()
    };
    activityHistory.unshift(entry);
    if (activityHistory.length > 50) {
        activityHistory = activityHistory.slice(0, 50);
    }
    chrome.storage.local.set({ activityHistory }).catch(() => {});
    chrome.runtime.sendMessage({ type: "p:activityUpdated", data: activityHistory }).catch(() => {});
}

async function fetchTwitchCookiesAndInitClient() {
    try {
        let authCookie = await chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" }).catch(() => null);
        let deviceCookie = await chrome.cookies.get({ url: "https://www.twitch.tv", name: "unique_id" }).catch(() => null);

        if (!authCookie) {
            const allAuth = await chrome.cookies.getAll({ name: "auth-token" }).catch(() => []);
            authCookie = allAuth.find(c => c.domain.includes("twitch.tv") && c.value) || allAuth[0];
        }
        if (!deviceCookie) {
            const allDev = await chrome.cookies.getAll({ name: "unique_id" }).catch(() => []);
            deviceCookie = allDev.find(c => c.domain.includes("twitch.tv") && c.value) || allDev[0];
        }

        const cookieOAuth = authCookie ? authCookie.value : null;
        const cookieDevice = deviceCookie ? deviceCookie.value : null;

        const localData = await chrome.storage.local.get(["oauthToken", "deviceId", "userId", "twitchInteg", "hadCookieAuth", "clientSessionId", "clientVersion"]).catch(() => ({}));

        let oauthToken = cookieOAuth;
        let deviceId = cookieDevice || localData.deviceId || null;
        let resolvedUserId = localData.userId || null;
        let integrity = localData.twitchInteg || null;
        if (typeof localData.clientSessionId === "string" && localData.clientSessionId) {
            clientSessionId = localData.clientSessionId;
        }
        if (typeof localData.clientVersion === "string" && localData.clientVersion) {
            clientVersion = localData.clientVersion;
        }

        if (cookieOAuth) {
            // Account switched: invalidate cached userId and integrity token for the previous account
            if (localData.oauthToken && localData.oauthToken !== cookieOAuth) {
                resolvedUserId = null;
                integrity = null;
                await chrome.storage.local.remove(["userId", "twitchInteg"]).catch(() => {});
            }
            if (!localData.hadCookieAuth) {
                await chrome.storage.local.set({ hadCookieAuth: true }).catch(() => {});
            }
        } else if (localData.hadCookieAuth) {
            // User logged out of Twitch in the browser: clear stale cached credentials
            oauthToken = null;
            resolvedUserId = null;
            integrity = null;
            await chrome.storage.local.remove(["oauthToken", "userId", "twitchInteg", "hadCookieAuth"]).catch(() => {});
        } else {
            oauthToken = localData.oauthToken || null;
        }

        if (!resolvedUserId && oauthToken) {
            try {
                let persistentCookie = await chrome.cookies.get({ url: "https://www.twitch.tv", name: "persistent" }).catch(() => null);
                if (!persistentCookie) {
                    const allPersist = await chrome.cookies.getAll({ name: "persistent" }).catch(() => []);
                    persistentCookie = allPersist.find(c => c.domain.includes("twitch.tv") && c.value) || allPersist[0];
                }
                if (persistentCookie && persistentCookie.value) {
                    const rawId = decodeURIComponent(persistentCookie.value).split(":")[0];
                    if (/^\d+$/.test(rawId)) {
                        resolvedUserId = rawId;
                        await chrome.storage.local.set({ userId: resolvedUserId }).catch(() => {});
                    }
                }
            } catch (e) {}
        }

        const onIntegrityError = async (opName = "") => {
            if (client) {
                client.integrity = null;
                client.integrityExpiration = null;
            }
            if (typeof chrome !== "undefined" && chrome.storage?.local) {
                chrome.storage.local.remove("twitchInteg").catch(() => {});
            }
            const isDropClaim = typeof opName === "string" && opName.includes("DropsPage_ClaimDropRewards");
            return await refreshIntegrityToken({
                force: true,
                allowTabFallback: isDropClaim,
                reason: opName || "integrity_error"
            });
        };

        const onAuthError = (token, reason) => {
            if (token) {
                rejectedOAuthToken = token;
            }
            setAuthState("unauthenticated", reason || "Twitch session expired. Please sign in on Twitch.").catch(() => {});
        };

        const onAuthSuccess = (token) => {
            if (rejectedOAuthToken && (!token || token === rejectedOAuthToken)) {
                rejectedOAuthToken = null;
            }
            setAuthState("ok").catch(() => {});
        };

        if (oauthToken) {
            if (rejectedOAuthToken && oauthToken !== rejectedOAuthToken) {
                rejectedOAuthToken = null;
            }
            await chrome.storage.local.set({ oauthToken, deviceId }).catch(() => {});
            if (client === null) {
                client = new Client({ clientId: DEFAULT_TWITCH_CLIENT_ID, oauthToken, deviceId, userId: resolvedUserId, uuid: clientSessionId, clientVersion, integrity, onIntegrityError, onAuthError, onAuthSuccess });
            } else {
                client.updateUserInfo({ oauthToken, deviceId, userId: resolvedUserId, uuid: clientSessionId, clientVersion, integrity, onIntegrityError, onAuthError, onAuthSuccess });
            }
            if (!resolvedUserId) {
                await client.autoDetectUserId().catch(() => {});
            }
            if (oauthToken !== rejectedOAuthToken) {
                await setAuthState("ok");
            }
        } else {
            rejectedOAuthToken = null;
            if (client === null) {
                client = new Client({ clientId: DEFAULT_TWITCH_CLIENT_ID, uuid: clientSessionId, clientVersion, integrity: null, onIntegrityError, onAuthError, onAuthSuccess });
            } else {
                client.updateUserInfo({ oauthToken: null, userId: null, uuid: clientSessionId, clientVersion, integrity: null, onIntegrityError, onAuthError, onAuthSuccess });
            }
            await setAuthState("unauthenticated", "Please log in to Twitch in your browser to discover campaigns and farm drops automatically.");
        }
    } catch (e) {
        console.warn("Error fetching Twitch cookies:", e);
        if (client === null) {
            client = new Client({ clientId: DEFAULT_TWITCH_CLIENT_ID });
        }
        await setAuthState("error", e?.message || "Unable to read Twitch session cookies.");
    }
}

async function refreshSyntheticCampaignDetails(inventory = null) {
    if (!client || !activeStream || !activeStream.campaign || activeStream.campaign === "none" || !Array.isArray(activeStream.campaigns)) {
        return false;
    }
    const syntheticCamps = activeStream.campaigns.filter(c =>
        c && c.id && !String(c.id).startsWith("camp-") &&
        (!Array.isArray(c.items) || c.items.length === 0 || c.items.some(i => i && i.isSynthetic))
    );
    if (syntheticCamps.length === 0) return false;

    const campIds = syntheticCamps.map(c => c.id);
    const campDeets = await client.getDropCampaignDetails(campIds).catch(() => null);
    if (!Array.isArray(campDeets) || campDeets.length === 0) return false;

    const eventDropsList = Array.isArray(inventory?.gameEventDrops) ? inventory.gameEventDrops : [];
    const now = getTwitchNow();
    let updatedAny = false;

    for (const c of campDeets) {
        const dropCamp = c?.data?.user?.dropCampaign || c?.data?.dropCampaign || c?.user?.dropCampaign || c?.dropCampaign;
        if (!dropCamp || !Array.isArray(dropCamp.timeBasedDrops) || dropCamp.timeBasedDrops.length === 0) continue;

        const targetCamp = activeStream.campaigns.find(sc => sc && sc.id === dropCamp.id);
        if (!targetCamp) continue;

        const allDrops = [];
        let maxTime = 0;
        let timeWatched = targetCamp.minutesWatched || 0;

        for (const drop of dropCamp.timeBasedDrops) {
            if (!drop) continue;
            const reqMins = drop.requiredMinutesWatched || 60;
            if (reqMins > maxTime) maxTime = reqMins;
            if (reqMins === 0) continue;

            const dropStartAt = drop.startAt || dropCamp.startAt || targetCamp.startAt || null;
            const dropEndAt = drop.endAt || dropCamp.endAt || targetCamp.endAt || null;
            const dropEndsAtTs = dropEndAt ? new Date(dropEndAt).getTime() : null;
            const isEnded = Boolean(dropEndsAtTs && !isNaN(dropEndsAtTs) && dropEndsAtTs <= now);

            const benefit = (drop.benefitEdges && drop.benefitEdges[0]) ? (drop.benefitEdges[0].benefit || drop.benefitEdges[0].node) : null;
            const benefitId = benefit ? benefit.id : "";
            const benefitName = (benefit && benefit.name) ? (drop.name ? `${drop.name} - ${benefit.name}` : benefit.name) : (drop.name || "Drop Reward");
            const benefitImg = (benefit && benefit.imageAssetURL) ? benefit.imageAssetURL : (drop.imageURL || drop.imageAssetURL || "");

            const isClaimed = isDropItemClaimedStrict(drop, eventDropsList) || Boolean(drop.self && drop.self.isClaimed);
            const currentWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                ? drop.self.currentMinutesWatched
                : (isClaimed ? reqMins : 0);
            if (currentWatched > timeWatched) timeWatched = currentWatched;

            allDrops.push({
                name: benefitName,
                picture: benefitImg,
                reqTime: reqMins,
                id: drop.id,
                benefitId: benefitId,
                badge: Boolean(dropCamp.owner && dropCamp.owner.name === "Twitch Gaming"),
                startAt: dropStartAt,
                endAt: dropEndAt,
                endsAt: dropEndsAtTs,
                isEnded: isEnded,
                self: { isClaimed, currentMinutesWatched: currentWatched }
            });
        }

        if (allDrops.length > 0) {
            targetCamp.items = allDrops;
            targetCamp.minutesNeeded = maxTime || 60;
            targetCamp.minutesWatched = Math.max(targetCamp.minutesWatched || 0, timeWatched);
            if (dropCamp.allow && dropCamp.allow.isEnabled !== false && Array.isArray(dropCamp.allow.channels)) {
                const streams = dropCamp.allow.channels.map(ch => ch?.name).filter(Boolean);
                if (streams.length > 0) {
                    targetCamp.streamers = streams;
                }
            }
            updatedAny = true;
        }
    }

    if (updatedAny) {
        if (inventory) {
            syncCampaignProgressWithInventory(inventory);
        }
        await saveState();
        updateBadgeUI();
        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
    }
    return updatedAny;
}

function isDropItemClaimedStrict(item, eventDropsList) {
    if (!item) return false;
    if (item.self && item.self.isClaimed === true) return true;
    if (!eventDropsList || eventDropsList.length === 0) return false;

    const itemId = (item.id || "").toLowerCase();
    const benefitId = (item.benefitId || "").toLowerCase();

    for (const evt of eventDropsList) {
        if (!evt) continue;
        const evtId = (evt.id || "").toLowerCase();
        if (evtId && (evtId === itemId || evtId === benefitId)) return true;
    }
    return false;
}

function syncCampaignProgressWithInventory(inventory) {
    if (!activeStream || !activeStream.campaign || activeStream.campaign === "none" || !activeStream.campaigns) {
        return false;
    }

    const inProgressList = (inventory && inventory.dropCampaignsInProgress) ? inventory.dropCampaignsInProgress : [];
    const eventDropsList = (inventory && inventory.gameEventDrops) ? inventory.gameEventDrops : [];

    let allCampaignsCompleted = true;

    for (const curCamp of activeStream.campaigns) {
        const activeGame = activeStream.campaign.game?.name || "";
        const nowCheck = getTwitchNow();
        const curItemIds = new Set((curCamp.items || []).map(i => i?.id).filter(Boolean));
        const matchedDropCamp = (curCamp.id ? inProgressList.find(c => c && c.id === curCamp.id) : null) ||
            inProgressList.find(c => {
                if (!c) return false;
                if (curCamp.id && !String(curCamp.id).startsWith("camp-") && c.id && c.id !== curCamp.id) {
                    if (curItemIds.size > 0 && Array.isArray(c.timeBasedDrops)) {
                        return c.timeBasedDrops.some(d => d?.id && curItemIds.has(d.id));
                    }
                    return false;
                }
                const cEnd = c.endAt ? new Date(c.endAt).getTime() : NaN;
                if (!isNaN(cEnd) && cEnd <= nowCheck) return false;
                return Boolean(c.game && areGameNamesMatching(c.game.displayName || c.game.name, activeGame));
            });

        if (matchedDropCamp && matchedDropCamp.timeBasedDrops) {
            let maxWatchedInCamp = 0;
            let allDropsClaimedInCamp = true;
            const nowTs = getTwitchNow();

            const hasOnlySyntheticItem = Array.isArray(curCamp.items) && curCamp.items.length === 1 && curCamp.items[0]?.isSynthetic;
            if (!curCamp.items || curCamp.items.length === 0 || (hasOnlySyntheticItem && matchedDropCamp.timeBasedDrops.length > 0)) {
                curCamp.items = [];
                for (const d of matchedDropCamp.timeBasedDrops) {
                    const benefit = d.benefitEdges && d.benefitEdges[0] ? (d.benefitEdges[0].benefit || d.benefitEdges[0].node) : null;
                    const req = d.requiredMinutesWatched || 60;
                    const benefitImg = (benefit && benefit.imageAssetURL) ? benefit.imageAssetURL : (d.imageURL || d.imageAssetURL || "");
                    const benefitName = (benefit && benefit.name) ? (d.name ? `${d.name} - ${benefit.name}` : benefit.name) : (d.name || "Drop Reward");
                    const dropEnd = d.endAt || matchedDropCamp.endAt || null;
                    const dropEndsAt = dropEnd ? new Date(dropEnd).getTime() : null;
                    const isEnded = Boolean(dropEndsAt && !isNaN(dropEndsAt) && dropEndsAt <= nowTs);
                    
                    curCamp.items.push({
                        id: d.id,
                        benefitId: benefit?.id || null,
                        name: benefitName,
                        picture: benefitImg,
                        reqTime: req,
                        startAt: d.startAt || matchedDropCamp.startAt || null,
                        endAt: dropEnd,
                        endsAt: (dropEndsAt && !isNaN(dropEndsAt)) ? dropEndsAt : null,
                        isEnded,
                        self: {
                            isClaimed: Boolean(d.self && d.self.isClaimed),
                            currentMinutesWatched: (d.self && d.self.currentMinutesWatched !== undefined) ? d.self.currentMinutesWatched : 0
                        }
                    });
                }
            }

            for (const drop of matchedDropCamp.timeBasedDrops) {
                const reqMinutes = drop.requiredMinutesWatched || 60;
                if (reqMinutes > curCamp.minutesNeeded) {
                    curCamp.minutesNeeded = reqMinutes;
                }

                const benefit = drop.benefitEdges && drop.benefitEdges[0] ? (drop.benefitEdges[0].benefit || drop.benefitEdges[0].node) : null;
                const matchedItem = curCamp.items ? curCamp.items.find(i => i.id === drop.id || (benefit && benefit.id && i.benefitId === benefit.id)) : null;

                const isExplicitlyClaimed = (drop.self && drop.self.isClaimed === true) || isDropItemClaimedStrict(drop, eventDropsList);
                const invWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                    ? drop.self.currentMinutesWatched
                    : (isExplicitlyClaimed ? reqMinutes : 0);
                // Preserve real-time session progress from DropCurrentSessionContext if Inventory lags behind
                const currentWatched = (matchedItem && matchedItem.id === drop.id && (matchedItem.self?.currentMinutesWatched || 0) > invWatched)
                    ? matchedItem.self.currentMinutesWatched
                    : invWatched;

                if (currentWatched > maxWatchedInCamp) {
                    maxWatchedInCamp = currentWatched;
                }

                const dropEnd = drop.endAt || matchedDropCamp.endAt || null;
                const dropEndsAt = dropEnd ? new Date(dropEnd).getTime() : null;
                const isDropEnded = Boolean(dropEndsAt && !isNaN(dropEndsAt) && dropEndsAt <= nowTs);

                if (!isExplicitlyClaimed && !isDropEnded && currentWatched < reqMinutes) {
                    allDropsClaimedInCamp = false;
                }

                if (matchedItem) {
                    matchedItem.self = matchedItem.self || {};
                    matchedItem.self.isClaimed = isExplicitlyClaimed;
                    matchedItem.self.currentMinutesWatched = currentWatched;
                    if (benefit && benefit.imageAssetURL) {
                        matchedItem.picture = benefit.imageAssetURL;
                    }
                    if (benefit && benefit.id && !matchedItem.benefitId) {
                        matchedItem.benefitId = benefit.id;
                    }
                    if (dropEnd) {
                        matchedItem.endAt = dropEnd;
                        if (dropEndsAt && !isNaN(dropEndsAt)) {
                            matchedItem.endsAt = dropEndsAt;
                            matchedItem.isEnded = isDropEnded;
                        }
                    }
                }
            }

            curCamp.minutesWatched = Math.max(curCamp.minutesWatched || 0, maxWatchedInCamp);

            if (!allDropsClaimedInCamp) {
                allCampaignsCompleted = false;
            }
        } else {
            let allItemsClaimed = true;
            const nowTs = getTwitchNow();
            if (curCamp.items && curCamp.items.length > 0) {
                let maxItemWatched = curCamp.minutesWatched || 0;
                for (const item of curCamp.items) {
                    const req = item.reqTime || curCamp.minutesNeeded || 60;
                    const isClaimed = isDropItemClaimedStrict(item, eventDropsList) || (item.self && item.self.isClaimed === true);
                    item.self = item.self || {};
                    item.self.isClaimed = isClaimed;
                    const itemWatched = item.self.currentMinutesWatched || 0;
                    if (itemWatched > maxItemWatched) maxItemWatched = itemWatched;
                    const itemEnded = Boolean((item.endsAt && item.endsAt <= nowTs) || item.isEnded);

                    if (!isClaimed && !itemEnded && itemWatched < req) {
                        allItemsClaimed = false;
                    }
                }
                curCamp.minutesWatched = maxItemWatched;
            } else {
                if ((curCamp.minutesWatched || 0) < curCamp.minutesNeeded) {
                    allItemsClaimed = false;
                }
            }

            if (!allItemsClaimed) {
                allCampaignsCompleted = false;
            }
        }
    }

    saveState();
    updateBadgeUI();
    return allCampaignsCompleted;
}

// --- GitHub Auto-Update Mechanism ---

export function compareSemver(a, b) {
    if (!a || !b) return 0;
    const parse = (ver) => {
        const clean = String(ver).trim().replace(/^v/i, "");
        const [core, pre = ""] = clean.split("-", 2);
        const nums = core.split(".").map(n => {
            const parsed = parseInt(n, 10);
            return Number.isNaN(parsed) ? 0 : parsed;
        });
        return { nums, pre };
    };
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.nums.length, pb.nums.length);
    for (let i = 0; i < len; i++) {
        const na = pa.nums[i] || 0;
        const nb = pb.nums[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    if (pa.pre === pb.pre) return 0;
    if (!pa.pre && pb.pre) return 1;
    if (pa.pre && !pb.pre) return -1;
    return pa.pre.localeCompare(pb.pre, undefined, { numeric: true });
}

export async function checkGitHubUpdate(manual = false) {
    const currentVersion = (typeof chrome !== "undefined" && chrome.runtime?.getManifest?.()?.version) || "2.0.0";
    const result = {
        ok: false,
        updateAvailable: false,
        latestVersion: currentVersion,
        currentVersion: currentVersion,
        releaseUrl: "https://github.com/K9Paradox/Twitch-drop",
        releaseNotes: "",
        commitSha: "",
        commitMessage: "",
        lastChecked: new Date().toISOString()
    };

    try {
        // 1. Check GitHub Releases
        let releaseFound = false;
        let fetchedAny = false;
        try {
            const relRes = await fetch("https://api.github.com/repos/K9Paradox/Twitch-drop/releases/latest", {
                headers: { "Accept": "application/vnd.github.v3+json" }
            });
            if (relRes && relRes.ok) {
                fetchedAny = true;
                const relData = await relRes.json();
                if (relData && relData.tag_name) {
                    const tagVer = relData.tag_name.replace(/^v/i, "");
                    result.latestVersion = tagVer;
                    result.releaseUrl = relData.html_url || "https://github.com/K9Paradox/Twitch-drop/releases";
                    result.releaseNotes = relData.body || "";
                    if (compareSemver(tagVer, currentVersion) > 0) {
                        result.updateAvailable = true;
                        releaseFound = true;
                    }
                }
            }
        } catch (e) {
            console.warn("[AutoUpdate] Releases check warning:", e?.message);
        }

        // 2. Fallback to raw manifest.json on main branch
        if (!releaseFound) {
            try {
                const rawRes = await fetch("https://raw.githubusercontent.com/K9Paradox/Twitch-drop/main/manifest.json");
                if (rawRes && rawRes.ok) {
                    fetchedAny = true;
                    const rawManifest = await rawRes.json();
                    if (rawManifest && rawManifest.version) {
                        result.latestVersion = rawManifest.version;
                        if (compareSemver(rawManifest.version, currentVersion) > 0) {
                            result.updateAvailable = true;
                            result.releaseUrl = "https://github.com/K9Paradox/Twitch-drop/tree/main";
                        }
                    }
                }
            } catch (e) {
                console.warn("[AutoUpdate] Raw manifest check warning:", e?.message);
            }
        }

        // 3. Fetch latest commit metadata from main branch
        try {
            const commitRes = await fetch("https://api.github.com/repos/K9Paradox/Twitch-drop/commits/main", {
                headers: { "Accept": "application/vnd.github.v3+json" }
            });
            if (commitRes && commitRes.ok) {
                fetchedAny = true;
                const commitData = await commitRes.json();
                if (commitData) {
                    result.commitSha = (commitData.sha || "").substring(0, 7);
                    result.commitMessage = commitData.commit?.message?.split("\n")[0] || "";
                }
            }
        } catch (e) {
            // Non-critical commit metadata error
        }

        if (!fetchedAny) {
            result.ok = false;
            result.error = "Unable to reach GitHub. Check your network connection.";
            return result;
        }

        result.ok = true;

        // Store update status in chrome.storage.local only when GitHub was reachable
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            await chrome.storage.local.set({ githubUpdate: result }).catch(() => {});
        }

        if (result.updateAvailable && settings.desktopNotifications !== false && !manual) {
            notifyUser(
                "Extension Update Available",
                `New version v${result.latestVersion} is available on GitHub (Current: v${currentVersion}).`
            );
        }

        return result;
    } catch (err) {
        console.error("[AutoUpdate] Check error:", err);
        result.ok = false;
        result.error = err?.message || "Update check failed";
        return result;
    }
}

// --- Persistent Alarms for MV3 Service Worker ---

function setupAlarms() {
    chrome.alarms.create("watchdogAlarm", { periodInMinutes: 0.5 });
    chrome.alarms.create("dropCheckAlarm", { periodInMinutes: 3 });
    chrome.alarms.create("tokenRefreshAlarm", { periodInMinutes: 15 });
    chrome.alarms.create("badgeRefreshAlarm", { periodInMinutes: 10 });
    chrome.alarms.create("githubUpdateAlarm", { periodInMinutes: 360 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    await hydrateState();

    if (alarm.name === "autoGetTokenCleanupAlarm") {
        await cleanupIntegrityTabAndWindow();
        return;
    }

    if (!extEnabled) return;

    if (alarm.name === "watchdogAlarm") {
        await handleWatchdogTick();
    } else if (alarm.name === "dropCheckAlarm") {
        await checkForDrops();
    } else if (alarm.name === "tokenRefreshAlarm") {
        await autoGetToken();
    } else if (alarm.name === "badgeRefreshAlarm") {
        updateBadgeUI();
    } else if (alarm.name === "githubUpdateAlarm") {
        if (settings.autoCheckUpdates !== false) {
            await checkGitHubUpdate(false);
        }
    }
});

if (typeof chrome !== "undefined" && chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName && areaName !== "local") return;
        if (!changes || typeof changes !== "object") return;
        if (changes.settings && changes.settings.newValue && typeof changes.settings.newValue === "object") {
            settings = { ...settings, ...changes.settings.newValue };
            updateBadgeUI();
        }
        if (changes.exEnabled !== undefined && typeof changes.exEnabled.newValue === "boolean") {
            extEnabled = changes.exEnabled.newValue;
            updateBadgeUI();
        }
        if (changes.autoDropGames && Array.isArray(changes.autoDropGames.newValue)) {
            autoDropGames = changes.autoDropGames.newValue;
        }
    });
}

async function handleWatchdogTick() {
    if (!extEnabled) return;
    if (!activeStream || !activeStream.campaign || activeStream.campaign === "none") return;

    // Handle nostream recovery & expiry checks (previously unreachable inside status === "watching")
    if (
        (activeStream.campaign.status === "nostream" || !activeStream.campaign.curWatching) &&
        !activeStream.campaign.isCompleted &&
        activeStream.campaign.status !== "no_active_drops" &&
        activeStream.campaign.status !== "completed" &&
        activeStream.campaign.status !== "starting"
    ) {
        const nowTs = getTwitchNow();
        if (activeStream.campaign.endsAt && nowTs >= activeStream.campaign.endsAt) {
            const activeGame = activeStream.campaign.game?.name || "Target Game";
            console.log(`[Watchdog] Waiting campaign for ${activeGame} expired while offline.`);
            activeStream.campaign.status = "no_active_drops";
            activeStream.campaign.curWatching = null;
            activeStream.campaign.isCompleted = false;
            await windowManager("close");
            await saveState(["activeStream"]);
            updateBadgeUI();
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
            if (!activeStream.campaign.isManual && Array.isArray(autoDropGames) && autoDropGames.length > 0) {
                setGameCooldown(activeGame, Date.now());
                setTimeout(() => advanceAutoQueue(activeGame).catch(() => {}), 500);
            }
            return;
        }
        console.log(`[Watchdog] Active campaign for ${activeStream.campaign.game?.name} has no active stream (${activeStream.campaign.status}). Retrying streamer search...`);
        await runCampaign(true);
        return;
    }

    if (activeStream.campaign.status === "watching") {
        if (!client) await fetchTwitchCookiesAndInitClient();
        if (client) {
            // 1. Inventory Sync & Drop Claiming
            const inventory = await client.getInventory().catch(() => null);
            await refreshSyntheticCampaignDetails(inventory).catch(() => {});
            if (inventory) {
                if (Array.isArray(inventory.gameEventDrops)) {
                    await chrome.storage.local.set({ claimedInventory: inventory.gameEventDrops }).catch(() => {});
                }

                // Check if the current campaign has closed/expired
                const now = getTwitchNow();
                const activeGame = activeStream.campaign.game?.name || "";
                let campaignClosed = false;

                if (activeStream.campaign.endsAt && now >= activeStream.campaign.endsAt) {
                    console.log(`[Watchdog] Drop campaign for ${activeGame} has expired by end timestamp (${new Date(activeStream.campaign.endsAt).toISOString()}).`);
                    campaignClosed = true;
                }

                // If stall detected (>=1 trigger) or endsAt is close, re-verify with Twitch drop campaigns
                if (!campaignClosed && ((activeStream.campaign.stallCount || 0) >= 1 || (activeStream.campaign.endsAt && (activeStream.campaign.endsAt - now < 120000)))) {
                    try {
                        const rawCamps = await client.getAllDropCampaigns().catch(() => client.getDropCampaigns().catch(() => []));
                        const allCamps = mergeCampaignsWithInventory(rawCamps, inventory);
                        const targetCamp = (allCamps || []).find(c => c && c.game && areGameNamesMatching(c.game.displayName || c.game.name, activeGame));
                        if (!targetCamp || !isCampaignActiveWithDrops(targetCamp, now, inventory)) {
                            console.log(`[Watchdog] Drop campaign for ${activeGame} is no longer active with drops on Twitch.`);
                            campaignClosed = true;
                        }
                    } catch (e) {}
                }

                // Sync progress & attempt claiming eligible drops BEFORE checking completion/closure
                const isDone = syncCampaignProgressWithInventory(inventory);
                await checkClaimDrop();

                if (isDone && isAllCampaignsDone(activeStream.campaigns, now)) {
                    const gameName = activeStream.campaign.game ? activeStream.campaign.game.name : "Target Game";
                    const allClaimed = activeStream.campaigns.every(c =>
                        (c.items && c.items.length > 0)
                            ? c.items.every(i => (i.self && i.self.isClaimed) || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)))
                            : c.minutesWatched >= c.minutesNeeded
                    );
                    if (allClaimed) {
                        notifyUser("Drop Campaign Completed", `All available drops for ${gameName} have been claimed!`);
                    } else {
                        notifyUser("Drop Campaign Closed", `The drop campaign for ${gameName} has ended.`);
                    }
                    if (activeStream.campaign) {
                        activeStream.campaign.status = allClaimed ? "completed" : "no_active_drops";
                        activeStream.campaign.isCompleted = allClaimed;
                        activeStream.campaign.curWatching = null;
                    }
                    await windowManager("close");
                    await saveState(["activeStream"]);
                    updateBadgeUI();
                    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                    if (!activeStream.campaign?.isManual && Array.isArray(autoDropGames) && autoDropGames.length > 0) {
                        setGameCooldown(gameName, Date.now());
                        setTimeout(() => advanceAutoQueue(gameName).catch(() => {}), 500);
                    } else {
                        await checkForDrops();
                    }
                    return;
                }

                // Also check if all items in activeStream.campaigns are claimed or expired
                if (!campaignClosed && activeStream.campaigns && activeStream.campaigns.length > 0) {
                    const campsWithItems = activeStream.campaigns.filter(c => {
                        const items = c.items || c.drops || [];
                        return items.length > 0;
                    });
                    if (campsWithItems.length > 0) {
                        const anyFarmable = campsWithItems.some(c => {
                            const items = c.items || c.drops || [];
                            return items.some(i => !i.self?.isClaimed && (!i.endsAt || i.endsAt > now));
                        });
                        if (!anyFarmable) {
                            console.log(`[Watchdog] All drop rewards for ${activeGame} are either claimed or ended.`);
                            campaignClosed = true;
                        }
                    }
                }

                if (campaignClosed) {
                    notifyUser("Drop Campaign Closed", `The drop campaign for ${activeGame} has ended.`);
                    if (activeStream.campaign) {
                        activeStream.campaign.status = "no_active_drops";
                        activeStream.campaign.curWatching = null;
                        activeStream.campaign.isCompleted = false;
                    }
                    await windowManager("close");
                    await saveState(["activeStream"]);
                    updateBadgeUI();
                    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});

                    if (!activeStream.campaign?.isManual && Array.isArray(autoDropGames) && autoDropGames.length > 0) {
                        setGameCooldown(activeGame, Date.now());
                        setTimeout(() => advanceAutoQueue(activeGame).catch(() => {}), 500);
                    } else {
                        await checkForDrops();
                    }
                    return;
                }
            }

            // If currently active campaign finished all its drops/ended, advance to next farmable sibling campaign
            const curCamp = activeStream.campaigns ? activeStream.campaigns[activeStream.campaign.onCamp || 0] : null;
            const nowWatchdog = getTwitchNow();
            if (curCamp && !isCampaignFarmable(curCamp, nowWatchdog)) {
                const nextFarmableIdx = activeStream.campaigns.findIndex(c => isCampaignFarmable(c, nowWatchdog));
                if (nextFarmableIdx !== -1 && nextFarmableIdx !== (activeStream.campaign.onCamp || 0)) {
                    console.log(`[Watchdog] Current campaign ${curCamp.id} drops completed/ended. Advancing to sibling campaign index ${nextFarmableIdx} (${activeStream.campaigns[nextFarmableIdx].id}).`);
                    activeStream.campaign.onCamp = nextFarmableIdx;
                    activeStream.campaign.requiredStreamers = activeStream.campaigns[nextFarmableIdx].streamers || [];
                    await saveState(["activeStream"]);
                    await runCampaign(true);
                    return;
                }
            }

            // IF/OR Requirement Promotion:
            // If we are currently farming a fallback requirement (e.g. open category streamer because ow_esports was offline),
            // check if a higher-priority restricted campaign's required channel (or curCamp's featured channels) just went LIVE!
            const curIdx = activeStream.campaign?.onCamp || 0;
            if (activeStream.campaign?.requirementType === "fallback_open" && curCamp && Array.isArray(curCamp.streamers) && curCamp.streamers.length > 0) {
                const livePreferredStreamer = await client.getLiveBroadcasterForCampaign(
                    activeStream.campaign.game?.name,
                    curCamp.id,
                    activeStream.campaign.slug,
                    curCamp.streamers,
                    activeStream.campaign.skippedStreamers || []
                ).catch(() => null);
                if (livePreferredStreamer && livePreferredStreamer.toLowerCase() !== (activeStream.campaign.curWatching || "").toLowerCase()) {
                    console.log(`[RequirementSwitch] Featured required channel @${livePreferredStreamer} (${curCamp.id}) is now LIVE! Switching from directory fallback.`);
                    await runCampaign(true);
                    return;
                }
            }
            if (curIdx > 0 && Array.isArray(activeStream.campaigns)) {
                for (let pIdx = 0; pIdx < curIdx; pIdx++) {
                    const priorityCamp = activeStream.campaigns[pIdx];
                    if (priorityCamp && isCampaignFarmable(priorityCamp, nowWatchdog) && Array.isArray(priorityCamp.streamers) && priorityCamp.streamers.length > 0) {
                        const livePriorityStreamer = await client.getLiveBroadcasterForCampaign(
                            activeStream.campaign.game?.name,
                            priorityCamp.id,
                            activeStream.campaign.slug,
                            priorityCamp.streamers,
                            activeStream.campaign.skippedStreamers || []
                        ).catch(() => null);
                        if (livePriorityStreamer) {
                            console.log(`[RequirementSwitch] Higher-priority required channel @${livePriorityStreamer} (${priorityCamp.id}) is now LIVE! Switching from fallback.`);
                            activeStream.campaign.onCamp = pIdx;
                            activeStream.campaign.requiredStreamers = priorityCamp.streamers || [];
                            await saveState(["activeStream"]);
                            await runCampaign(true);
                            return;
                        }
                    }
                }
            }

            // Ensure headless watch loop is running and verify currently watched streamer
            startHeadlessWatchLoop();

            // Check if currently watched streamer went offline or changed game category
            if (activeStream.campaign && activeStream.campaign.status === "watching" && activeStream.campaign.curWatching) {
                const meta = await client.getStreamMetadata(activeStream.campaign.curWatching).catch(() => null);
                const isOffline = !meta || (!meta.broadcastId && !meta.game);
                const targetGame = activeStream.campaign.game?.name || "";
                
                let gameChanged = false;
                if (meta?.game && targetGame) {
                    gameChanged = !areGameNamesMatching(meta.game, targetGame);
                }

                if (isOffline || gameChanged) {
                    activeStream.campaign.consecutiveOfflineChecks = (activeStream.campaign.consecutiveOfflineChecks || 0) + 1;
                    if (activeStream.campaign.consecutiveOfflineChecks >= 2) {
                        console.log(`Streamer ${activeStream.campaign.curWatching} is confirmed ${isOffline ? "offline" : "playing " + meta.game + " instead of " + targetGame}. Rotating channel.`);
                        activeStream.campaign.skippedStreamers = activeStream.campaign.skippedStreamers || [];
                        if (!activeStream.campaign.skippedStreamers.includes(activeStream.campaign.curWatching)) {
                            activeStream.campaign.skippedStreamers.push(activeStream.campaign.curWatching);
                        }
                        activeStream.campaign.consecutiveOfflineChecks = 0;
                        await runCampaign(true);
                        return;
                    } else {
                        console.log(`Streamer ${activeStream.campaign.curWatching} appears ${isOffline ? "offline" : "in different category"} (check 1/2). Re-verifying next tick before rotating.`);
                    }
                } else {
                    activeStream.campaign.consecutiveOfflineChecks = 0;
                    await performHeadlessWatch(meta);
                    // Headless Channel Points bonus chest claimer (zero tabs needed)
                    await checkHeadlessChannelPoints(activeStream.campaign.curWatching).catch(() => {});
                }
            }

            // 2. Stream Stall Watchdog (6-minute threshold)
            if (settings.autoRefresh !== false && activeStream.campaign) {
                const curCamp = activeStream.campaigns ? activeStream.campaigns[activeStream.campaign.onCamp || 0] : null;
                const currentMinutes = curCamp ? (curCamp.minutesWatched || 0) : 0;
                const now = Date.now();

                if (activeStream.campaign.lastMinutesWatched === undefined || activeStream.campaign.lastProgressTimestamp === undefined) {
                    activeStream.campaign.lastMinutesWatched = currentMinutes;
                    activeStream.campaign.lastProgressTimestamp = now;
                    activeStream.campaign.stallCount = 0;
                } else if (currentMinutes > activeStream.campaign.lastMinutesWatched) {
                    // Progress successfully advanced! Reset stall timer & counter
                    activeStream.campaign.lastMinutesWatched = currentMinutes;
                    activeStream.campaign.lastProgressTimestamp = now;
                    activeStream.campaign.stallCount = 0;
                    if (curCamp) curCamp.strictAllowlistOnly = false;
                } else {
                    // Progress has stalled for >6 minutes
                    const elapsedMs = now - activeStream.campaign.lastProgressTimestamp;
                    const stallThresholdMs = 6 * 60 * 1000;

                    if (elapsedMs >= stallThresholdMs) {
                        activeStream.campaign.stallCount = (activeStream.campaign.stallCount || 0) + 1;
                        activeStream.campaign.lastProgressTimestamp = now;

                        if (activeStream.campaign.stallCount === 1) {
                            console.log(`Headless watch stall detected for ${activeStream.campaign.curWatching} (0m gained in 6m). Resetting HLS token & re-pulsing.`);
                            if (client && client._streamUrlCache && activeStream.campaign.curWatching) {
                                client._streamUrlCache.delete(activeStream.campaign.curWatching.toLowerCase());
                            }
                            await performHeadlessWatch();
                        } else if (activeStream.campaign.stallCount >= 2) {
                            if (activeStream.campaign.requirementType === "fallback_open" && curCamp && Array.isArray(curCamp.streamers) && curCamp.streamers.length > 0) {
                                console.log(`[DirectoryFallback] Open category streamer @${activeStream.campaign.curWatching} yielded 0m in 12m. Campaign ${curCamp.id} strictly requires allowlisted channels (${curCamp.streamers.slice(0, 3).join(", ")}). Disabling category fallback.`);
                                curCamp.strictAllowlistOnly = true;
                            } else {
                                console.log(`Persistent stall detected for ${activeStream.campaign.curWatching} (0m gained in 12m). Rotating to next channel.`);
                            }
                            activeStream.campaign.skippedStreamers = activeStream.campaign.skippedStreamers || [];
                            if (activeStream.campaign.curWatching && !activeStream.campaign.skippedStreamers.includes(activeStream.campaign.curWatching)) {
                                activeStream.campaign.skippedStreamers.push(activeStream.campaign.curWatching);
                            }
                            activeStream.campaign.stallCount = 0;
                            await runCampaign(true);
                            return;
                        }
                    }
                }
            }

            await saveState(["activeStream"]);
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
        }
    }
}

// --- Message Listener (MV3 Compliant) ---

const ALLOWED_WHEN_PAUSED = new Set([
    "toggleExt",
    "user",
    "clientInfo",
    "sendInteg",
    "p:settingsChanged",
    "p:checkUpdate",
    "p:getUpdateState",
    "getExtStats",
    "getActivityHistory",
    "clearActivityHistory"
]);

const OUTGOING_POPUP_EVENTS = new Set([
    "p:sendCurrentDrops",
    "p:connectedGames",
    "p:statsUpdated",
    "p:activityUpdated",
    "p:rewardClaimedSound",
    "p:authStateChanged",
    "setAutoDropGames"
]);

chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
    if (!message || OUTGOING_POPUP_EVENTS.has(message.type)) return;
    const sendResponse = (payload) => {
        if (typeof _sendResponse === "function") {
            try { _sendResponse(payload); } catch (e) {}
        }
    };
    const reply = sendResponse;

    (async () => {
        await hydrateState();

        if (message.type === "toggleExt") {
            extEnabled = Boolean(message.data);
            await chrome.storage.local.set({ exEnabled: extEnabled });
            if (extEnabled) {
                await fetchTwitchCookiesAndInitClient();
                setupAlarms();
                updateBadgeUI();
                setTimeout(checkForDrops, 1500);
            } else {
                chrome.alarms.clearAll();
                stopHeadlessWatchLoop();
                if (activeStream.campaign !== "none") {
                    await endCampaign();
                }
                activeStream = { campaign: "none" };
                await saveState(["activeStream"]);
                updateBadgeUI();
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
            }
            reply({ ok: true, success: true, extEnabled });
            return;
        }

        if (!extEnabled && !ALLOWED_WHEN_PAUSED.has(message.type)) {
            reply({ ok: false, status: "disabled", error: "Extension is paused" });
            return;
        }

        switch (message.type) {
            case "user":
            case "clientInfo": {
                const info = (message.data && typeof message.data === "object") ? message.data : {};
                const oauthToken = info.oauthToken || message.auth || null;
                const deviceId = info.deviceId || message.uniq || null;
                const clientId = info.clientId || message.id || DEFAULT_TWITCH_CLIENT_ID;
                const userId = info.userId || null;
                if (oauthToken || deviceId) {
                    const normalizedInfo = {
                        ...info,
                        clientId,
                        ...(oauthToken ? { oauthToken } : {}),
                        ...(deviceId ? { deviceId } : {}),
                        ...(userId ? { userId } : {})
                    };
                    if (client === null) client = new Client(normalizedInfo);
                    else client.updateUserInfo(normalizedInfo);
                    const toStore = {};
                    if (oauthToken) toStore.oauthToken = oauthToken;
                    if (deviceId) toStore.deviceId = deviceId;
                    if (userId) toStore.userId = userId;
                    if (Object.keys(toStore).length > 0) {
                        await chrome.storage.local.set(toStore);
                    }
                    if (oauthToken && oauthToken !== rejectedOAuthToken) {
                        rejectedOAuthToken = null;
                        await setAuthState("ok");
                    }
                }
                sendResponse({ ok: true, success: true });
                break;
            }

            case "sendInteg":
                await applyCapturedIntegrity(message.data);
                if (extEnabled) {
                    refreshSyntheticCampaignDetails().catch(() => {});
                }
                sendResponse({ ok: true, success: true });
                break;

            case "gqlOperation":
                if (message.data) {
                    const payload = message.data;
                    const opName = message.operation;
                    let extractedItems = [];
                    let currentDrop = null;

                    if (opName === "DropCurrentSessionContext") {
                        const session = payload?.currentUser?.dropCurrentSession;
                        if (session && session.currentDrop) {
                            currentDrop = session.currentDrop;
                        } else if (session && (session.dropID || session.currentMinutesWatched !== undefined)) {
                            currentDrop = {
                                ...session,
                                id: session.dropID || session.id
                            };
                        }
                    } else if (opName === "Inventory") {
                        const inProg = payload?.currentUser?.inventory?.dropCampaignsInProgress || [];
                        const nowTs = getTwitchNow();
                        for (const c of inProg) {
                            if (!c) continue;
                            const cEndTs = c.endAt ? new Date(c.endAt).getTime() : NaN;
                            if (!isNaN(cEndTs) && cEndTs <= nowTs) continue;
                            if (c.status && c.status !== "ACTIVE") continue;
                            const gName = c.game?.displayName || c.game?.name || "";
                            if (c.timeBasedDrops && c.timeBasedDrops.length > 0) {
                                for (const d of c.timeBasedDrops) {
                                    const { benefitId, benefitName, benefitImg } = extractBenefitInfo(d);
                                    const dropEnd = d.endAt || c.endAt || null;
                                    const dropEndsAt = dropEnd ? new Date(dropEnd).getTime() : null;
                                    const isEnded = Boolean(dropEndsAt && !isNaN(dropEndsAt) && dropEndsAt <= nowTs);
                                    
                                    extractedItems.push({
                                        id: d.id,
                                        campaignId: c.id || null,
                                        benefitId: benefitId || null,
                                        gameName: gName,
                                        name: benefitName,
                                        picture: benefitImg,
                                        reqTime: d.requiredMinutesWatched || 60,
                                        startAt: d.startAt || c.startAt || null,
                                        endAt: dropEnd,
                                        endsAt: (dropEndsAt && !isNaN(dropEndsAt)) ? dropEndsAt : null,
                                        isEnded,
                                        self: {
                                            isClaimed: Boolean(d.self?.isClaimed),
                                            currentMinutesWatched: (d.self?.currentMinutesWatched !== undefined) ? d.self.currentMinutesWatched : 0
                                        }
                                    });
                                }
                            }
                        }
                    } else if (opName === "DropChannelCampaignsProgress") {
                        const camps = payload?.channel?.dropCampaignsProgress || payload?.user?.dropCampaignsProgress || [];
                        const nowTs = getTwitchNow();
                        for (const c of camps) {
                            if (!c) continue;
                            const cEndTs = c.endAt ? new Date(c.endAt).getTime() : NaN;
                            if (!isNaN(cEndTs) && cEndTs <= nowTs) continue;
                            if (c.status && c.status !== "ACTIVE") continue;
                            const gName = c.game?.displayName || c.game?.name || "";
                            if (c.timeBasedDrops && c.timeBasedDrops.length > 0) {
                                for (const d of c.timeBasedDrops) {
                                    const { benefitId, benefitName, benefitImg } = extractBenefitInfo(d);
                                    const dropEnd = d.endAt || c.endAt || null;
                                    const dropEndsAt = dropEnd ? new Date(dropEnd).getTime() : null;
                                    const isEnded = Boolean(dropEndsAt && !isNaN(dropEndsAt) && dropEndsAt <= nowTs);

                                    extractedItems.push({
                                        id: d.id,
                                        campaignId: c.id || null,
                                        benefitId: benefitId || null,
                                        gameName: gName,
                                        name: benefitName,
                                        picture: benefitImg,
                                        reqTime: d.requiredMinutesWatched || 60,
                                        startAt: d.startAt || c.startAt || null,
                                        endAt: dropEnd,
                                        endsAt: (dropEndsAt && !isNaN(dropEndsAt)) ? dropEndsAt : null,
                                        isEnded,
                                        self: {
                                            isClaimed: Boolean(d.self?.isClaimed),
                                            currentMinutesWatched: (d.self?.currentMinutesWatched !== undefined) ? d.self.currentMinutesWatched : 0
                                        }
                                    });
                                }
                            }
                        }
                    }

                    if (activeStream.campaign && activeStream.campaign !== "none" && activeStream.campaigns?.length > 0) {
                        const activeGame = activeStream.campaign.game?.name || "";
                        for (const campObj of activeStream.campaigns) {
                            const exactCampMatches = (campObj.id && !String(campObj.id).startsWith("camp-"))
                                ? extractedItems.filter(i => i.campaignId && i.campaignId === campObj.id)
                                : [];
                            const matchedItems = exactCampMatches.length > 0
                                ? exactCampMatches
                                : extractedItems.filter(i => !i.gameName || areGameNamesMatching(i.gameName, activeGame));

                            if (matchedItems.length > 0) {
                                const prevItems = Array.isArray(campObj.items) ? campObj.items : [];
                                campObj.items = matchedItems.map(newItem => {
                                    const existing = prevItems.find(p => p.id === newItem.id || (p.benefitId && newItem.benefitId && p.benefitId === newItem.benefitId));
                                    if (!existing) return newItem;
                                    return {
                                        ...existing,
                                        ...newItem,
                                        benefitId: newItem.benefitId || existing.benefitId || null,
                                        picture: newItem.picture || existing.picture || "",
                                        startAt: newItem.startAt || existing.startAt || null,
                                        endAt: newItem.endAt || existing.endAt || null,
                                        endsAt: newItem.endsAt || existing.endsAt || null,
                                        isEnded: newItem.endAt ? newItem.isEnded : Boolean(existing.isEnded),
                                        self: {
                                            ...(existing.self || {}),
                                            ...(newItem.self || {}),
                                            isClaimed: Boolean(newItem.self?.isClaimed || existing.self?.isClaimed)
                                        }
                                    };
                                });
                                const highestWatched = Math.max(0, ...campObj.items.map(i => i.self?.currentMinutesWatched || 0));
                                const highestReq = Math.max(60, ...campObj.items.map(i => i.reqTime || 60));
                                campObj.minutesWatched = highestWatched;
                                campObj.minutesNeeded = highestReq;
                            } else if (currentDrop) {
                                const { benefitId, benefitName: dropTitle, benefitImg: dropImg } = extractBenefitInfo(currentDrop);

                                const existing = campObj.items?.find(i => i.id === currentDrop.id);
                                if (existing) {
                                    existing.self = existing.self || {};
                                    existing.self.currentMinutesWatched = currentDrop.currentMinutesWatched;
                                    existing.self.isClaimed = Boolean(currentDrop.isClaimed);
                                    if (dropImg) existing.picture = dropImg;
                                } else if (campObj === activeStream.campaigns[activeStream.campaign.onCamp || 0]) {
                                    campObj.items = (campObj.items || []).filter(i => !i.isSynthetic);
                                    campObj.items.push({
                                        id: currentDrop.id,
                                        benefitId: benefitId || null,
                                        name: dropTitle,
                                        picture: dropImg,
                                        reqTime: currentDrop.requiredMinutesWatched || 60,
                                        startAt: currentDrop.startAt || campObj.startAt || null,
                                        endAt: currentDrop.endAt || campObj.endAt || null,
                                        endsAt: currentDrop.endAt ? new Date(currentDrop.endAt).getTime() : (campObj.endsAt || null),
                                        self: {
                                            isClaimed: Boolean(currentDrop.isClaimed),
                                            currentMinutesWatched: currentDrop.currentMinutesWatched || 0
                                        }
                                    });
                                }
                                campObj.minutesWatched = currentDrop.currentMinutesWatched || campObj.minutesWatched;
                                campObj.minutesNeeded = currentDrop.requiredMinutesWatched || campObj.minutesNeeded;
                            }
                        }

                        // Check if current onCamp campaign finished and advance if needed
                        const nowProg = getTwitchNow();
                        const curCampNow = activeStream.campaigns[activeStream.campaign.onCamp || 0];
                        if (curCampNow && !isCampaignFarmable(curCampNow, nowProg)) {
                            const nextFarmableIdx = activeStream.campaigns.findIndex(c => isCampaignFarmable(c, nowProg));
                            if (nextFarmableIdx !== -1 && nextFarmableIdx !== (activeStream.campaign.onCamp || 0)) {
                                activeStream.campaign.onCamp = nextFarmableIdx;
                                activeStream.campaign.requiredStreamers = activeStream.campaigns[nextFarmableIdx].streamers || [];
                            }
                        }

                        await saveState(["activeStream"]);
                        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                    }
                }
                sendResponse({ ok: true, success: true });
                break;

            case "claim-points":
                if (!extEnabled || settings.autoClaimPoints === false) {
                    sendResponse({ ok: false, success: false, disabled: true });
                    break;
                }
                await fetchTwitchCookiesAndInitClient();
                if (client && message.data) {
                    try {
                        const claimId = message.data.claimID;
                        const channelId = message.data.channelID;
                        if (claimId && !isDuplicateBackgroundClaim("claim-" + claimId, 30000)) {
                            const result = await client.claimChannelPoints(channelId, claimId);
                            if (result && (result.success || result.status === "SUCCESS")) {
                                lastChestPointsClaimTs = Date.now();
                                const pts = result.points || 50;
                                extStats.claimedPoints += pts;
                                logActivity("points", `+${pts} Channel Points`, "Twitch Channel", pts);
                                await saveState(["extStats", "activityHistory"]);
                                chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                            }
                        }
                    } catch (e) {
                        console.error("Error claiming points:", e);
                    }
                }
                sendResponse({ ok: true, success: true });
                break;

            case "points-earned":
                if (!extEnabled || settings.autoClaimPoints === false) {
                    sendResponse({ ok: false, success: false, disabled: true });
                    break;
                }
                if (message.data) {
                    const earned = Number(message.data.points) || 50;
                    const src = message.data.source || "generic";
                    const reasonCode = message.data.reasonCode || null;
                    const now = Date.now();
                    // Deduplicate chest bonus notifications across WS claim-available, DOM click, and WS points-earned
                    const isChestBonus = reasonCode === "CLAIM" || src === "dom";
                    if (isChestBonus && (now - lastChestPointsClaimTs < 20000)) {
                        sendResponse({ ok: true, success: true, deduplicated: true });
                        break;
                    }
                    const dedupKey = isChestBonus
                        ? `points-chest-${earned}`
                        : `points-earned-${earned}-${reasonCode || src}`;
                    const dedupTtl = isChestBonus ? 20000 : 3000;
                    if (!isDuplicateBackgroundClaim(dedupKey, dedupTtl)) {
                        if (isChestBonus) lastChestPointsClaimTs = now;
                        extStats.claimedPoints += earned;
                        const label = isChestBonus
                            ? `+${earned} Channel Points (Bonus Chest)`
                            : `+${earned} Channel Points (Watch Bonus)`;
                        logActivity("points", label, "Twitch Stream", earned);
                        await saveState(["extStats", "activityHistory"]);
                        chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                    }
                }
                sendResponse({ ok: true, success: true });
                break;

            case "p:claimDrop":
            case "claim-drop": {
                if (!extEnabled) {
                    sendResponse({ ok: false, success: false, disabled: true });
                    break;
                }
                await fetchTwitchCookiesAndInitClient();
                let claimedCount = 0;
                if (client) {
                    const evtData = (message.data && typeof message.data === "object") ? message.data : null;
                    if (evtData && evtData.eventType === "drop-progress" && typeof evtData.currentProgressMin === "number") {
                        const changed = applyDropSessionProgress({
                            dropID: evtData.dropID || null,
                            currentMinutesWatched: evtData.currentProgressMin,
                            requiredMinutesWatched: evtData.requiredProgressMin || 0
                        }, { autoClaim: false });
                        if (changed) {
                            await saveState(["activeStream"]);
                            updateBadgeUI();
                            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                        }
                        if (evtData.requiredProgressMin > 0 && evtData.currentProgressMin >= evtData.requiredProgressMin) {
                            claimedCount = await checkClaimDrop();
                        }
                    } else {
                        claimedCount = await checkClaimDrop();
                    }
                }
                sendResponse({ ok: true, success: true, claimedCount });
                break;
            }

            case "p:getConnectedGames": {
                await fetchTwitchCookiesAndInitClient();
                const showAll = settings.showAllGames !== false;
                try {
                    const rawData = await client.getAllDropCampaigns().catch(() => client.getDropCampaigns().catch(() => []));
                    const inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
                    const data = mergeCampaignsWithInventory(rawData, inventory);
                    if (Array.isArray(data) && data.length > 0) {
                        const nowTs = getTwitchNow();
                        const inProgGameNames = new Set(
                            (inventory?.dropCampaignsInProgress || [])
                                .map(c => c?.game?.displayName || c?.game?.name)
                                .filter(Boolean)
                        );
                        for (const c of data) {
                            const gDisplay = c?.game?.displayName || c?.game?.name;
                            if (gDisplay && !listOfConnected.includes(gDisplay)) {
                                listOfConnected.push(gDisplay);
                            }
                        }
                        listOfConnected = Array.from(new Set([...listOfConnected, ...POPULAR_DROP_GAMES]));
                        extStats.connectedGames = listOfConnected;
                        await saveState(["listOfConnected", "extStats"]);

                        const activeGameNames = new Set(
                            data.filter(c => isCampaignActiveWithDrops(c, nowTs, inventory))
                                .map(c => c.game.displayName || c.game.name)
                        );
                        const filteredData = showAll
                            ? data
                            : data.filter(c => {
                                const gName = c?.game?.displayName || c?.game?.name;
                                return Boolean(c?.self?.isAccountConnected) || (gName && Array.from(inProgGameNames).some(p => areGameNamesMatching(p, gName)));
                            });
                        const enhancedGames = filteredData.map(c => ({
                            ...c,
                            hasActiveDrops: isCampaignActiveWithDrops(c, nowTs, inventory)
                        }));
                        const baseList = showAll
                            ? listOfConnected
                            : Array.from(new Set(enhancedGames.map(c => c?.game?.displayName || c?.game?.name).filter(Boolean)));
                        const allEnhanced = baseList.map(g => {
                            const foundCamp = data.find(c => c && c.game && areGameNamesMatching(c.game.displayName || c.game.name, g));
                            const hasActive = Array.from(activeGameNames).some(activeName => areGameNamesMatching(activeName, g));
                            return {
                                game: { displayName: g },
                                self: { isAccountConnected: Boolean(foundCamp?.self?.isAccountConnected) },
                                hasActiveDrops: hasActive
                            };
                        });

                        const activeList = Array.from(activeGameNames).sort((a, b) => a.localeCompare(b));
                        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
                            await chrome.storage.local.set({ activeDropGames: activeList }).catch(() => {});
                        }
                        chrome.runtime.sendMessage({ type: "p:connectedGames", data: enhancedGames, allGames: allEnhanced, showAllGames: showAll }).catch(() => {});
                        chrome.runtime.sendMessage({
                            type: "setAutoDropGames",
                            data: { allConnected: activeList, enabled: autoDropGames }
                        }).catch(() => {});
                        sendResponse({ ok: true, games: enhancedGames, allGames: allEnhanced, showAllGames: showAll });
                        return;
                    }
                } catch (e) {
                    console.error("Error fetching connected games:", e);
                    if (e instanceof TwitchApiError && e.status === 401) {
                        await setAuthState("unauthenticated", "Twitch session expired. Please sign in on Twitch.");
                    } else {
                        await setAuthState("error", e?.message || "Failed to load Twitch drop campaigns.");
                    }
                }

                listOfConnected = Array.from(new Set([...listOfConnected, ...POPULAR_DROP_GAMES]));
                const defaultGames = showAll
                    ? listOfConnected.map(g => ({
                        game: { displayName: g },
                        self: { isAccountConnected: true },
                        hasActiveDrops: false
                    }))
                    : [];
                chrome.runtime.sendMessage({ type: "p:connectedGames", data: defaultGames, allGames: defaultGames, showAllGames: showAll }).catch(() => {});
                chrome.runtime.sendMessage({
                    type: "setAutoDropGames",
                    data: { allConnected: [], enabled: autoDropGames }
                }).catch(() => {});
                sendResponse({ ok: true, games: defaultGames, allGames: defaultGames, showAllGames: showAll });
                break;
            }

            case "p:startCampaign":
                try {
                    if (message.data.campaign === "none") {
                        await endCampaign();
                        activeStream = { campaign: "none" };
                        await saveState(["activeStream"]);
                        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                    } else {
                        const isManual = Boolean(message.data.manual);
                        if (isManual) {
                            clearGameCooldown(message.data.campaign);
                        }
                        await createCampaign(message.data.campaign, isManual);
                    }
                    sendResponse({ ok: true, success: true, activeStream });
                } catch (err) {
                    console.error("Error starting campaign:", err);
                    sendResponse({ ok: false, success: false, error: err?.message || "Failed to start campaign" });
                }
                break;

            case "p:getCurrentDrops": {
                await fetchTwitchCookiesAndInitClient();
                let currentInventory = null;
                if (client) {
                    try {
                        currentInventory = await client.getInventory().catch(() => null);
                        await refreshSyntheticCampaignDetails(currentInventory).catch(() => {});
                        if (activeStream.campaign && activeStream.campaign !== "none" && activeStream.campaigns) {
                            if (currentInventory) {
                                const isDone = syncCampaignProgressWithInventory(currentInventory);
                                if (isDone && activeStream.campaign && isAllCampaignsDone(activeStream.campaigns, getTwitchNow())) {
                                    activeStream.campaign.isCompleted = true;
                                    activeStream.campaign.status = "completed";
                                    activeStream.campaign.curWatching = null;
                                }
                                await saveState(["activeStream"]);
                                updateBadgeUI();
                            }
                            if (activeStream.campaign?.status === "watching" && activeStream.campaign.curWatching) {
                                const session = await client.getCurrentDropSession(
                                    activeStream.campaign.streamMeta?.channelId || "",
                                    activeStream.campaign.curWatching
                                ).catch(() => null);
                                if (session && applyDropSessionProgress(session)) {
                                    await saveState(["activeStream"]);
                                    updateBadgeUI();
                                }
                            }
                        }
                    } catch (err) {}
                }
                let claimedInventory;
                if (currentInventory && Array.isArray(currentInventory.gameEventDrops)) {
                    claimedInventory = currentInventory.gameEventDrops;
                    await chrome.storage.local.set({ claimedInventory }).catch(() => {});
                } else {
                    const cached = await chrome.storage.local.get("claimedInventory").catch(() => ({}));
                    if (Array.isArray(cached?.claimedInventory)) {
                        claimedInventory = cached.claimedInventory;
                    }
                }
                const dropPayload = claimedInventory !== undefined
                    ? { activeStream, claimedInventory }
                    : { activeStream };
                chrome.runtime.sendMessage({
                    type: "p:sendCurrentDrops",
                    data: dropPayload
                }).catch(() => {});
                sendResponse({ ok: true, ...dropPayload });
                break;
            }

            case "p:skipStreamer":
                if (activeStream.campaign && activeStream.campaign !== "none") {
                    activeStream.campaign.skippedStreamers = activeStream.campaign.skippedStreamers || [];
                    if (activeStream.campaign.curWatching) {
                        activeStream.campaign.skippedStreamers.push(activeStream.campaign.curWatching);
                    }
                    await runCampaign(true);
                }
                sendResponse({ ok: true, success: true, activeStream });
                break;

            case "p:reloadStream": {
                if (client && client._streamUrlCache && activeStream?.campaign?.curWatching) {
                    client._streamUrlCache.delete(activeStream.campaign.curWatching.toLowerCase());
                }
                const pulsed = await performHeadlessWatch();
                sendResponse({
                    ok: Boolean(pulsed),
                    success: Boolean(pulsed),
                    pulsed: Boolean(pulsed),
                    ...(pulsed ? {} : { error: "Could not send watch heartbeat" })
                });
                break;
            }

            case "p:focusStreamTab":
            case "p:focusFarmTab":
                if (activeStream?.campaign?.curWatching) {
                    const channelUrl = `https://www.twitch.tv/${encodeURIComponent(activeStream.campaign.curWatching)}`;
                    await chrome.tabs.create({ url: channelUrl, active: true }).catch(() => {});
                } else {
                    await chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory", active: true }).catch(() => {});
                }
                sendResponse({ ok: true, success: true });
                break;

            case "p:settingsChanged":
                if (message.data && message.data.settings && typeof message.data.settings === "object") {
                    settings = { ...settings, ...message.data.settings };
                    await saveState(["settings"]);
                    updateBadgeUI();
                }
                sendResponse({ ok: true, success: true, settings });
                break;

            case "getAutoDropGames": {
                await fetchTwitchCookiesAndInitClient();
                let activeOnlyGames = [];
                try {
                    const rawActiveCamps = await client.getAllDropCampaigns().catch(() => client.getDropCampaigns().catch(() => []));
                    const inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
                    const activeCamps = mergeCampaignsWithInventory(rawActiveCamps, inventory);
                    if (Array.isArray(activeCamps)) {
                        const nowTs = getTwitchNow();
                        activeOnlyGames = Array.from(new Set(
                            activeCamps.filter(c => isCampaignActiveWithDrops(c, nowTs, inventory))
                                .map(c => c.game.displayName || c.game.name)
                        )).sort((a, b) => a.localeCompare(b));
                    }
                } catch (e) {}

                // Prune any games from autoDropGames that no longer have active drops
                if (activeOnlyGames.length > 0) {
                    const validQueued = autoDropGames.filter(g =>
                        activeOnlyGames.some(activeG => areGameNamesMatching(activeG, g))
                    );
                    if (validQueued.length !== autoDropGames.length) {
                        autoDropGames = validQueued;
                        await saveState(["autoDropGames"]);
                    }
                }

                if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
                    await chrome.storage.local.set({ activeDropGames: activeOnlyGames }).catch(() => {});
                }

                chrome.runtime.sendMessage({
                    type: "setAutoDropGames",
                    data: { allConnected: activeOnlyGames, enabled: autoDropGames }
                }).catch(() => {});
                sendResponse({
                    ok: true,
                    allConnected: activeOnlyGames,
                    activeDropGames: activeOnlyGames,
                    enabled: autoDropGames,
                    autoDropGames: autoDropGames
                });
                break;
            }

            case "p:setAutoDropGames": {
                const rawGames = Array.isArray(message.data)
                    ? message.data
                    : (Array.isArray(message.data?.games) ? message.data.games : []);
                const deduped = [];
                for (const g of rawGames) {
                    if (typeof g === "string" && g.trim() && !deduped.some(existing => areGameNamesMatching(existing, g.trim()))) {
                        deduped.push(g.trim());
                    }
                }
                autoDropGames = deduped;
                await saveState(["autoDropGames"]);

                const storedActive = await chrome.storage.local.get("activeDropGames").catch(() => ({}));
                const activeList = Array.isArray(storedActive?.activeDropGames) ? storedActive.activeDropGames : [];
                chrome.runtime.sendMessage({
                    type: "setAutoDropGames",
                    data: { allConnected: activeList, enabled: autoDropGames }
                }).catch(() => {});

                if (autoDropGames.length > 0 && extEnabled) {
                    const isIdle = activeStream.campaign === "none" ||
                                   !activeStream.campaign?.curWatching ||
                                   activeStream.campaign?.status === "nostream" ||
                                   activeStream.campaign?.status === "no_active_drops" ||
                                   activeStream.campaign?.isCompleted;
                    if (isIdle) {
                        setTimeout(() => {
                            checkForDrops().catch(() => {});
                        }, 100);
                    }
                }
                sendResponse({ ok: true, success: true, autoDropGames });
                break;
            }

            case "toggleAutoDropGame":
                if (message.data && message.data[0]) {
                    const gameName = message.data[0];
                    const enable = message.data[1];
                    if (enable && !autoDropGames.some(g => areGameNamesMatching(g, gameName))) {
                        autoDropGames.push(gameName);
                    } else if (!enable) {
                        autoDropGames = autoDropGames.filter(g => !areGameNamesMatching(g, gameName));
                    }
                    await saveState(["autoDropGames"]);

                    // If a game was enabled and we are not currently watching an active stream, immediately trigger queue check!
                    if (enable && extEnabled) {
                        const isIdle = activeStream.campaign === "none" ||
                                       !activeStream.campaign?.curWatching ||
                                       activeStream.campaign?.status === "nostream" ||
                                       activeStream.campaign?.status === "no_active_drops" ||
                                       activeStream.campaign?.isCompleted;
                        if (isIdle) {
                            setTimeout(() => {
                                checkForDrops().catch(() => {});
                            }, 100);
                        }
                    }
                }
                sendResponse({ ok: true, success: true, autoDropGames });
                break;

            case "p:startAutoQueue":
                if (extEnabled) {
                    checkForDrops().catch(() => {});
                    sendResponse({ ok: true, success: true });
                } else {
                    sendResponse({ ok: false, success: false, error: "Extension disabled", reason: "Extension disabled" });
                }
                break;

            case "getExtStats":
                chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                sendResponse({ ok: true, extStats });
                break;

            case "getActivityHistory":
                sendResponse({ ok: true, activityHistory });
                break;

            case "clearActivityHistory":
                activityHistory = [];
                await saveState(["activityHistory"]);
                chrome.runtime.sendMessage({ type: "p:activityUpdated", data: [] }).catch(() => {});
                sendResponse({ ok: true, success: true });
                break;

            case "p:checkUpdate": {
                const updateRes = await checkGitHubUpdate(true);
                sendResponse(updateRes);
                break;
            }

            case "p:getUpdateState": {
                const storedUpdate = await chrome.storage.local.get("githubUpdate").catch(() => ({}));
                sendResponse(storedUpdate.githubUpdate || null);
                break;
            }

            default:
                reply({ ok: false, status: "unhandled", error: `Unhandled message type: ${message.type}` });
        }
    })();

    return true;
});

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);

async function startup() {
    await hydrateState();
    await cleanupIntegrityTabAndWindow();
    setupAlarms();
    updateBadgeUI();

    if (extEnabled) {
        if (activeStream?.campaign && activeStream.campaign !== "none") {
            if (activeStream.campaign.status === "watching" && activeStream.campaign.curWatching) {
                startHeadlessWatchLoop();
                performHeadlessWatch().catch(() => {});
            } else if ((activeStream.campaign.status === "nostream" || !activeStream.campaign.curWatching) && !activeStream.campaign.isCompleted && activeStream.campaign.status !== "no_active_drops") {
                setTimeout(() => runCampaign(true).catch(() => {}), 1500);
            }
        }
        setTimeout(autoGetToken, 3000);
        setTimeout(checkForDrops, 4000);
        if (settings.autoCheckUpdates !== false) {
            setTimeout(() => checkGitHubUpdate(false), 5000);
        }
    }
}

// --- Campaign Execution Engine ---

async function runCampaign() {
    if (!activeStream.campaign || activeStream.campaign === "none" || activeStream.campaign.status === "no_active_drops" || !activeStream.campaigns || activeStream.campaigns.length === 0) return;
    if (isRunningCampaign) return;
    isRunningCampaign = true;

    try {
        const nowTs = getTwitchNow();
        let curCamp = activeStream.campaigns[activeStream.campaign.onCamp];
        if (!curCamp || !isCampaignFarmable(curCamp, nowTs)) {
            const nextFarmableIdx = activeStream.campaigns.findIndex(c => isCampaignFarmable(c, nowTs));
            if (nextFarmableIdx !== -1) {
                activeStream.campaign.onCamp = nextFarmableIdx;
                curCamp = activeStream.campaigns[nextFarmableIdx];
            }
        }
        if (!curCamp) {
            await endCampaign();
            return;
        }
        activeStream.campaign.requiredStreamers = curCamp.streamers || [];

        if (isAllCampaignsDone(activeStream.campaigns, nowTs)) {
            if (activeStream.campaign) {
                activeStream.campaign.status = "completed";
                activeStream.campaign.isCompleted = true;
                activeStream.campaign.curWatching = null;
            }
            await windowManager("close");
            await saveState(["activeStream"]);
            updateBadgeUI();
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
            return;
        }

        activeStream.campaign.isCompleted = false;
        await fetchTwitchCookiesAndInitClient();

        activeStream.campaign.skippedStreamers = activeStream.campaign.skippedStreamers || [];
        const skipped = activeStream.campaign.skippedStreamers;

        let targetStreamer = await client.getLiveBroadcasterForCampaign(
            activeStream.campaign.game.name,
            curCamp.id,
            activeStream.campaign.slug,
            curCamp.streamers,
            skipped
        );

        if (!targetStreamer && skipped.length > 0) {
            activeStream.campaign.skippedStreamers = [];
            targetStreamer = await client.getLiveBroadcasterForCampaign(
                activeStream.campaign.game.name,
                curCamp.id,
                activeStream.campaign.slug,
                curCamp.streamers,
                []
            );
        }

        // IF/OR MULTI-CAMPAIGN REQUIREMENT FAILOVER:
        // If the primary requirement (e.g. restricted channel like ow_esports) is not met because those channels are offline,
        // immediately switch to the next farmable campaign requirement (e.g. open category streamer) so view time continues uninterrupted.
        let offlineRestrictedStreamers = [];
        if (!targetStreamer && Array.isArray(curCamp.streamers) && curCamp.streamers.length > 0) {
            offlineRestrictedStreamers = [...curCamp.streamers];
        }

        if (!targetStreamer && activeStream.campaigns.length > 1) {
            for (let i = 0; i < activeStream.campaigns.length; i++) {
                if (i === activeStream.campaign.onCamp) continue;
                const siblingCamp = activeStream.campaigns[i];
                if (!isCampaignFarmable(siblingCamp, nowTs)) continue;

                let siblingStreamer = await client.getLiveBroadcasterForCampaign(
                    activeStream.campaign.game.name,
                    siblingCamp.id,
                    activeStream.campaign.slug,
                    siblingCamp.streamers,
                    skipped
                );

                if (!siblingStreamer && skipped.length > 0) {
                    siblingStreamer = await client.getLiveBroadcasterForCampaign(
                        activeStream.campaign.game.name,
                        siblingCamp.id,
                        activeStream.campaign.slug,
                        siblingCamp.streamers,
                        []
                    );
                }

                if (siblingStreamer) {
                    console.log(`[CampaignFailover] Primary campaign ${curCamp.id} requirement not met (streamers offline). Switching to sibling campaign ${siblingCamp.id} streamer @${siblingStreamer}`);
                    activeStream.campaign.onCamp = i;
                    curCamp = siblingCamp;
                    targetStreamer = siblingStreamer;
                    activeStream.campaign.requiredStreamers = curCamp.streamers || [];
                    break;
                } else if (Array.isArray(siblingCamp.streamers) && siblingCamp.streamers.length > 0 && offlineRestrictedStreamers.length === 0) {
                    offlineRestrictedStreamers = [...siblingCamp.streamers];
                }
            }
        }

        // SINGLE-CAMPAIGN / DIRECTORY FALLBACK (IF/OR):
        let usedOpenDirectoryFallback = false;
        if (!targetStreamer && offlineRestrictedStreamers.length > 0 && !curCamp.strictAllowlistOnly && typeof client.getChannelWithDrops === "function") {
            let dirChannel = await client.getChannelWithDrops(
                activeStream.campaign.game.name,
                curCamp.id,
                activeStream.campaign.slug,
                skipped
            ).catch(() => null);

            if (!dirChannel && skipped.length > 0) {
                activeStream.campaign.skippedStreamers = [];
                dirChannel = await client.getChannelWithDrops(
                    activeStream.campaign.game.name,
                    curCamp.id,
                    activeStream.campaign.slug,
                    []
                ).catch(() => null);
            }

            if (dirChannel && dirChannel.broadcaster && dirChannel.broadcaster.login) {
                targetStreamer = dirChannel.broadcaster.login;
                usedOpenDirectoryFallback = true;
                console.log(`[DirectoryFallback] Listed channels (${offlineRestrictedStreamers.slice(0, 3).join(", ")}) are offline. Falling back to participating live category channel @${targetStreamer}`);
            }
        }

        if (!targetStreamer) {
            console.log(`[AutoQueue] No compatible live stream found for ${activeStream.campaign.game.name}`);
            await windowManager("close");
            activeStream.campaign.curWatching = null;

            const currentGame = activeStream.campaign.game.name;
            setGameCooldown(currentGame, Date.now());

            // Only auto-skip if this campaign was NOT explicitly selected manually by the user
            if (!activeStream.campaign.isManual) {
                isRunningCampaign = false;
                const skippedToNext = await advanceAutoQueue(currentGame);
                if (skippedToNext) {
                    return;
                }
                // Guard against another campaign starting or stopping while advanceAutoQueue was awaited
                if (!activeStream.campaign || activeStream.campaign === "none" || activeStream.campaign.game?.name !== currentGame) {
                    return;
                }
            }

            activeStream.campaign.status = "nostream";
            const anyFarmableOpen = activeStream.campaigns.some(c => isCampaignFarmable(c, nowTs) && (!c.streamers || c.streamers.length === 0));
            activeStream.campaign.requiredStreamers = anyFarmableOpen ? [] : (curCamp.streamers || []);
            activeStream.campaign.requirementType = anyFarmableOpen ? "open" : "restricted";
            await saveState(["activeStream"]);
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
            updateBadgeUI();
            return;
        }

        activeStream.campaign.curWatching = targetStreamer;
        const isRestrictedActive = Array.isArray(curCamp.streamers) && curCamp.streamers.length > 0 && !usedOpenDirectoryFallback;
        if (isRestrictedActive) {
            activeStream.campaign.requirementType = "restricted";
            activeStream.campaign.fallbackFromStreamers = [];
        } else if (offlineRestrictedStreamers.length > 0) {
            activeStream.campaign.requirementType = "fallback_open";
            activeStream.campaign.fallbackFromStreamers = offlineRestrictedStreamers;
        } else {
            activeStream.campaign.requirementType = "open";
            activeStream.campaign.fallbackFromStreamers = [];
        }

        // Reset progress tracking & stall counts for new/re-targeted streamer
        activeStream.campaign.lastMinutesWatched = curCamp.minutesWatched || 0;
        activeStream.campaign.lastProgressTimestamp = Date.now();
        activeStream.campaign.stallCount = 0;
        activeStream.campaign.status = "watching";

        startHeadlessWatchLoop();
        performHeadlessWatch().catch(() => {});

        await saveState(["activeStream"]);
        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
        updateBadgeUI();
    } finally {
        isRunningCampaign = false;
    }
}

async function endCampaign() {
    await windowManager("close");
    activeStream = { campaign: "none" };
    await saveState(["activeStream"]);
    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
    await checkClaimDrop();
    updateBadgeUI();
}

async function createCampaign(game, isManual = false) {
    if (!extEnabled) return;
    if (isCreatingCampaign) return;
    isCreatingCampaign = true;

    try {
        await fetchTwitchCookiesAndInitClient();

        const gameSlug = game.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
        let rawCampaigns = await client.getAllDropCampaigns().catch(() => client.getDropCampaigns().catch(() => []));
        if (!rawCampaigns) rawCampaigns = [];

        let inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
        if (!inventory) inventory = { dropCampaignsInProgress: [], gameEventDrops: [] };

        const campaigns = mergeCampaignsWithInventory(rawCampaigns, inventory);

        const now = getTwitchNow();
        const matchingCampaigns = campaigns.filter(c =>
            c.game != null &&
            areGameNamesMatching(c.game.displayName || c.game.name, game) &&
            isCampaignActiveWithDrops(c, now, inventory)
        );

        activeStream.campaign = {
            game: {
                name: game
            },
            onCamp: 0,
            curWatching: "",
            slug: gameSlug,
            status: "starting",
            isCompleted: false,
            isManual: Boolean(isManual),
            skippedStreamers: [],
            requiredStreamers: [],
            lastMinutesWatched: 0,
            lastProgressTimestamp: Date.now(),
            stallCount: 0,
            endsAt: null
        };
        activeStream.campaigns = [];
        let earliestEndsAt = null;

        if (matchingCampaigns.length > 0) {
            const campAry = matchingCampaigns.map(c => c.id);
            const campDeets = await client.getDropCampaignDetails(campAry).catch(() => []);

            let itemsToProcess = [];
            if (Array.isArray(campDeets) && campDeets.length > 0) {
                for (const c of campDeets) {
                    const dropCamp = c?.data?.user?.dropCampaign || c?.data?.dropCampaign || c?.user?.dropCampaign || c?.dropCampaign;
                    if (dropCamp) {
                        const orig = matchingCampaigns.find(mc => mc && mc.id === dropCamp.id);
                        if (orig) {
                            if (!dropCamp.startAt && orig.startAt) dropCamp.startAt = orig.startAt;
                            if (!dropCamp.endAt && orig.endAt) dropCamp.endAt = orig.endAt;
                            if (!dropCamp.game && orig.game) dropCamp.game = orig.game;
                            if ((!dropCamp.timeBasedDrops || dropCamp.timeBasedDrops.length === 0) && Array.isArray(orig.timeBasedDrops) && orig.timeBasedDrops.length > 0) {
                                dropCamp.timeBasedDrops = orig.timeBasedDrops;
                            }
                        }
                        itemsToProcess.push(dropCamp);
                    }
                }
            }
            if (itemsToProcess.length === 0) itemsToProcess = matchingCampaigns;

            const eventDropsList = (inventory && inventory.gameEventDrops) ? inventory.gameEventDrops : [];

            for (const dropCamp of itemsToProcess) {
                if (!dropCamp) continue;
                const inProgMatch = inventory?.dropCampaignsInProgress?.find(obj => obj && obj.id === dropCamp.id) ||
                    inventory?.dropCampaignsInProgress?.find(obj => {
                        if (!obj || (dropCamp.id && obj.id && obj.id !== dropCamp.id)) return false;
                        return Boolean(obj.game && areGameNamesMatching(obj.game.displayName || obj.game.name, game));
                    });
                if (!dropCamp.endAt && inProgMatch?.endAt) dropCamp.endAt = inProgMatch.endAt;
                if (!dropCamp.startAt && inProgMatch?.startAt) dropCamp.startAt = inProgMatch.startAt;
                if ((!dropCamp.timeBasedDrops || dropCamp.timeBasedDrops.length === 0) && Array.isArray(inProgMatch?.timeBasedDrops) && inProgMatch.timeBasedDrops.length > 0) {
                    dropCamp.timeBasedDrops = inProgMatch.timeBasedDrops;
                }

                if (dropCamp.endAt) {
                    const campEnd = new Date(dropCamp.endAt).getTime();
                    if (!isNaN(campEnd) && (earliestEndsAt === null || campEnd < earliestEndsAt)) {
                        earliestEndsAt = campEnd;
                    }
                }
                const streams = [];
                if (dropCamp.allow && dropCamp.allow.isEnabled !== false && Array.isArray(dropCamp.allow.channels)) {
                    for (const stream of dropCamp.allow.channels) {
                        if (stream && stream.name) streams.push(stream.name);
                    }
                }
                let maxTime = 0;
                let timeWatched = 0;
                const allDrops = [];

                for (const drop of (dropCamp.timeBasedDrops || [])) {
                    let dropStartAt = drop.startAt || null;
                    let dropEndAt = drop.endAt || null;
                    if (inProgMatch && Array.isArray(inProgMatch.timeBasedDrops)) {
                        const inProgDrop = inProgMatch.timeBasedDrops.find(d => d && (d.id === drop.id || (d.benefitEdges?.[0]?.benefit?.id && d.benefitEdges[0].benefit.id === drop.id)));
                        if (inProgDrop) {
                            if (!dropStartAt && inProgDrop.startAt) dropStartAt = inProgDrop.startAt;
                            if (!dropEndAt && inProgDrop.endAt) dropEndAt = inProgDrop.endAt;
                        }
                    }
                    if (!dropEndAt && dropCamp.endAt) dropEndAt = dropCamp.endAt;
                    if (!dropStartAt && dropCamp.startAt) dropStartAt = dropCamp.startAt;

                    const dropEndsAtTs = dropEndAt ? new Date(dropEndAt).getTime() : null;
                    const isEnded = Boolean(dropEndsAtTs && !isNaN(dropEndsAtTs) && dropEndsAtTs <= now);

                    const reqMins = drop.requiredMinutesWatched || 60;
                    if (reqMins > maxTime) maxTime = reqMins;

                    if (reqMins !== 0) {
                        const { benefitId, benefitName, benefitImg } = extractBenefitInfo(drop);

                        const isClaimedInEvents = isDropItemClaimedStrict(drop, eventDropsList);
                        const isClaimedInSelf = Boolean(drop.self && drop.self.isClaimed);
                        const isClaimed = isClaimedInEvents || isClaimedInSelf;
                        const currentWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                            ? drop.self.currentMinutesWatched
                            : (isClaimed ? reqMins : 0);

                        allDrops.push({
                            name: benefitName,
                            picture: benefitImg,
                            reqTime: reqMins,
                            id: drop.id,
                            benefitId: benefitId,
                            badge: Boolean(dropCamp.owner && dropCamp.owner.name === "Twitch Gaming"),
                            startAt: dropStartAt,
                            endAt: dropEndAt,
                            endsAt: dropEndsAtTs,
                            isEnded: isEnded,
                            self: { isClaimed, currentMinutesWatched: currentWatched }
                        });

                        if (!isClaimed && dropEndsAtTs && !isNaN(dropEndsAtTs) && dropEndsAtTs > now) {
                            if (earliestEndsAt === null || dropEndsAtTs < earliestEndsAt) {
                                earliestEndsAt = dropEndsAtTs;
                            }
                        }
                    }
                }

                // If Twitch DropCampaignDetails omitted timeBasedDrops for an active campaign, synthesize a placeholder drop item so farming can start
                if (allDrops.length === 0) {
                    const fallbackEndsAt = dropCamp.endAt ? new Date(dropCamp.endAt).getTime() : null;
                    allDrops.push({
                        id: `${dropCamp.id || gameSlug}-drop`,
                        benefitId: "",
                        name: dropCamp.name || `${game} Drop Reward`,
                        picture: dropCamp.imageURL || dropCamp.game?.boxArtURL || "",
                        reqTime: 60,
                        isSynthetic: true,
                        badge: Boolean(dropCamp.owner && dropCamp.owner.name === "Twitch Gaming"),
                        startAt: dropCamp.startAt || null,
                        endAt: dropCamp.endAt || null,
                        endsAt: (fallbackEndsAt && !isNaN(fallbackEndsAt)) ? fallbackEndsAt : null,
                        isEnded: false,
                        self: { isClaimed: false, currentMinutesWatched: 0 }
                    });
                }

                const dropStarted = inventory.dropCampaignsInProgress ? inventory.dropCampaignsInProgress.some(obj => obj.id === dropCamp.id) : false;
                if (dropStarted) {
                    const inProg = inventory.dropCampaignsInProgress.find(obj => obj.id === dropCamp.id);
                    if (inProg && inProg.timeBasedDrops && inProg.timeBasedDrops.length > 0) {
                        for (const drop of inProg.timeBasedDrops) {
                            if (drop.self) {
                                if (drop.self.currentMinutesWatched > timeWatched) {
                                    timeWatched = drop.self.currentMinutesWatched;
                                }
                                const matchedItem = allDrops.find(item => item.id === drop.id || (item.benefitId && item.benefitId === drop.id));
                                if (matchedItem) {
                                    // Keep isClaimed strictly true only when actually claimed (not merely 100% watched)
                                    matchedItem.self.isClaimed = Boolean(drop.self.isClaimed || matchedItem.self.isClaimed);
                                    matchedItem.self.currentMinutesWatched = drop.self.currentMinutesWatched;
                                }
                            }
                        }
                    }
                }

                if (maxTime === 0) maxTime = 60;

                activeStream.campaigns.push({
                    game: dropCamp.game ? (dropCamp.game.displayName || dropCamp.game.name) : game,
                    id: dropCamp.id,
                    name: dropCamp.name || "",
                    endsAt: dropCamp.endAt ? new Date(dropCamp.endAt).getTime() : (earliestEndsAt || null),
                    startAt: dropCamp.startAt || null,
                    endAt: dropCamp.endAt || null,
                    minutesNeeded: maxTime,
                    minutesWatched: timeWatched,
                    streamers: streams,
                    items: allDrops
                });
            }
            if (earliestEndsAt) {
                activeStream.campaign.endsAt = earliestEndsAt;
            }
        } else {
            const inProgCamp = inventory.dropCampaignsInProgress?.find(c =>
                c.game && areGameNamesMatching(c.game.displayName || c.game.name, game) && isCampaignActiveWithDrops(c, now, inventory)
            );
            let inProgEndsAt = null;
            if (inProgCamp && inProgCamp.endAt) {
                const campEnd = new Date(inProgCamp.endAt).getTime();
                if (!isNaN(campEnd)) inProgEndsAt = campEnd;
            }
            activeStream.campaign.endsAt = inProgEndsAt;

            const items = [];
            let maxTime = 60;
            let timeWatched = 0;

            if (inProgCamp && inProgCamp.timeBasedDrops) {
                for (const d of inProgCamp.timeBasedDrops) {
                    const req = d.requiredMinutesWatched || 60;
                    if (req > maxTime) maxTime = req;
                    const { benefitId, benefitName, benefitImg } = extractBenefitInfo(d);
                    const isClaimed = Boolean(d.self && d.self.isClaimed);
                    const watched = d.self?.currentMinutesWatched || 0;
                    if (watched > timeWatched) timeWatched = watched;

                    const dropStartAt = d.startAt || inProgCamp.startAt || null;
                    const dropEndAt = d.endAt || inProgCamp.endAt || null;
                    const dropEndsAtTs = dropEndAt ? new Date(dropEndAt).getTime() : null;
                    const isEnded = Boolean(dropEndsAtTs && !isNaN(dropEndsAtTs) && dropEndsAtTs <= now);

                    items.push({
                        id: d.id,
                        benefitId: benefitId || null,
                        name: benefitName,
                        picture: benefitImg,
                        reqTime: req,
                        startAt: dropStartAt,
                        endAt: dropEndAt,
                        endsAt: dropEndsAtTs,
                        isEnded: isEnded,
                        self: { isClaimed, currentMinutesWatched: watched }
                    });

                    if (!isClaimed && dropEndsAtTs && !isNaN(dropEndsAtTs) && dropEndsAtTs > now) {
                        if (inProgEndsAt === null || dropEndsAtTs < inProgEndsAt) {
                            inProgEndsAt = dropEndsAtTs;
                        }
                    }
                }
            }

            if (items.length > 0) {
                activeStream.campaigns.push({
                    game: game,
                    id: inProgCamp ? inProgCamp.id : `camp-${gameSlug}`,
                    endsAt: inProgEndsAt,
                    minutesNeeded: maxTime,
                    minutesWatched: timeWatched,
                    streamers: [],
                    items: items
                });
            }
        }

        if (activeStream.campaigns.length > 0) {
            activeStream.campaigns.sort((a, b) => {
                const aFarmable = isCampaignFarmable(a, now);
                const bFarmable = isCampaignFarmable(b, now);
                if (aFarmable !== bFarmable) {
                    return aFarmable ? -1 : 1;
                }
                const aRestricted = Array.isArray(a.streamers) && a.streamers.length > 0;
                const bRestricted = Array.isArray(b.streamers) && b.streamers.length > 0;
                if (aRestricted !== bRestricted) {
                    return aRestricted ? -1 : 1;
                }
                const aEnd = a.endsAt || Infinity;
                const bEnd = b.endsAt || Infinity;
                return aEnd - bEnd;
            });

            const firstFarmableIdx = activeStream.campaigns.findIndex(c => isCampaignFarmable(c, now));
            activeStream.campaign.onCamp = firstFarmableIdx !== -1 ? firstFarmableIdx : 0;

            const curSelectedCamp = activeStream.campaigns[activeStream.campaign.onCamp] || activeStream.campaigns[0];
            if (activeStream.campaign && curSelectedCamp) {
                activeStream.campaign.requiredStreamers = curSelectedCamp.streamers || [];
                if (curSelectedCamp.endsAt) {
                    activeStream.campaign.endsAt = curSelectedCamp.endsAt;
                }
            }
        }

        // If any drops already reached 100% watch time but are unclaimed, attempt immediate claim first
        const hasReadyUnclaimed = activeStream.campaigns.some(c =>
            (c.items || []).some(i => !i.self?.isClaimed && (i.self?.currentMinutesWatched || 0) >= (i.reqTime || 60))
        );
        if (hasReadyUnclaimed) {
            await checkClaimDrop().catch(() => {});
            const refreshedInv = await client.getInventory().catch(() => null);
            if (refreshedInv) {
                inventory = refreshedInv;
                syncCampaignProgressWithInventory(inventory);
            }
        }

        const totalDropsFound = activeStream.campaigns.reduce((sum, c) => sum + (c.items ? c.items.length : 0), 0);
        const hasFarmableDrops = activeStream.campaigns.some(camp => isCampaignFarmable(camp, now));

        if (activeStream.campaigns.length === 0 || totalDropsFound === 0 || !hasFarmableDrops) {
            const allClaimed = totalDropsFound > 0 && activeStream.campaigns.every(c =>
                (c.items || []).every(item => item.self?.isClaimed)
            );
            activeStream.campaign = {
                game: { name: game },
                onCamp: 0,
                curWatching: null,
                slug: gameSlug,
                status: allClaimed ? "completed" : "no_active_drops",
                isManual: Boolean(isManual),
                isCompleted: allClaimed,
                skippedStreamers: [],
                lastMinutesWatched: 0,
                lastProgressTimestamp: Date.now(),
                stallCount: 0,
                endsAt: activeStream.campaign.endsAt || earliestEndsAt
            };
            if (!allClaimed) {
                activeStream.campaigns = [];
            }
            await windowManager("close");
            await saveState(["activeStream"]);
            updateBadgeUI();
            chrome.runtime.sendMessage({
                type: "p:sendCurrentDrops",
                data: {
                    activeStream,
                    claimedInventory: inventory.gameEventDrops || []
                }
            }).catch(() => {});

            if (!isManual && autoDropGames.length > 0) {
                console.log(`[AutoQueue] ${game} has no active/farmable drops (all claimed or ended), skipping to next game...`);
                setGameCooldown(game, Date.now());
                setTimeout(() => advanceAutoQueue(game).catch(() => {}), 500);
            }
            return;
        }

        const isDone = syncCampaignProgressWithInventory(inventory);
        if (isDone && isAllCampaignsDone(activeStream.campaigns, now)) {
            const allClaimed = activeStream.campaigns.every(c =>
                (c.items && c.items.length > 0)
                    ? c.items.every(i => (i.self && i.self.isClaimed) || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)))
                    : c.minutesWatched >= c.minutesNeeded
            );
            activeStream.campaign.isCompleted = allClaimed;
            activeStream.campaign.status = allClaimed ? "completed" : "no_active_drops";
            activeStream.campaign.curWatching = null;
            await windowManager("close");
            await saveState(["activeStream"]);
            updateBadgeUI();
            chrome.runtime.sendMessage({
                type: "p:sendCurrentDrops",
                data: {
                    activeStream,
                    claimedInventory: inventory.gameEventDrops || []
                }
            }).catch(() => {});
            if (!isManual && autoDropGames.length > 0) {
                setGameCooldown(game, Date.now());
                setTimeout(() => advanceAutoQueue(game).catch(() => {}), 500);
            }
            return;
        }

        await saveState(["activeStream"]);
        chrome.runtime.sendMessage({
            type: "p:sendCurrentDrops",
            data: {
                activeStream,
                claimedInventory: inventory.gameEventDrops || []
            }
        }).catch(() => {});
        isCreatingCampaign = false;
        await runCampaign();
    } finally {
        isCreatingCampaign = false;
    }
}

async function advanceAutoQueue(skippedGame) {
    if (!extEnabled || !Array.isArray(autoDropGames) || autoDropGames.length === 0) return false;
    if (isAdvancingQueue) return false; // Prevent recursive or concurrent cascades

    isAdvancingQueue = true;
    try {
        const otherGames = autoDropGames.filter(g => !areGameNamesMatching(g, skippedGame));
        if (otherGames.length === 0) return false;

        const rawCampaigns = await client.getAllDropCampaigns().catch(() => client.getDropCampaigns().catch(() => []));
        const inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
        const campaigns = mergeCampaignsWithInventory(rawCampaigns, inventory);
        const now = getTwitchNow();
        const localNow = Date.now();
        const candidates = [];

        for (const campaign of (campaigns || [])) {
            if (!campaign || !campaign.game) continue;
            const gameName = campaign.game.displayName || campaign.game.name;
            if (otherGames.some(g => areGameNamesMatching(g, gameName)) && isCampaignActiveWithDrops(campaign, now, inventory)) {
                if (isGameOnCooldown(gameName, localNow)) {
                    continue;
                }

                const campaignDetails = await client.getDropCampaignDetails(campaign.id).catch(() => null);
                const endsAt = (campaignDetails && campaignDetails.endAt)
                    ? new Date(campaignDetails.endAt).getTime()
                    : (campaign.endAt ? new Date(campaign.endAt).getTime() : 0);
                if (endsAt && endsAt <= now) continue;

                let hasUnclaimedDrops = false;
                const inProgCamp = inventory?.dropCampaignsInProgress?.find(c => c.id === campaign.id);
                const timeBasedDrops = (campaignDetails && campaignDetails.timeBasedDrops) || campaign.timeBasedDrops || inProgCamp?.timeBasedDrops || [];

                if (timeBasedDrops.length === 0) {
                    hasUnclaimedDrops = true;
                } else {
                    for (const drop of timeBasedDrops) {
                        const dropEnd = drop.endAt ? new Date(drop.endAt).getTime() : (drop.endsAt ? new Date(drop.endsAt).getTime() : NaN);
                        if (!isNaN(dropEnd) && dropEnd <= now) continue;
                        const inProgDrop = inProgCamp?.timeBasedDrops?.find(d => d.id === drop.id);
                        const isClaimed = inProgDrop?.self?.isClaimed || drop?.self?.isClaimed;
                        const watched = inProgDrop?.self?.currentMinutesWatched || 0;
                        const req = drop.requiredMinutesWatched || 60;

                        if (!isClaimed && (req <= 0 || watched < req)) {
                            hasUnclaimedDrops = true;
                            break;
                        }
                    }
                }

                if (hasUnclaimedDrops && !candidates.some(c => areGameNamesMatching(c.game, gameName))) {
                    const queueIdx = autoDropGames.findIndex(g => areGameNamesMatching(g, gameName));
                    candidates.push({
                        game: gameName,
                        queueIdx: queueIdx === -1 ? Number.MAX_SAFE_INTEGER : queueIdx,
                        endsAt: endsAt || (now + 86400000)
                    });
                }
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => (a.queueIdx - b.queueIdx) || (a.endsAt - b.endsAt));
            const nextGame = candidates[0].game;
            console.log(`[AutoQueue] Auto-skipping ${skippedGame || "current game"} -> advancing to next queued game: ${nextGame}`);
            await createCampaign(nextGame, false);
            return true;
        }
    } catch (e) {
        console.error("Error in advanceAutoQueue:", e);
    } finally {
        isAdvancingQueue = false;
    }

    return false;
}

async function checkForDrops() {
    if (!extEnabled) return;
    await fetchTwitchCookiesAndInitClient();

    if (activeStream.campaign === "none" || (activeStream.campaign && activeStream.campaign.isCompleted) || activeStream.campaign?.status === "nostream" || activeStream.campaign?.status === "no_active_drops" || activeStream.campaign?.status === "completed") {
        try {
            const rawCampaigns = await client.getAllDropCampaigns().catch(() => client.getDropCampaigns().catch(() => []));
            const inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
            const campaigns = mergeCampaignsWithInventory(rawCampaigns, inventory);
            const gamesToRun = [];
            const now = getTwitchNow();
            const localNow = Date.now();

            // If all queued games are in cooldown, reset cooldowns so we can re-evaluate
            const queuedCooldownCount = autoDropGames.filter(g => isGameOnCooldown(g, localNow)).length;

            if (queuedCooldownCount >= autoDropGames.length && autoDropGames.length > 0) {
                unstreamableGamesCooldown.clear();
                persistCooldowns();
            }

            for (const campaign of (campaigns || [])) {
                if (!campaign || !campaign.game) continue;
                const gameName = campaign.game.displayName || campaign.game.name;
                const queueIdx = autoDropGames.findIndex(g => areGameNamesMatching(g, gameName));
                if (queueIdx !== -1 && isCampaignActiveWithDrops(campaign, now, inventory)) {
                    if (isGameOnCooldown(gameName, localNow)) {
                        continue;
                    }

                    let endsAt = campaign.endAt ? new Date(campaign.endAt).getTime() : (now + 86400000);
                    if (Array.isArray(campaign.timeBasedDrops) && campaign.timeBasedDrops.length > 0) {
                        const activeDropEndTimes = campaign.timeBasedDrops
                            .filter(d => d && d.endAt)
                            .map(d => new Date(d.endAt).getTime())
                            .filter(t => !Number.isNaN(t) && t > now);
                        if (activeDropEndTimes.length > 0) {
                            endsAt = Math.min(...activeDropEndTimes);
                        }
                    }
                    if (endsAt <= now) continue;

                    const existingEntry = gamesToRun.find((g) => areGameNamesMatching(g.game, gameName));
                    if (!existingEntry) {
                        gamesToRun.push({ game: gameName, queueIdx, endsAt });
                    } else if (endsAt < existingEntry.endsAt) {
                        existingEntry.endsAt = endsAt;
                    }
                }
            }

            if (gamesToRun.length !== 0) {
                gamesToRun.sort((a, b) => (a.queueIdx - b.queueIdx) || (a.endsAt - b.endsAt));
                await createCampaign(gamesToRun[0].game, false);
            } else if (activeStream.campaign?.isManual && activeStream.campaign?.status === "nostream") {
                const gameName = activeStream.campaign.game?.name;
                if (!isGameOnCooldown(gameName, localNow)) {
                    console.log(`[ManualCampaign] Re-checking if a stream has started for ${gameName}...`);
                    await runCampaign();
                }
            }
        } catch (e) {
            console.error("Error in checkForDrops:", e);
        }
    }
}

async function checkClaimDrop() {
    if (!client) return 0;
    let claimedCount = 0;
    try {
        const inventory = await client.getInventory();
        if (!inventory || !inventory.dropCampaignsInProgress) return 0;

        for (const camp of inventory.dropCampaignsInProgress) {
            for (const drop of (camp.timeBasedDrops || [])) {
                if (drop.requiredMinutesWatched !== 0 && drop.self && drop.requiredMinutesWatched <= drop.self.currentMinutesWatched && !drop.self.isClaimed) {
                    const dropInstanceId = drop.self.dropInstanceID;
                    if (!dropInstanceId) continue;
                    if (isDuplicateBackgroundClaim("drop-claim-" + dropInstanceId, 30000)) continue;

                    try {
                        const dropClaim = await client.claimDropReward(dropInstanceId);
                        if (dropClaim && dropClaim.status === "DROP_INSTANCE_ALREADY_CLAIMED") {
                            drop.self.isClaimed = true;
                            continue;
                        }
                        if (dropClaim && (dropClaim.status === "SUCCESS" || dropClaim.status === "ELIGIBLE_FOR_CLAIM" || dropClaim.success === true)) {
                            drop.self.isClaimed = true;
                            claimedCount++;
                            const { benefitName, benefitImg } = extractBenefitInfo(drop);
                            const rewardTitle = drop.name || benefitName || "Drop Reward";
                            const gameName = camp.game ? (camp.game.displayName || camp.game.name) : "Twitch Drop";
                            extStats.claimedDrops++;
                            logActivity("drop", rewardTitle, gameName, 0, benefitImg);
                            notifyUser("Drop Reward Claimed!", `Successfully claimed ${rewardTitle} for ${gameName}`);
                            await saveState(["extStats", "activityHistory"]);
                            chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                            chrome.runtime.sendMessage({ type: "p:rewardClaimedSound" }).catch(() => {});
                        }
                    } catch (err) {
                        console.error("Failed to claim drop reward:", dropInstanceId, err);
                    }
                }
            }
        }
    } catch (e) {
        console.error("Error in checkClaimDrop:", e);
    }
    return claimedCount;
}

// --- 4-Tier Silent Client-Integrity Pipeline ---

function resolvePendingIntegrityWaiters(success) {
    if (pendingIntegrityWaiters.length === 0) return;
    const waiters = pendingIntegrityWaiters.splice(0, pendingIntegrityWaiters.length);
    for (const w of waiters) {
        try {
            clearTimeout(w.timer);
            w.resolve(Boolean(success));
        } catch (e) {}
    }
}

async function cleanupIntegrityTabAndWindow() {
    const updates = {};
    if (autoGetTokenTabId !== 0) {
        const tabId = autoGetTokenTabId;
        autoGetTokenTabId = 0;
        updates.autoGetTokenTabId = 0;
        if (typeof chrome !== "undefined" && chrome.tabs?.remove) {
            chrome.tabs.remove(tabId).catch(() => {});
        }
    }
    if (autoGetTokenWindow !== 0) {
        const winId = autoGetTokenWindow;
        autoGetTokenWindow = 0;
        updates.autoGetTokenWindow = 0;
        if (typeof chrome !== "undefined" && chrome.windows?.remove) {
            chrome.windows.remove(winId).catch(() => {});
        }
    }
    if (Object.keys(updates).length > 0 && typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set(updates).catch(() => {});
    }
    if (typeof chrome !== "undefined" && chrome.alarms?.clear) {
        chrome.alarms.clear("autoGetTokenCleanupAlarm").catch(() => {});
    }
}

async function applyCapturedIntegrity(payload) {
    if (!payload) return false;
    let token = null;
    let expiration = null;
    let nextSessionId = null;
    let nextClientVersion = null;

    if (typeof payload === "string") {
        token = payload.trim() || null;
    } else if (typeof payload === "object") {
        token = typeof payload.token === "string" && payload.token.trim() ? payload.token.trim() : null;
        if (typeof payload.expiration === "number" && Number.isFinite(payload.expiration)) {
            expiration = payload.expiration;
        }
        if (typeof payload.clientSessionId === "string" && payload.clientSessionId.trim()) {
            nextSessionId = payload.clientSessionId.trim();
        }
        if (typeof payload.clientVersion === "string" && payload.clientVersion.trim()) {
            nextClientVersion = payload.clientVersion.trim();
        }
    }

    const sessionUpdates = {};
    if (nextSessionId && nextSessionId !== clientSessionId) {
        clientSessionId = nextSessionId;
        sessionUpdates.clientSessionId = clientSessionId;
    }
    if (nextClientVersion && nextClientVersion !== clientVersion) {
        clientVersion = nextClientVersion;
        sessionUpdates.clientVersion = clientVersion;
    }
    if (Object.keys(sessionUpdates).length > 0) {
        if (client) {
            client.updateUserInfo({ uuid: clientSessionId, clientVersion });
        }
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
            await chrome.storage.local.set(sessionUpdates).catch(() => {});
        }
    }

    if (!token) return false;

    const existingObj = (client && client.integrity && typeof client.integrity === "object") ? client.integrity : null;
    // If caller only sniffed a header token (no server expiration), preserve any existing longer expiration for the same token
    if (expiration === null) {
        if (existingObj && existingObj.token === token && typeof existingObj.expiration === "number" && existingObj.expiration > Date.now()) {
            expiration = existingObj.expiration;
        } else {
            expiration = Date.now() + 3600000;
        }
    }

    const isIdentical = Boolean(
        existingObj &&
        existingObj.token === token &&
        existingObj.expiration === expiration &&
        Object.keys(sessionUpdates).length === 0
    );

    if (!isIdentical) {
        const integObj = { token, expiration };
        if (client === null) {
            if (typeof chrome !== "undefined" && chrome.storage?.local) {
                await chrome.storage.local.set({ twitchInteg: integObj }).catch(() => {});
            }
            await fetchTwitchCookiesAndInitClient();
        } else {
            await client.setInteg(integObj);
        }
    }

    await cleanupIntegrityTabAndWindow();
    resolvePendingIntegrityWaiters(true);
    return true;
}

async function requestIntegrityFromTab(tabId, timeoutMs = 5000) {
    if (typeof tabId !== "number" || typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
        return false;
    }
    const requestId = `integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
        const response = await new Promise((resolve) => {
            let settled = false;
            const finish = (val) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(val);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            try {
                const maybePromise = chrome.tabs.sendMessage(tabId, {
                    type: "atd:requestIntegrity",
                    requestId
                }, (res) => {
                    if (chrome.runtime?.lastError) {
                        finish(null);
                    } else {
                        finish(res || null);
                    }
                });
                if (maybePromise && typeof maybePromise.then === "function") {
                    maybePromise.then((res) => finish(res || null)).catch(() => finish(null));
                }
            } catch (e) {
                finish(null);
            }
        });

        if (response && response.ok && response.token) {
            return await applyCapturedIntegrity(response);
        }
    } catch (e) {}
    return false;
}

async function refreshIntegrityToken({ force = false, allowTabFallback = false, reason = "" } = {}) {
    while (integrityRefreshPromise) {
        const wasTabAllowed = integrityRefreshAllowsTab;
        const inFlightOk = await integrityRefreshPromise.catch(() => false);
        if (inFlightOk) return true;
        if (!allowTabFallback || wasTabAllowed) return false;
    }

    integrityRefreshAllowsTab = Boolean(allowTabFallback);
    const run = (async () => {
        if (!client) await fetchTwitchCookiesAndInitClient();
        if (!client || !client.oauthToken) return false;

        // Already fresh check
        if (!force && (await client.getInteg())) {
            return true;
        }

        // Tier 1: Silent Service Worker direct POST to https://gql.twitch.tv/integrity (0 windows, 0 tabs)
        if (typeof client.fetchIntegrity === "function") {
            const direct = await client.fetchIntegrity().catch(() => ({ ok: false }));
            if (direct && direct.ok) {
                return true;
            }
        }

        // Tier 2: Silent proxy via an already-open Twitch tab (0 windows, 0 new tabs)
        if (typeof chrome !== "undefined" && chrome.tabs?.query && chrome.tabs?.sendMessage) {
            const tabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
            const candidates = (Array.isArray(tabs) ? tabs : [])
                .filter(t => t && typeof t.id === "number" && !t.discarded)
                .sort((a, b) => (b.status === "complete" ? 1 : 0) - (a.status === "complete" ? 1 : 0))
                .slice(0, 2);
            for (const tab of candidates) {
                const ok = await requestIntegrityFromTab(tab.id, 5000);
                if (ok) return true;
            }
        }

        // Tier 3: Smart gating — startup, 15m alarm, read-only queries & channel points NEVER open tabs/windows
        if (!allowTabFallback || settings.autoGetToken !== true) {
            return false;
        }

        // Tier 4: Last-resort silent background tab (only for DropsPage_ClaimDropRewards, 15m cooldown, ZERO popup windows)
        const now = Date.now();
        if (autoGetTokenTabId !== 0) {
            return false;
        }
        if (lastIntegrityTabAttemptAt && (now - lastIntegrityTabAttemptAt) < INTEGRITY_TAB_COOLDOWN_MS) {
            return false;
        }
        if (typeof chrome === "undefined" || !chrome.tabs?.create) {
            return false;
        }

        lastIntegrityTabAttemptAt = now;
        if (chrome.storage?.local) {
            await chrome.storage.local.set({ lastIntegrityTabAttemptAt }).catch(() => {});
        }

        const bgTab = await chrome.tabs.create({
            url: "https://www.twitch.tv/drops/inventory",
            active: false
        }).catch(() => null);
        if (!bgTab || typeof bgTab.id !== "number") {
            return false;
        }

        const tabId = bgTab.id;
        autoGetTokenTabId = tabId;

        // Register waiter synchronously BEFORE any await so a fast sendInteg cannot be missed
        const waiterPromise = new Promise((resolve) => {
            const waiter = {
                resolve,
                timer: setTimeout(() => {
                    const idx = pendingIntegrityWaiters.indexOf(waiter);
                    if (idx !== -1) pendingIntegrityWaiters.splice(idx, 1);
                    resolve(false);
                }, 12000)
            };
            pendingIntegrityWaiters.push(waiter);
        });

        if (chrome.storage?.local) {
            await chrome.storage.local.set({ autoGetTokenTabId: tabId }).catch(() => {});
        }
        if (chrome.alarms && typeof chrome.alarms.create === "function") {
            chrome.alarms.create("autoGetTokenCleanupAlarm", { delayInMinutes: 1 });
        }

        // If sendInteg already resolved and closed the tab during storage.local.set, finish immediately
        if (autoGetTokenTabId !== tabId) {
            return Boolean(await client.getInteg());
        }

        // 20-second hard failsafe cleanup
        const hardCleanupTimer = setTimeout(() => {
            if (autoGetTokenTabId === tabId) {
                cleanupIntegrityTabAndWindow().catch(() => {});
            }
        }, 20000);

        // At 4 seconds, proactively nudge the tab to mint integrity in case /drops/inventory didn't trigger it
        const nudgeTimer = setTimeout(() => {
            if (autoGetTokenTabId === tabId) {
                requestIntegrityFromTab(tabId, 5000).catch(() => {});
            }
        }, 4000);

        const captured = await waiterPromise;

        clearTimeout(nudgeTimer);
        clearTimeout(hardCleanupTimer);
        if (autoGetTokenTabId === tabId) {
            await cleanupIntegrityTabAndWindow();
        }
        return Boolean(captured);
    })();

    integrityRefreshPromise = run;
    try {
        return await run;
    } finally {
        if (integrityRefreshPromise === run) {
            integrityRefreshPromise = null;
            integrityRefreshAllowsTab = false;
        }
    }
}

function autoGetToken(force = false) {
    if (settings.autoGetToken !== true) return Promise.resolve(false);
    return refreshIntegrityToken({
        force: Boolean(force),
        allowTabFallback: false,
        reason: "autoGetToken"
    }).catch(() => false);
}

if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved?.addListener) {
    chrome.tabs.onRemoved.addListener(async (tabId) => {
        await hydrateState();
        if (tabId === autoGetTokenTabId) {
            autoGetTokenTabId = 0;
            await chrome.storage.local.set({ autoGetTokenTabId: 0 }).catch(() => {});
            resolvePendingIntegrityWaiters(false);
        }
    });
}

if (typeof chrome !== "undefined" && chrome.windows?.onRemoved?.addListener) {
    chrome.windows.onRemoved.addListener(async (windowId) => {
        await hydrateState();
        if (windowId === autoGetTokenWindow) {
            autoGetTokenWindow = 0;
            await chrome.storage.local.set({ autoGetTokenWindow: 0 }).catch(() => {});
        }
    });
}

async function windowManager(func) {
    if (func === "close") {
        stopHeadlessWatchLoop();
        await saveState(["activeStream"]);
    }
}

let lastBadgeState = "";

function updateBadgeUI() {
    try {
        if (!chrome.action || !chrome.action.setBadgeText) return;
        let text = "";
        let color = "#9146FF";

        if (settings.setShowBadges === false) {
            text = "";
        } else if (!extEnabled) {
            text = "OFF";
            color = "#52525b";
        } else if (activeStream && activeStream.campaign && activeStream.campaign !== "none") {
            const camp = activeStream.campaign;
            if (camp.isCompleted || camp.status === "completed") {
                text = "✓";
                color = "#00e676";
            } else if (camp.status === "nostream") {
                text = "…";
                color = "#f0a232";
            } else if (camp.status === "no_active_drops") {
                text = "";
                color = "#52525b";
            } else if (activeStream.campaigns && activeStream.campaigns.length > 0) {
                const nowMs = getTwitchNow();
                const getFarmableItemForCamp = (c) => {
                    if (!c || !Array.isArray(c.items) || c.items.length === 0) return null;
                    const sorted = [...c.items].sort((a, b) => {
                        const reqA = a?.reqTime || a?.requiredMinutesWatched || 60;
                        const reqB = b?.reqTime || b?.requiredMinutesWatched || 60;
                        return reqA - reqB;
                    });
                    const isItemFarmable = (i) => {
                        if (!i || i.self?.isClaimed) return false;
                        const req = i.reqTime || i.requiredMinutesWatched || 60;
                        const watched = (i.self && typeof i.self.currentMinutesWatched === "number")
                            ? i.self.currentMinutesWatched
                            : (c.minutesWatched || 0);
                        if (req > 0 && watched >= req) return false;
                        const dropEnd = i.endAt ? new Date(i.endAt).getTime() : (i.endsAt ? new Date(i.endsAt).getTime() : (c.endsAt || NaN));
                        if (i.isEnded || (!isNaN(dropEnd) && dropEnd <= nowMs)) return false;
                        return true;
                    };
                    if (camp.activeDropId) {
                        const activeMatch = sorted.find(i => i && i.id === camp.activeDropId && isItemFarmable(i));
                        if (activeMatch) return { item: activeMatch, camp: c };
                    }
                    const firstFarmable = sorted.find(isItemFarmable);
                    return firstFarmable ? { item: firstFarmable, camp: c } : null;
                };

                const primaryIdx = (typeof camp.onCamp === "number" && camp.onCamp >= 0) ? camp.onCamp : 0;
                const primaryCamp = activeStream.campaigns[primaryIdx] || activeStream.campaigns[0];
                let found = getFarmableItemForCamp(primaryCamp);
                if (!found && activeStream.campaigns.length > 1) {
                    for (let idx = 0; idx < activeStream.campaigns.length; idx++) {
                        if (idx === primaryIdx) continue;
                        found = getFarmableItemForCamp(activeStream.campaigns[idx]);
                        if (found) break;
                    }
                }

                if (found && found.item) {
                    const req = found.item.reqTime || found.item.requiredMinutesWatched || 60;
                    const watched = (found.item.self && typeof found.item.self.currentMinutesWatched === "number")
                        ? found.item.self.currentMinutesWatched
                        : (found.camp.minutesWatched || 0);
                    const left = Math.max(0, Math.ceil(req - watched));
                    text = left > 0 ? `${left}m` : "✓";
                    color = left > 0 ? "#9146FF" : "#00e676";
                } else if (primaryCamp) {
                    const left = primaryCamp.minutesNeeded
                        ? Math.max(0, Math.ceil(primaryCamp.minutesNeeded - (primaryCamp.minutesWatched || 0)))
                        : 0;
                    text = left > 0 ? `${left}m` : "✓";
                    color = left > 0 ? "#9146FF" : "#00e676";
                } else {
                    text = "…";
                }
            }
        } else if (settings.setShowBadges) {
            text = "";
        }

        const badgeKey = `${text}|${color}`;
        if (badgeKey === lastBadgeState) return;
        lastBadgeState = badgeKey;
        chrome.action.setBadgeText({ text }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
    } catch (e) {}
}