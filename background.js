/** 
 * Auto Twitch Drops Pro - Background Service Worker (Manifest V3)
 **/
import { Client, TwitchApiError, isCampaignActiveWithDrops, isCampaignFarmable, isOverwatchGame, areGameNamesMatching, getTwitchNow } from "./background/twitchApi.js";

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

// Deduplication cache for background claim and point actions
const recentBgClaims = new Map();
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
    setShowBadges: true,
    soundOnClaim: false,
    desktopNotifications: true,
    autoCheckUpdates: true
};
let listOfConnected = [...POPULAR_DROP_GAMES];
let autoDropGames = [];
let priorityStreams = [];
let unstreamableGamesCooldown = new Map();
const UNSTREAMABLE_COOLDOWN_MS = 5 * 60 * 1000;

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
}

function clearGameCooldown(gameName) {
    if (!gameName) return;
    for (const key of Array.from(unstreamableGamesCooldown.keys())) {
        if (areGameNamesMatching(key, gameName)) {
            unstreamableGamesCooldown.delete(key);
        }
    }
}
let isAdvancingQueue = false;
let extStats = {
    claimedDrops: 0,
    claimedPoints: 0,
    installed: new Date().toISOString(),
    premium: true,
    connectedGames: []
};
let activityHistory = [];
let extEnabled = true;
let activeStream = {
    campaign: "none"
};
let gettingStreamObj = {
    allStreamers: [],
    notPlayingGame: [],
    lastPull: 0
};
let autoGetTokenWindow = 0;
let isHydrated = false;
let hydrationPromise = null;
let headlessWatchInterval = null;
let isSendingWatchPulse = false;

function applyDropSessionProgress(session) {
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
        for (const campObj of activeStream.campaigns) {
            if (!Array.isArray(campObj.items)) continue;
            const found = campObj.items.find(i => i && i.id === dropId);
            if (found) {
                matchedCamp = campObj;
                matchedItem = found;
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
        matchedItem = matchedCamp.items.find(i => i && i.isSynthetic)
            || (req > 0 ? matchedCamp.items.find(i => i && !i.self?.isClaimed && !i.isEnded && !(i.endsAt && i.endsAt <= nowTs) && i.reqTime === req) : null)
            || matchedCamp.items.find(i => i && !i.self?.isClaimed && !i.isEnded && !(i.endsAt && i.endsAt <= nowTs));
    }

    if (matchedItem) {
        matchedItem.self = matchedItem.self || {};
        const prevWatched = matchedItem.self.currentMinutesWatched || 0;
        if (watched > prevWatched) {
            matchedItem.self.currentMinutesWatched = watched;
            changed = true;
        }
        if (matchedItem.isSynthetic && dropId) {
            matchedItem.id = dropId;
            matchedItem.isSynthetic = false;
            changed = true;
        }
        if (req > 0 && (matchedItem.isSynthetic || !matchedItem.reqTime)) {
            matchedItem.reqTime = req;
            changed = true;
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

    if (req > 0 && watched >= req) {
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
        let meta = preFetchedMeta;
        if (meta && meta.channelId && meta.broadcastId) {
            activeStream.campaign.streamMeta = { ...meta, login: streamer.toLowerCase() };
        } else if (
            activeStream.campaign.streamMeta &&
            activeStream.campaign.streamMeta.login === streamer.toLowerCase() &&
            activeStream.campaign.streamMeta.channelId &&
            activeStream.campaign.streamMeta.broadcastId
        ) {
            meta = activeStream.campaign.streamMeta;
        } else if (typeof client.getStreamMetadata === "function") {
            meta = await client.getStreamMetadata(streamer).catch(() => null);
            if (meta && meta.channelId && meta.broadcastId) {
                activeStream.campaign.streamMeta = { ...meta, login: streamer.toLowerCase() };
            }
        }

        const watchRes = await client.sendWatch(streamer, meta || {});
        if (watchRes && watchRes.success) {
            activeStream.campaign.lastWatchPulse = Date.now();
            activeStream.campaign.watchMethod = watchRes.method || "hls";

            if (typeof client.getCurrentDropSession === "function") {
                const session = await client.getCurrentDropSession(meta?.channelId || "", streamer).catch(() => null);
                if (session && applyDropSessionProgress(session)) {
                    await saveState();
                    updateBadgeUI();
                    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                }
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

async function saveState() {
    try {
        await chrome.storage.local.set({
            activeStream,
            extStats,
            settings,
            autoDropGames,
            listOfConnected,
            autoGetTokenWindow,
            activityHistory: activityHistory.slice(0, 50)
        });
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
                "priorityStreams",
                "extStats",
                "listOfConnected",
                "activeStream",
                "autoGetTokenWindow",
                "activityHistory",
                "oauthToken",
                "deviceId",
                "userId",
                "uuid",
                "twitchInteg"
            ]);

            extEnabled = val.exEnabled !== undefined ? val.exEnabled : true;
            if (val.settings) settings = { ...settings, ...val.settings };
            if (val.autoDropGames) autoDropGames = val.autoDropGames;
            if (val.priorityStreams) priorityStreams = val.priorityStreams;
            if (val.listOfConnected && val.listOfConnected.length > 0) {
                listOfConnected = Array.from(new Set([...val.listOfConnected, ...POPULAR_DROP_GAMES]));
            }
            if (val.activityHistory) activityHistory = val.activityHistory;
            if (val.extStats) extStats = { ...extStats, ...val.extStats };

            if (val.autoGetTokenWindow !== undefined) autoGetTokenWindow = val.autoGetTokenWindow;
            if (val.activeStream && val.activeStream.campaign && val.activeStream.campaign !== "none") {
                if (val.activeStream.campaign.status === "starting" && (!val.activeStream.campaigns || val.activeStream.campaigns.length === 0)) {
                    activeStream = { campaign: "none" };
                } else {
                    activeStream = val.activeStream;
                }
            }

            await fetchTwitchCookiesAndInitClient();
            isHydrated = true;
        } catch (e) {
            console.warn("Error hydrating state:", e);
        } finally {
            hydrationPromise = null;
        }
    })();

    return await hydrationPromise;
}

function notifyUser(title, message) {
    if (settings.desktopNotifications && chrome.notifications) {
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
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
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

        let oauthToken = authCookie ? authCookie.value : null;
        let deviceId = deviceCookie ? deviceCookie.value : null;

        const localData = await chrome.storage.local.get(["oauthToken", "deviceId", "userId", "uuid", "twitchInteg"]).catch(() => ({}));

        oauthToken = oauthToken || localData.oauthToken;
        deviceId = deviceId || localData.deviceId;
        const integrity = localData.twitchInteg || null;

        if (oauthToken) {
            await chrome.storage.local.set({ oauthToken, deviceId }).catch(() => {});
            if (client === null) {
                client = new Client({ clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko", oauthToken, deviceId, userId: localData.userId, uuid: localData.uuid, integrity });
            } else {
                client.updateUserInfo({ oauthToken, deviceId, userId: localData.userId, uuid: localData.uuid, integrity });
            }
            if (!localData.userId) {
                await client.autoDetectUserId().catch(() => {});
            }
        } else if (client === null) {
            client = new Client({ clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko", integrity });
        }
    } catch (e) {
        console.warn("Error fetching Twitch cookies:", e);
        if (client === null) {
            client = new Client({ clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko" });
        }
    }
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
    return allCampaignsCompleted;
}

// --- GitHub Auto-Update Mechanism ---

export function compareSemver(a, b) {
    if (!a || !b) return 0;
    const pa = String(a).replace(/^v/i, "").split(".").map(Number);
    const pb = String(b).replace(/^v/i, "").split(".").map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = isNaN(pa[i]) ? 0 : pa[i];
        const nb = isNaN(pb[i]) ? 0 : pb[i];
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

export async function checkGitHubUpdate(manual = false) {
    const currentVersion = (typeof chrome !== "undefined" && chrome.runtime?.getManifest?.()?.version) || "2.0.0";
    const result = {
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
        try {
            const relRes = await fetch("https://api.github.com/repos/K9Paradox/Twitch-drop/releases/latest", {
                headers: { "Accept": "application/vnd.github.v3+json" }
            });
            if (relRes.ok) {
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
                if (rawRes.ok) {
                    const rawManifest = await rawRes.json();
                    if (rawManifest && rawManifest.version) {
                        result.latestVersion = rawManifest.version;
                        if (compareSemver(rawManifest.version, currentVersion) > 0) {
                            result.updateAvailable = true;
                            result.releaseUrl = "https://github.com/K9Paradox/Twitch-drop";
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
            if (commitRes.ok) {
                const commitData = await commitRes.json();
                if (commitData) {
                    result.commitSha = (commitData.sha || "").substring(0, 7);
                    result.commitMessage = commitData.commit?.message?.split("\n")[0] || "";
                }
            }
        } catch (e) {
            // Non-critical commit metadata error
        }

        // Store update status in chrome.storage.local
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
    if (!extEnabled) return;

    if (alarm.name === "watchdogAlarm") {
        await handleWatchdogTick();
    } else if (alarm.name === "dropCheckAlarm") {
        await checkForDrops();
    } else if (alarm.name === "tokenRefreshAlarm") {
        autoGetToken();
    } else if (alarm.name === "badgeRefreshAlarm") {
        updateBadgeUI();
    } else if (alarm.name === "githubUpdateAlarm") {
        if (settings.autoCheckUpdates !== false) {
            await checkGitHubUpdate(false);
        }
    }
});

async function handleWatchdogTick() {
    if (!extEnabled) return;
    if (activeStream && activeStream.campaign && activeStream.campaign !== "none" && activeStream.campaign.status === "watching") {
        if (!client) await fetchTwitchCookiesAndInitClient();
        if (client) {
            // 1. Inventory Sync & Drop Claiming
            const inventory = await client.getInventory().catch(() => null);
            if (inventory) {
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
                        activeStream.campaign.isCompleted = true;
                    }
                    await windowManager("close");
                    await saveState();
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

                const isDone = syncCampaignProgressWithInventory(inventory);
                await checkClaimDrop();

                if (isDone) {
                    const nowTs = getTwitchNow();
                    const allDone = activeStream.campaigns && activeStream.campaigns.every(c => {
                        return (c.items && c.items.length > 0)
                            ? c.items.every(i => (i.self && i.self.isClaimed) || (i.endsAt && i.endsAt <= nowTs) || i.isEnded || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)))
                            : c.minutesWatched >= c.minutesNeeded;
                    });

                    if (allDone) {
                        const gameName = activeStream.campaign.game ? activeStream.campaign.game.name : "Target Game";
                        notifyUser("Drop Campaign Completed", `All available drops for ${gameName} have been claimed!`);
                        if (activeStream.campaign) {
                            activeStream.campaign.isCompleted = true;
                            activeStream.campaign.curWatching = null;
                        }
                        await windowManager("close");
                        await saveState();
                        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                        await checkForDrops();
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
                        await saveState();
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
                                await saveState();
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
                    const isOffline = !meta || !meta.game;
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
                    }
                } else if (activeStream.campaign && (activeStream.campaign.status === "nostream" || !activeStream.campaign.curWatching) && !activeStream.campaign.isCompleted && activeStream.campaign.status !== "no_active_drops") {
                    console.log(`[Watchdog] Active campaign for ${activeStream.campaign.game?.name} has no active stream (${activeStream.campaign.status}). Retrying streamer search...`);
                    await runCampaign(true);
                    return;
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
                                console.log(`Persistent stall detected for ${activeStream.campaign.curWatching} (0m gained in 12m). Rotating to next channel.`);
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

                await saveState();
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
            }
        }
    }
}

// --- Message Listener (MV3 Compliant) ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    (async () => {
        await hydrateState();

        if (message.type === "toggleExt") {
            extEnabled = Boolean(message.data);
            await chrome.storage.local.set({ exEnabled: extEnabled });
            if (extEnabled) {
                await fetchTwitchCookiesAndInitClient();
                setupAlarms();
                setTimeout(checkForDrops, 1500);
            } else {
                chrome.alarms.clearAll();
                stopHeadlessWatchLoop();
                if (activeStream.campaign !== "none") {
                    await endCampaign();
                }
                activeStream = { campaign: "none" };
                await saveState();
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
            }
            sendResponse({ success: true, extEnabled });
            return;
        }

        if (!extEnabled) {
            sendResponse({ status: "disabled" });
            return;
        }

        switch (message.type) {
            case "clientInfo":
                if (message.data && message.data.oauthToken) {
                    if (client === null) client = new Client(message.data);
                    else client.updateUserInfo(message.data);
                    await chrome.storage.local.set({
                        oauthToken: message.data.oauthToken,
                        deviceId: message.data.deviceId,
                        userId: message.data.userId,
                        uuid: message.data.uuid
                    });
                }
                sendResponse({ success: true });
                break;

            case "sendInteg":
                if (client === null) {
                    await chrome.storage.local.set({ twitchInteg: message.data });
                    await fetchTwitchCookiesAndInitClient();
                } else {
                    client.setInteg(message.data);
                }
                if (autoGetTokenWindow !== 0) {
                    chrome.windows.remove(autoGetTokenWindow).catch(() => {});
                    autoGetTokenWindow = 0;
                    await chrome.storage.local.set({ autoGetTokenWindow: 0 }).catch(() => {});
                }
                sendResponse({ success: true });
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
                                    const benefit = d.benefitEdges?.[0]?.benefit || d.benefitEdges?.[0]?.node;
                                    const benefitImg = benefit?.imageAssetURL || benefit?.imageURL || d.imageURL || d.imageAssetURL || "";
                                    const benefitName = benefit?.name ? (d.name ? `${d.name} - ${benefit.name}` : benefit.name) : (d.name || "Drop Reward");
                                    const dropEnd = d.endAt || c.endAt || null;
                                    const dropEndsAt = dropEnd ? new Date(dropEnd).getTime() : null;
                                    const isEnded = Boolean(dropEndsAt && !isNaN(dropEndsAt) && dropEndsAt <= nowTs);
                                    
                                    extractedItems.push({
                                        id: d.id,
                                        campaignId: c.id || null,
                                        benefitId: benefit?.id || null,
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
                                    const benefit = d.benefitEdges?.[0]?.benefit || d.benefitEdges?.[0]?.node;
                                    const benefitImg = benefit?.imageAssetURL || benefit?.imageURL || d.imageURL || d.imageAssetURL || "";
                                    const benefitName = benefit?.name ? (d.name ? `${d.name} - ${benefit.name}` : benefit.name) : (d.name || "Drop Reward");
                                    const dropEnd = d.endAt || c.endAt || null;
                                    const dropEndsAt = dropEnd ? new Date(dropEnd).getTime() : null;
                                    const isEnded = Boolean(dropEndsAt && !isNaN(dropEndsAt) && dropEndsAt <= nowTs);

                                    extractedItems.push({
                                        id: d.id,
                                        campaignId: c.id || null,
                                        benefitId: benefit?.id || null,
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
                                const benefit = (currentDrop.benefitEdges && currentDrop.benefitEdges[0]) ? (currentDrop.benefitEdges[0].benefit || currentDrop.benefitEdges[0].node) : null;
                                const dropImg = benefit?.imageAssetURL || currentDrop.imageURL || currentDrop.imageAssetURL || "";
                                const dropTitle = benefit?.name ? (currentDrop.name ? `${currentDrop.name} - ${benefit.name}` : benefit.name) : (currentDrop.name || "Drop Reward");

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
                                        benefitId: benefit?.id || null,
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

                        await saveState();
                        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                    }
                }
                sendResponse({ success: true });
                break;

            case "claim-points":
                await fetchTwitchCookiesAndInitClient();
                if (client && message.data) {
                    try {
                        const claimId = message.data.claimID;
                        const channelId = message.data.channelID;
                        if (!isDuplicateBackgroundClaim("claim-" + claimId, 15000)) {
                            const result = await client.claimChannelPoints(channelId, claimId);
                            if (result && (result.success || result.status === "SUCCESS")) {
                                const pts = result.points || 50;
                                extStats.claimedPoints += pts;
                                logActivity("points", `+${pts} Channel Points`, "Twitch Channel", pts);
                                await saveState();
                                chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                                chrome.runtime.sendMessage({ type: "p:activityUpdated", data: activityHistory }).catch(() => {});
                            }
                        }
                    } catch (e) {
                        console.error("Error claiming points:", e);
                    }
                }
                sendResponse({ success: true });
                break;

            case "points-earned":
                if (message.data) {
                    const earned = message.data.points || 50;
                    const src = message.data.source || "generic";
                    if (!isDuplicateBackgroundClaim("points-earned-" + earned + "-" + src, 3000)) {
                        extStats.claimedPoints += earned;
                        logActivity("points", `+${earned} Channel Points (Watch Bonus)`, "Twitch Stream", earned);
                        await saveState();
                        chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                        chrome.runtime.sendMessage({ type: "p:activityUpdated", data: activityHistory }).catch(() => {});
                    }
                }
                sendResponse({ success: true });
                break;

            case "claim-drop":
                await fetchTwitchCookiesAndInitClient();
                if (client) {
                    await checkClaimDrop();
                }
                sendResponse({ success: true });
                break;

            case "p:getConnectedGames":
                await fetchTwitchCookiesAndInitClient();
                try {
                    const rawData = await client.getAllDropCampaigns().catch(() => client.getDropCampaigns().catch(() => []));
                    const inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
                    const data = mergeCampaignsWithInventory(rawData, inventory);
                    if (Array.isArray(data) && data.length > 0) {
                        const nowTs = getTwitchNow();
                        for (const c of data) {
                            const gDisplay = c?.game?.displayName || c?.game?.name;
                            if (gDisplay && !listOfConnected.includes(gDisplay)) {
                                listOfConnected.push(gDisplay);
                            }
                        }
                        listOfConnected = Array.from(new Set([...listOfConnected, ...POPULAR_DROP_GAMES]));
                        extStats.connectedGames = listOfConnected;
                        await saveState();

                        const activeGameNames = new Set(
                            data.filter(c => isCampaignActiveWithDrops(c, nowTs, inventory))
                                .map(c => c.game.displayName || c.game.name)
                        );
                        const enhancedGames = data.map(c => ({
                            ...c,
                            hasActiveDrops: isCampaignActiveWithDrops(c, nowTs, inventory)
                        }));
                        const allEnhanced = listOfConnected.map(g => {
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
                        chrome.runtime.sendMessage({ type: "p:connectedGames", data: enhancedGames, allGames: allEnhanced }).catch(() => {});
                        chrome.runtime.sendMessage({
                            type: "setAutoDropGames",
                            data: { allConnected: activeList, enabled: autoDropGames }
                        }).catch(() => {});
                        sendResponse({ games: enhancedGames, allGames: allEnhanced });
                        return;
                    }
                } catch (e) {
                    console.error("Error fetching connected games:", e);
                }

                listOfConnected = Array.from(new Set([...listOfConnected, ...POPULAR_DROP_GAMES]));
                const defaultGames = listOfConnected.map(g => ({
                    game: { displayName: g },
                    self: { isAccountConnected: true },
                    hasActiveDrops: false
                }));
                chrome.runtime.sendMessage({ type: "p:connectedGames", data: defaultGames, allGames: defaultGames }).catch(() => {});
                chrome.runtime.sendMessage({
                    type: "setAutoDropGames",
                    data: { allConnected: [], enabled: autoDropGames }
                }).catch(() => {});
                sendResponse({ games: defaultGames, allGames: defaultGames });
                break;

            case "p:startCampaign":
                try {
                    if (message.data.campaign === "none") {
                        await endCampaign();
                        activeStream = { campaign: "none" };
                        await saveState();
                        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                    } else {
                        const isManual = Boolean(message.data.manual);
                        if (isManual) {
                            clearGameCooldown(message.data.campaign);
                        }
                        await createCampaign(message.data.campaign, isManual);
                    }
                    sendResponse({ success: true });
                } catch (err) {
                    console.error("Error starting campaign:", err);
                    sendResponse({ success: false, error: err?.message });
                }
                break;

            case "p:getCurrentDrops":
                await fetchTwitchCookiesAndInitClient();
                let currentInventory = null;
                if (client) {
                    try {
                        currentInventory = await client.getInventory().catch(() => null);
                        if (currentInventory && activeStream.campaign && activeStream.campaign !== "none" && activeStream.campaigns) {
                            const isDone = syncCampaignProgressWithInventory(currentInventory);
                            if (isDone && activeStream.campaign) {
                                const nowTs = getTwitchNow();
                                const allDone = activeStream.campaigns.every(c => {
                                    return (c.items && c.items.length > 0)
                                        ? c.items.every(i => (i.self && i.self.isClaimed) || (i.endsAt && i.endsAt <= nowTs) || i.isEnded || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)))
                                        : c.minutesWatched >= c.minutesNeeded;
                                });
                                if (allDone) {
                                    activeStream.campaign.isCompleted = true;
                                    activeStream.campaign.curWatching = null;
                                }
                                await saveState();
                            }
                            if (extEnabled && activeStream.campaign && (activeStream.campaign.status === "nostream" || !activeStream.campaign.curWatching) && !activeStream.campaign.isCompleted && activeStream.campaign.status !== "no_active_drops") {
                                await runCampaign(true).catch(() => {});
                            }
                        }
                    } catch (err) {}
                }
                const claimedInventory = currentInventory?.gameEventDrops || [];
                if (claimedInventory.length > 0) {
                    await chrome.storage.local.set({ claimedInventory }).catch(() => {});
                }
                chrome.runtime.sendMessage({
                    type: "p:sendCurrentDrops",
                    data: { activeStream, claimedInventory }
                }).catch(() => {});
                sendResponse({ activeStream, claimedInventory });
                break;

            case "p:skipStreamer":
                if (activeStream.campaign && activeStream.campaign !== "none") {
                    activeStream.campaign.skippedStreamers = activeStream.campaign.skippedStreamers || [];
                    if (activeStream.campaign.curWatching) {
                        activeStream.campaign.skippedStreamers.push(activeStream.campaign.curWatching);
                    }
                    await runCampaign(true);
                }
                sendResponse({ success: true });
                break;

            case "p:reloadStream":
                if (client && client._streamUrlCache && activeStream?.campaign?.curWatching) {
                    client._streamUrlCache.delete(activeStream.campaign.curWatching.toLowerCase());
                }
                await performHeadlessWatch();
                sendResponse({ success: true });
                break;

            case "p:focusStreamTab":
            case "p:focusFarmTab":
                if (activeStream?.campaign?.curWatching) {
                    const channelUrl = `https://www.twitch.tv/${encodeURIComponent(activeStream.campaign.curWatching)}`;
                    await chrome.tabs.create({ url: channelUrl, active: true }).catch(() => {});
                } else {
                    await chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory", active: true }).catch(() => {});
                }
                sendResponse({ success: true });
                break;

            case "p:settingsChanged":
                settings = { ...settings, ...message.data.settings };
                await saveState();
                updateBadgeUI();
                sendResponse({ success: true, settings });
                break;

            case "getAutoDropGames":
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
                        await saveState();
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
                    allConnected: activeOnlyGames,
                    activeDropGames: activeOnlyGames,
                    enabled: autoDropGames,
                    autoDropGames: autoDropGames
                });
                break;

            case "toggleAutoDropGame":
                if (message.data && message.data[0]) {
                    const gameName = message.data[0];
                    const enable = message.data[1];
                    if (enable && !autoDropGames.some(g => areGameNamesMatching(g, gameName))) {
                        autoDropGames.push(gameName);
                    } else if (!enable) {
                        autoDropGames = autoDropGames.filter(g => !areGameNamesMatching(g, gameName));
                    }
                    await saveState();

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
                sendResponse({ success: true, autoDropGames });
                break;

            case "p:startAutoQueue":
                if (extEnabled) {
                    checkForDrops().catch(() => {});
                    sendResponse({ success: true });
                } else {
                    sendResponse({ success: false, reason: "Extension disabled" });
                }
                break;

            case "getExtStats":
                chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                sendResponse({ extStats });
                break;

            case "getActivityHistory":
                sendResponse({ activityHistory });
                break;

            case "clearActivityHistory":
                activityHistory = [];
                await saveState();
                chrome.runtime.sendMessage({ type: "p:activityUpdated", data: [] }).catch(() => {});
                sendResponse({ success: true });
                break;

            case "p:checkUpdate":
                const updateRes = await checkGitHubUpdate(true);
                sendResponse(updateRes);
                break;

            case "p:getUpdateState":
                const storedUpdate = await chrome.storage.local.get("githubUpdate").catch(() => ({}));
                sendResponse(storedUpdate.githubUpdate || null);
                break;

            default:
                sendResponse({ status: "unhandled" });
        }
    })();

    return true;
});

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);

async function startup() {
    await hydrateState();
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

async function runCampaign(forceNextStreamer = false) {
    if (!activeStream.campaign || activeStream.campaign.status === "no_active_drops" || !activeStream.campaigns || activeStream.campaigns.length === 0) return;
    if (activeStream.campaign.reOpening) activeStream.campaign.reOpening = false;

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

    let allDropsGot = activeStream.campaigns.every(camp => {
        if (camp.items && camp.items.length > 0) {
            return camp.items.every(i => (i.self && i.self.isClaimed) || (i.endsAt && i.endsAt <= nowTs) || i.isEnded || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)));
        }
        return camp.minutesWatched >= camp.minutesNeeded && camp.minutesNeeded > 0;
    });

    if (allDropsGot) {
        if (activeStream.campaign) {
            activeStream.campaign.isCompleted = true;
            activeStream.campaign.curWatching = null;
        }
        await windowManager("close");
        await saveState();
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
    // Many Twitch campaigns (e.g. Overwatch 2 "go to a participating live channel (?filter=drops) including /ow_esports and /ow_esports_jp")
    // populate allow.channels with featured channels even though any Drops-enabled stream in the game directory counts.
    // If all listed channels are offline, fall back to any live Drops-enabled broadcaster in the category directory!
    let usedOpenDirectoryFallback = false;
    if (!targetStreamer && offlineRestrictedStreamers.length > 0 && typeof client.getChannelWithDrops === "function") {
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
            const skippedToNext = await advanceAutoQueue(currentGame);
            if (skippedToNext) {
                return;
            }
        }

        activeStream.campaign.status = "nostream";
        const anyFarmableOpen = activeStream.campaigns.some(c => isCampaignFarmable(c, nowTs) && (!c.streamers || c.streamers.length === 0));
        activeStream.campaign.requiredStreamers = anyFarmableOpen ? [] : (curCamp.streamers || []);
        activeStream.campaign.requirementType = anyFarmableOpen ? "open" : "restricted";
        await saveState();
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

    await saveState();
    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
    updateBadgeUI();
}

async function endCampaign() {
    await windowManager("close");
    activeStream = { campaign: "none" };
    gettingStreamObj.notPlayingGame = [];
    await saveState();
    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
    await checkClaimDrop();
    updateBadgeUI();
}

async function createCampaign(game, isManual = false) {
    if (!extEnabled) return;
    await fetchTwitchCookiesAndInitClient();

    const gameSlug = game.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
    let rawCampaigns = await client.getAllDropCampaigns().catch(() => client.getDropCampaigns().catch(() => []));
    if (!rawCampaigns) rawCampaigns = [];

    let inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
    if (!inventory) inventory = { dropCampaignsInProgress: [], gameEventDrops: [] };

    const campaigns = mergeCampaignsWithInventory(rawCampaigns, inventory);

    const gameLower = game.toLowerCase();
    const now = getTwitchNow();
    let matchingCampaigns = [];
    if (game === "Badges") {
        matchingCampaigns = campaigns.filter(c => c.detailsURL && c.detailsURL.includes("twitch-chat-badges"));
    } else {
        matchingCampaigns = campaigns.filter(c => c.game != null && areGameNamesMatching(c.game.displayName || c.game.name, game) && isCampaignActiveWithDrops(c, now, inventory));
    }

    activeStream.campaign = {
        game: {
            name: game
        },
        onCamp: 0,
        curWatching: "",
        lastLoop: 0,
        allowGen: true,
        slug: gameSlug,
        status: "starting",
        reOpening: false,
        isCompleted: false,
        isManual: Boolean(isManual),
        skippedStreamers: [],
        requiredStreamers: [],
        lastMinutesWatched: 0,
        lastProgressTimestamp: Date.now(),
        stallCount: 0,
        reopenAttempts: 0,
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
                    const benefit = (drop.benefitEdges && drop.benefitEdges[0]) ? (drop.benefitEdges[0].benefit || drop.benefitEdges[0].node) : null;
                    const benefitId = benefit ? benefit.id : "";
                    const benefitName = (benefit && benefit.name) ? (drop.name ? `${drop.name} - ${benefit.name}` : benefit.name) : (drop.name || "Drop Reward");
                    const benefitImg = (benefit && benefit.imageAssetURL) ? benefit.imageAssetURL : (drop.imageURL || drop.imageAssetURL || "");

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
                        badge: dropCamp.owner && dropCamp.owner.name === "Twitch Gaming",
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
                                const isClaimed = Boolean(drop.self.isClaimed || (drop.self.currentMinutesWatched >= drop.requiredMinutesWatched && drop.requiredMinutesWatched > 0));
                                matchedItem.self.isClaimed = isClaimed;
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
                const benefit = d.benefitEdges && d.benefitEdges[0] ? (d.benefitEdges[0].benefit || d.benefitEdges[0].node) : null;
                const isClaimed = Boolean(d.self && d.self.isClaimed);
                const watched = d.self?.currentMinutesWatched || 0;
                if (watched > timeWatched) timeWatched = watched;
                const benefitImg = (benefit && benefit.imageAssetURL) ? benefit.imageAssetURL : (d.imageURL || d.imageAssetURL || "");
                const benefitName = (benefit && benefit.name) ? (d.name ? `${d.name} - ${benefit.name}` : benefit.name) : (d.name || "Drop Reward");

                const dropStartAt = d.startAt || inProgCamp.startAt || null;
                const dropEndAt = d.endAt || inProgCamp.endAt || null;
                const dropEndsAtTs = dropEndAt ? new Date(dropEndAt).getTime() : null;
                const isEnded = Boolean(dropEndsAtTs && !isNaN(dropEndsAtTs) && dropEndsAtTs <= now);

                items.push({
                    id: d.id,
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
        // Multi-campaign IF/OR prioritization:
        // 1. Prioritize farmable campaigns over ended/completed campaigns
        // 2. Prioritize restricted-channel campaigns (e.g. ow_esports) first so we check if they are live;
        //    if they are offline, runCampaign() automatically fails over (IF/OR) to the open-streamer campaign!
        // 3. Prioritize earlier ending campaigns so soonest-to-expire drops are farmed first
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
            lastLoop: 0,
            allowGen: false,
            slug: gameSlug,
            status: allClaimed ? "completed" : "no_active_drops",
            isManual: Boolean(isManual),
            reOpening: false,
            isCompleted: allClaimed,
            skippedStreamers: [],
            lastMinutesWatched: 0,
            lastProgressTimestamp: Date.now(),
            stallCount: 0,
            reopenAttempts: 0,
            endsAt: activeStream.campaign.endsAt || earliestEndsAt
        };
        activeStream.campaigns = [];
        await windowManager("close");
        await saveState();
        updateBadgeUI();
        chrome.runtime.sendMessage({
            type: "p:sendCurrentDrops",
            data: {
                activeStream,
                claimedInventory: inventory.gameEventDrops || []
            }
        }).catch(() => {});

        // If this campaign was started automatically by Auto-Queue (not manual selection)
        // and there are no active drops, put this game on cooldown and immediately advance to the next game in queue!
        if (!isManual && autoDropGames.length > 0) {
            console.log(`[AutoQueue] ${game} has no active/farmable drops (all claimed or ended), skipping to next game...`);
            setGameCooldown(game, Date.now());
            setTimeout(() => advanceAutoQueue().catch(() => {}), 500);
        }
        return;
    }

    const isDone = syncCampaignProgressWithInventory(inventory);
    if (isDone) {
        const allDone = activeStream.campaigns.every(c => {
            return (c.items && c.items.length > 0)
                ? c.items.every(i => (i.self && i.self.isClaimed) || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)) || (i.endsAt && i.endsAt <= now))
                : c.minutesWatched >= c.minutesNeeded;
        });

        if (allDone) {
            const allClaimed = activeStream.campaigns.every(c =>
                (c.items && c.items.length > 0)
                    ? c.items.every(i => (i.self && i.self.isClaimed) || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)))
                    : c.minutesWatched >= c.minutesNeeded
            );
            activeStream.campaign.isCompleted = allClaimed;
            activeStream.campaign.status = allClaimed ? "completed" : "no_active_drops";
            activeStream.campaign.curWatching = null;
            await windowManager("close");
            await saveState();
            chrome.runtime.sendMessage({
                type: "p:sendCurrentDrops",
                data: {
                    activeStream,
                    claimedInventory: inventory.gameEventDrops || []
                }
            }).catch(() => {});
            return;
        }
    }

    await saveState();
    chrome.runtime.sendMessage({
        type: "p:sendCurrentDrops",
        data: {
            activeStream,
            claimedInventory: inventory.gameEventDrops || []
        }
    }).catch(() => {});
    await runCampaign();
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
                    candidates.push({ game: gameName, endsAt: endsAt || (now + 86400000) });
                }
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => a.endsAt - b.endsAt);
            const nextGame = candidates[0].game;
            console.log(`[AutoQueue] Auto-skipping ${skippedGame} -> advancing to next queued game: ${nextGame}`);
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

    if (activeStream.campaign === "none" || (activeStream.campaign && activeStream.campaign.isCompleted) || activeStream.campaign?.status === "nostream" || activeStream.campaign?.status === "no_active_drops") {
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
            }

            for (const campaign of (campaigns || [])) {
                if (!campaign || !campaign.game) continue;
                const gameName = campaign.game.displayName || campaign.game.name;
                const isQueued = autoDropGames.some(g => areGameNamesMatching(g, gameName));
                if (isQueued && isCampaignActiveWithDrops(campaign, now, inventory)) {
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
                        gamesToRun.push({ game: gameName, endsAt });
                    } else if (endsAt < existingEntry.endsAt) {
                        existingEntry.endsAt = endsAt;
                    }
                }
            }

            if (gamesToRun.length !== 0) {
                gamesToRun.sort((a, b) => a.endsAt - b.endsAt);
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
    if (!client) return;
    try {
        const inventory = await client.getInventory();
        if (!inventory || !inventory.dropCampaignsInProgress) return;

        for (const camp of inventory.dropCampaignsInProgress) {
            for (const drop of (camp.timeBasedDrops || [])) {
                if (drop.requiredMinutesWatched !== 0 && drop.self && drop.requiredMinutesWatched <= drop.self.currentMinutesWatched && !drop.self.isClaimed) {
                    const dropInstanceId = drop.self.dropInstanceID;
                    if (!dropInstanceId) continue;
                    if (isDuplicateBackgroundClaim("drop-claim-" + dropInstanceId, 30000)) continue;

                    try {
                        const dropClaim = await client.claimDropReward(dropInstanceId);
                        if (dropClaim && (dropClaim.status === "SUCCESS" || dropClaim.status === "ELIGIBLE_FOR_CLAIM" || dropClaim.success === true)) {
                            drop.self.isClaimed = true;
                            const rewardTitle = drop.name || "Drop Reward";
                            const gameName = camp.game ? camp.game.displayName : "Twitch Drop";
                            extStats.claimedDrops++;
                            const img = (drop.benefitEdges && drop.benefitEdges[0]) ? drop.benefitEdges[0].benefit.imageAssetURL : (drop.imageURL || "");
                            logActivity("drop", rewardTitle, gameName, 0, img);
                            notifyUser("Drop Reward Claimed!", `Successfully claimed ${rewardTitle} for ${gameName}`);
                            await saveState();
                            chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                            chrome.runtime.sendMessage({ type: "p:activityUpdated", data: activityHistory }).catch(() => {});
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
}

function autoGetToken() {
    if (settings.autoGetToken === true && autoGetTokenWindow === 0) {
        if (!client || !client.integrity || client.integrity.expiration - 960000 < Date.now()) {
            chrome.windows.create({ focused: false, type: "popup", url: "https://www.twitch.tv/drops/inventory/" }).then(async (window) => {
                if (window) {
                    autoGetTokenWindow = window.id;
                    await chrome.storage.local.set({ autoGetTokenWindow });
                    // 60-second failsafe: close window if Twitch stalls or integrity token isn't intercepted
                    setTimeout(() => {
                        if (autoGetTokenWindow !== 0 && autoGetTokenWindow === window.id) {
                            chrome.windows.remove(window.id).catch(() => {});
                            autoGetTokenWindow = 0;
                            chrome.storage.local.set({ autoGetTokenWindow: 0 }).catch(() => {});
                        }
                    }, 60000);
                }
            }).catch(() => {});
        }
    }
}

if (typeof chrome !== "undefined" && chrome.windows?.onRemoved?.addListener) {
    chrome.windows.onRemoved.addListener(async (windowId) => {
        if (windowId === autoGetTokenWindow) {
            autoGetTokenWindow = 0;
            await chrome.storage.local.set({ autoGetTokenWindow: 0 }).catch(() => {});
        }
    });
}

async function windowManager(func) {
    if (func === "close") {
        stopHeadlessWatchLoop();
        await saveState();
    }
}

let lastBadgeState = "";

function updateBadgeUI() {
    try {
        if (!chrome.action || !chrome.action.setBadgeText) return;
        let text = "";
        let color = "#9146FF";

        if (!extEnabled) {
            text = "OFF";
            color = "#52525b";
        } else if (activeStream && activeStream.campaign && activeStream.campaign !== "none") {
            const camp = activeStream.campaign;
            if (camp.isCompleted) {
                text = "✓";
                color = "#00e676";
            } else if (camp.status === "nostream") {
                text = "…";
                color = "#f0a232";
            } else if (camp.status === "no_active_drops") {
                text = "";
                color = "#52525b";
            } else if (activeStream.campaigns && activeStream.campaigns.length > 0) {
                const cur = activeStream.campaigns[camp.onCamp || 0] || activeStream.campaigns[0];
                if (cur) {
                    let left = 0;
                    const nowMs = getTwitchNow();
                    if (cur.items && cur.items.length > 0) {
                        const nextItem = cur.items.find(i => !i.self?.isClaimed && !i.isEnded && !(i.endsAt && i.endsAt <= nowMs) && (i.self?.currentMinutesWatched || 0) < (i.reqTime || 60));
                        if (nextItem) {
                            const req = nextItem.reqTime || 60;
                            const watched = nextItem.self?.currentMinutesWatched || 0;
                            left = Math.max(0, req - watched);
                        }
                    } else if (cur.minutesNeeded) {
                        left = Math.max(0, cur.minutesNeeded - (cur.minutesWatched || 0));
                    }
                    text = left > 0 ? `${left}m` : "✓";
                    color = left > 0 ? "#9146FF" : "#00e676";
                } else {
                    text = "…";
                }
            }
        } else if (settings.setShowBadges) {
            text = "";
        }

        if (text === lastBadgeState) return;
        lastBadgeState = text;
        chrome.action.setBadgeText({ text }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
    } catch (e) {}
}