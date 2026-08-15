/** 
 * Auto Twitch Drops Pro - Background Service Worker (Manifest V3)
 **/
import { Client, TwitchApiError } from "./background/twitchApi.js";

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
    watchPopout: true,
    autoMute: true,
    setShowBadges: true,
    soundOnClaim: false,
    desktopNotifications: true,
    lowQualityMode: true
};
let listOfConnected = [...POPULAR_DROP_GAMES];
let autoDropGames = [];
let priorityStreams = [];
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
let curWindow = {
    id: 0,
    type: "none"
};
let gettingStreamObj = {
    allStreamers: [],
    notPlayingGame: [],
    lastPull: 0
};
let autoGetTokenWindow = 0;
let isHydrated = false;
let hydrationPromise = null;

// --- State Persistence & Hydration ---

async function saveState() {
    try {
        await chrome.storage.local.set({
            activeStream,
            curWindow,
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
                "curWindow",
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

            if (val.curWindow) curWindow = val.curWindow;
            if (val.autoGetTokenWindow !== undefined) autoGetTokenWindow = val.autoGetTokenWindow;
            if (val.activeStream && val.activeStream.campaign && val.activeStream.campaign !== "none") {
                activeStream = val.activeStream;
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

function enableAutoplayForTwitch() {
    try {
        if (chrome.contentSettings && chrome.contentSettings.autoplay) {
            chrome.contentSettings.autoplay.set({
                primaryPattern: "*://*.twitch.tv/*",
                setting: "allow"
            });
            chrome.contentSettings.autoplay.set({
                primaryPattern: "https://*.twitch.tv/*",
                setting: "allow"
            });
        }
    } catch (e) {
        console.warn("Could not set autoplay content settings:", e);
    }
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
                client.autoDetectUserId().catch(() => {});
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
        const activeGameLower = (activeStream.campaign.game?.name || "").toLowerCase();
        const matchedDropCamp = inProgressList.find(c =>
            c.id === curCamp.id ||
            (c.game && (c.game.displayName?.toLowerCase() === activeGameLower || c.game.name?.toLowerCase() === activeGameLower || activeGameLower.includes(c.game.displayName?.toLowerCase()) || activeGameLower.includes(c.game.name?.toLowerCase())))
        );

        if (matchedDropCamp && matchedDropCamp.timeBasedDrops) {
            let maxWatchedInCamp = 0;
            let allDropsClaimedInCamp = true;

            if (!curCamp.items || curCamp.items.length === 0) {
                curCamp.items = [];
                for (const d of matchedDropCamp.timeBasedDrops) {
                    const benefit = d.benefitEdges && d.benefitEdges[0] ? (d.benefitEdges[0].benefit || d.benefitEdges[0].node) : null;
                    const req = d.requiredMinutesWatched || 60;
                    const benefitImg = (benefit && benefit.imageAssetURL) ? benefit.imageAssetURL : (d.imageURL || d.imageAssetURL || "");
                    const benefitName = (benefit && benefit.name) ? (d.name ? `${d.name} - ${benefit.name}` : benefit.name) : (d.name || "Drop Reward");
                    
                    curCamp.items.push({
                        id: d.id,
                        name: benefitName,
                        picture: benefitImg,
                        reqTime: req,
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

                const isExplicitlyClaimed = (drop.self && drop.self.isClaimed === true) || isDropItemClaimedStrict(drop, eventDropsList);
                const currentWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                    ? drop.self.currentMinutesWatched
                    : (isExplicitlyClaimed ? reqMinutes : 0);

                if (currentWatched > maxWatchedInCamp) {
                    maxWatchedInCamp = currentWatched;
                }

                if (!isExplicitlyClaimed && currentWatched < reqMinutes) {
                    allDropsClaimedInCamp = false;
                }

                if (curCamp.items) {
                    const matchedItem = curCamp.items.find(i => i.id === drop.id || (drop.benefitEdges && drop.benefitEdges[0] && i.benefitId === drop.benefitEdges[0].benefit.id));
                    if (matchedItem) {
                        matchedItem.self = matchedItem.self || {};
                        matchedItem.self.isClaimed = isExplicitlyClaimed;
                        matchedItem.self.currentMinutesWatched = currentWatched;
                        if (drop.benefitEdges && drop.benefitEdges[0] && drop.benefitEdges[0].benefit.imageAssetURL) {
                            matchedItem.picture = drop.benefitEdges[0].benefit.imageAssetURL;
                        }
                    }
                }
            }

            curCamp.minutesWatched = maxWatchedInCamp;

            if (!allDropsClaimedInCamp) {
                allCampaignsCompleted = false;
            }
        } else {
            let allItemsClaimed = true;
            if (curCamp.items && curCamp.items.length > 0) {
                for (const item of curCamp.items) {
                    const req = item.reqTime || curCamp.minutesNeeded || 60;
                    const isClaimed = isDropItemClaimedStrict(item, eventDropsList) || (item.self && item.self.isClaimed === true);
                    item.self = item.self || {};
                    item.self.isClaimed = isClaimed;
                    const itemWatched = item.self.currentMinutesWatched || 0;

                    if (!isClaimed && itemWatched < req) {
                        allItemsClaimed = false;
                    }
                }
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

// --- Persistent Alarms for MV3 Service Worker ---

function setupAlarms() {
    chrome.alarms.create("watchdogAlarm", { periodInMinutes: 0.5 });
    chrome.alarms.create("dropCheckAlarm", { periodInMinutes: 3 });
    chrome.alarms.create("tokenRefreshAlarm", { periodInMinutes: 15 });
    chrome.alarms.create("badgeRefreshAlarm", { periodInMinutes: 10 });
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
                const isDone = syncCampaignProgressWithInventory(inventory);
                await checkClaimDrop();

                if (isDone) {
                    const allDone = activeStream.campaigns && activeStream.campaigns.every(c => {
                        return (c.items && c.items.length > 0)
                            ? c.items.every(i => (i.self && i.self.isClaimed) || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)))
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

                // 2. Stream Stall Watchdog (4-minute threshold)
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
                        // Progress has stalled for >4 minutes
                        const elapsedMs = now - activeStream.campaign.lastProgressTimestamp;
                        const stallThresholdMs = 4 * 60 * 1000;

                        if (elapsedMs >= stallThresholdMs) {
                            activeStream.campaign.stallCount = (activeStream.campaign.stallCount || 0) + 1;
                            activeStream.campaign.lastProgressTimestamp = now;

                            if (activeStream.campaign.stallCount === 1) {
                                console.log(`Stream stall detected for ${activeStream.campaign.curWatching} (0m gained in 4m). Reloading stream tab.`);
                                if (curWindow.id !== 0) {
                                    chrome.tabs.reload(curWindow.id).catch(() => {});
                                }
                            } else if (activeStream.campaign.stallCount >= 2) {
                                console.log(`Persistent stall detected for ${activeStream.campaign.curWatching} (0m gained in 8m). Rotating to next channel.`);
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
                enableAutoplayForTwitch();
                await fetchTwitchCookiesAndInitClient();
                setupAlarms();
                setTimeout(checkForDrops, 1500);
            } else {
                chrome.alarms.clearAll();
                if (activeStream.campaign !== "none" && curWindow.id !== 0) {
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
                        }
                    } else if (opName === "Inventory") {
                        const inProg = payload?.currentUser?.inventory?.dropCampaignsInProgress || [];
                        for (const c of inProg) {
                            const gName = c.game?.displayName || c.game?.name || "";
                            if (c.timeBasedDrops && c.timeBasedDrops.length > 0) {
                                for (const d of c.timeBasedDrops) {
                                    const benefit = d.benefitEdges?.[0]?.benefit || d.benefitEdges?.[0]?.node;
                                    const benefitImg = benefit?.imageAssetURL || benefit?.imageURL || d.imageURL || d.imageAssetURL || "";
                                    const benefitName = benefit?.name ? (d.name ? `${d.name} - ${benefit.name}` : benefit.name) : (d.name || "Drop Reward");
                                    
                                    extractedItems.push({
                                        id: d.id,
                                        gameName: gName,
                                        name: benefitName,
                                        picture: benefitImg,
                                        reqTime: d.requiredMinutesWatched || 60,
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
                        for (const c of camps) {
                            const gName = c.game?.displayName || c.game?.name || "";
                            if (c.timeBasedDrops && c.timeBasedDrops.length > 0) {
                                for (const d of c.timeBasedDrops) {
                                    const benefit = d.benefitEdges?.[0]?.benefit || d.benefitEdges?.[0]?.node;
                                    const benefitImg = benefit?.imageAssetURL || benefit?.imageURL || d.imageURL || d.imageAssetURL || "";
                                    const benefitName = benefit?.name ? (d.name ? `${d.name} - ${benefit.name}` : benefit.name) : (d.name || "Drop Reward");

                                    extractedItems.push({
                                        id: d.id,
                                        gameName: gName,
                                        name: benefitName,
                                        picture: benefitImg,
                                        reqTime: d.requiredMinutesWatched || 60,
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
                        const curCamp = activeStream.campaigns[activeStream.campaign.onCamp || 0];
                        if (curCamp) {
                            const activeGameLower = (activeStream.campaign.game?.name || "").toLowerCase();
                            const matchedItems = extractedItems.filter(i => !i.gameName || i.gameName.toLowerCase().includes(activeGameLower) || activeGameLower.includes(i.gameName.toLowerCase()));

                            if (matchedItems.length > 0) {
                                curCamp.items = matchedItems;
                                const highestWatched = Math.max(0, ...matchedItems.map(i => i.self?.currentMinutesWatched || 0));
                                const highestReq = Math.max(60, ...matchedItems.map(i => i.reqTime || 60));
                                curCamp.minutesWatched = highestWatched;
                                curCamp.minutesNeeded = highestReq;
                            } else if (currentDrop) {
                                const benefit = (currentDrop.benefitEdges && currentDrop.benefitEdges[0]) ? (currentDrop.benefitEdges[0].benefit || currentDrop.benefitEdges[0].node) : null;
                                const dropImg = benefit?.imageAssetURL || currentDrop.imageURL || currentDrop.imageAssetURL || "";
                                const dropTitle = benefit?.name ? (currentDrop.name ? `${currentDrop.name} - ${benefit.name}` : benefit.name) : (currentDrop.name || "Drop Reward");

                                const existing = curCamp.items?.find(i => i.id === currentDrop.id);
                                if (existing) {
                                    existing.self = existing.self || {};
                                    existing.self.currentMinutesWatched = currentDrop.currentMinutesWatched;
                                    existing.self.isClaimed = Boolean(currentDrop.isClaimed);
                                    if (dropImg) existing.picture = dropImg;
                                } else {
                                    curCamp.items = curCamp.items || [];
                                    curCamp.items.push({
                                        id: currentDrop.id,
                                        name: dropTitle,
                                        picture: dropImg,
                                        reqTime: currentDrop.requiredMinutesWatched || 60,
                                        self: {
                                            isClaimed: Boolean(currentDrop.isClaimed),
                                            currentMinutesWatched: currentDrop.currentMinutesWatched || 0
                                        }
                                    });
                                }
                                curCamp.minutesWatched = currentDrop.currentMinutesWatched || curCamp.minutesWatched;
                                curCamp.minutesNeeded = currentDrop.requiredMinutesWatched || curCamp.minutesNeeded;
                            }
                            await saveState();
                            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                        }
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
                                chrome.runtime.sendMessage({ type: "p:activityUpdated", data: { history: activityHistory } }).catch(() => {});
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
                        chrome.runtime.sendMessage({ type: "p:activityUpdated", data: { history: activityHistory } }).catch(() => {});
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
                    const data = await client.getDropCampaigns();
                    if (Array.isArray(data) && data.length > 0) {
                        for (const c of data) {
                            if (c && c.game && !listOfConnected.includes(c.game.displayName)) {
                                listOfConnected.push(c.game.displayName);
                            }
                        }
                        listOfConnected = Array.from(new Set([...listOfConnected, ...POPULAR_DROP_GAMES]));
                        extStats.connectedGames = listOfConnected;
                        await saveState();
                        chrome.runtime.sendMessage({ type: "p:connectedGames", data }).catch(() => {});
                        chrome.runtime.sendMessage({
                            type: "setAutoDropGames",
                            data: { allConnected: listOfConnected, enabled: autoDropGames }
                        }).catch(() => {});
                        sendResponse({ games: data });
                        return;
                    }
                } catch (e) {
                    console.error("Error fetching connected games:", e);
                }

                listOfConnected = Array.from(new Set([...listOfConnected, ...POPULAR_DROP_GAMES]));
                const defaultGames = listOfConnected.map(g => ({
                    game: { displayName: g },
                    self: { isAccountConnected: true }
                }));
                chrome.runtime.sendMessage({ type: "p:connectedGames", data: defaultGames }).catch(() => {});
                sendResponse({ games: defaultGames });
                break;

            case "p:startCampaign":
                if (message.data.campaign === "none") {
                    if (activeStream.campaign !== "none" && curWindow.id !== 0) {
                        await endCampaign();
                    }
                    activeStream = { campaign: "none" };
                    await saveState();
                    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                } else {
                    await createCampaign(message.data.campaign);
                }
                sendResponse({ success: true });
                break;

            case "p:getCurrentDrops":
                await fetchTwitchCookiesAndInitClient();
                if (client && activeStream.campaign && activeStream.campaign !== "none" && activeStream.campaigns) {
                    try {
                        const inventory = await client.getInventory().catch(() => null);
                        if (inventory) {
                            const isDone = syncCampaignProgressWithInventory(inventory);
                            if (isDone && activeStream.campaign) {
                                const allDone = activeStream.campaigns.every(c => {
                                    return (c.items && c.items.length > 0)
                                        ? c.items.every(i => (i.self && i.self.isClaimed) || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)))
                                        : c.minutesWatched >= c.minutesNeeded;
                                });
                                if (allDone) {
                                    activeStream.campaign.isCompleted = true;
                                    activeStream.campaign.curWatching = null;
                                }
                                await saveState();
                            }
                        }
                    } catch (err) {}
                }
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                sendResponse({ activeStream });
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
                if (curWindow.id !== 0) {
                    chrome.tabs.reload(curWindow.id).catch(() => {});
                } else {
                    const tabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
                    if (tabs && tabs.length > 0) {
                        chrome.tabs.reload(tabs[0].id).catch(() => {});
                    }
                }
                sendResponse({ success: true });
                break;

            case "p:focusStreamTab":
                if (curWindow.id !== 0) {
                    chrome.tabs.update(curWindow.id, { active: true }).catch(() => {});
                } else {
                    const tabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
                    if (tabs && tabs.length > 0) {
                        chrome.tabs.update(tabs[0].id, { active: true }).catch(() => {});
                    }
                }
                sendResponse({ success: true });
                break;

            case "p:toggleTabAudio":
                let targetTabId = curWindow.id;
                if (targetTabId === 0) {
                    const tabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
                    if (tabs && tabs.length > 0) {
                        targetTabId = tabs[0].id;
                        curWindow.id = targetTabId;
                        await saveState();
                    }
                }
                if (targetTabId !== 0) {
                    try {
                        const tab = await chrome.tabs.get(targetTabId).catch(() => null);
                        if (tab) {
                            const currentlyMuted = Boolean(tab.mutedInfo && tab.mutedInfo.muted);
                            const newMuted = !currentlyMuted;
                            await chrome.tabs.update(targetTabId, { muted: newMuted }).catch(() => {});
                            chrome.tabs.sendMessage(targetTabId, { type: "setTabAudio", muted: newMuted }).catch(() => {});
                            sendResponse({ success: true, muted: newMuted });
                            return;
                        }
                    } catch (e) {}
                }
                sendResponse({ success: false });
                break;

            case "p:getTabAudioState":
                let checkTabId = curWindow.id;
                if (checkTabId === 0) {
                    const tabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
                    if (tabs && tabs.length > 0) {
                        checkTabId = tabs[0].id;
                        curWindow.id = checkTabId;
                        await saveState();
                    }
                }
                if (checkTabId !== 0) {
                    try {
                        const tab = await chrome.tabs.get(checkTabId).catch(() => null);
                        if (tab && tab.mutedInfo) {
                            sendResponse({ muted: tab.mutedInfo.muted });
                            return;
                        }
                    } catch (e) {}
                }
                sendResponse({ muted: true });
                break;

            case "p:settingsChanged":
                settings = { ...settings, ...message.data.settings };
                await saveState();
                if (curWindow.id !== 0) {
                    if (settings.autoMute) {
                        chrome.tabs.update(curWindow.id, { muted: true }).catch(() => {});
                    } else if (settings.autoMute === false) {
                        chrome.tabs.update(curWindow.id, { muted: false }).catch(() => {});
                    }
                }
                sendResponse({ success: true, settings });
                break;

            case "getAutoDropGames":
                const allGames = Array.from(new Set([...listOfConnected, ...POPULAR_DROP_GAMES])).sort((a, b) => a.localeCompare(b));
                chrome.runtime.sendMessage({
                    type: "setAutoDropGames",
                    data: { allConnected: allGames, enabled: autoDropGames }
                }).catch(() => {});
                sendResponse({ allConnected: allGames, enabled: autoDropGames });
                break;

            case "toggleAutoDropGame":
                if (message.data && message.data[0]) {
                    const gameName = message.data[0];
                    const enable = message.data[1];
                    if (enable && !autoDropGames.includes(gameName)) {
                        autoDropGames.push(gameName);
                    } else if (!enable) {
                        const idx = autoDropGames.indexOf(gameName);
                        if (idx !== -1) autoDropGames.splice(idx, 1);
                    }
                    await saveState();
                }
                sendResponse({ success: true, autoDropGames });
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

            default:
                sendResponse({ status: "unhandled" });
        }
    })();

    return true;
});

// --- Tab Watchdog ---

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await hydrateState();
    if (activeStream.campaign !== "none" && extEnabled) {
        if (tabId === curWindow.id) {
            curWindow.id = 0;
            curWindow.type = "none";
            await saveState();

            if (!activeStream.campaign || activeStream.campaign.reOpening || activeStream.campaign.isCompleted) {
                return;
            }

            activeStream.campaign.reopenAttempts = (activeStream.campaign.reopenAttempts || 0) + 1;
            if (activeStream.campaign.reopenAttempts > 5) {
                console.warn("Too many tab restart attempts, pausing campaign");
                activeStream.campaign.status = "paused";
                await saveState();
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                return;
            }

            setTimeout(async () => {
                await hydrateState();
                if (activeStream.campaign !== "none" && !activeStream.campaign.isCompleted && extEnabled && curWindow.id === 0) {
                    await runCampaign();
                }
            }, 3000);
        }
    }
});

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);

async function startup() {
    enableAutoplayForTwitch();
    await hydrateState();
    setupAlarms();
    updateBadgeUI();

    if (extEnabled) {
        setTimeout(autoGetToken, 3000);
        setTimeout(checkForDrops, 4000);
    }
}

// --- Campaign Execution Engine ---

async function runCampaign(forceNextStreamer = false) {
    if (!activeStream.campaign || !activeStream.campaigns || activeStream.campaigns.length === 0) return;
    if (activeStream.campaign.reOpening) activeStream.campaign.reOpening = false;

    let curCamp = activeStream.campaigns[activeStream.campaign.onCamp];
    if (!curCamp) {
        await endCampaign();
        return;
    }

    let allDropsGot = activeStream.campaigns.every(camp => {
        if (camp.items && camp.items.length > 0) {
            return camp.items.every(i => (i.self && i.self.isClaimed) || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)));
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

    let targetStreamer = null;

    if (curCamp.streamers && curCamp.streamers.length > 0) {
        const available = curCamp.streamers.filter(s => !skipped.includes(s));
        if (available.length > 0) {
            targetStreamer = available[0];
        } else {
            activeStream.campaign.skippedStreamers = [];
            targetStreamer = curCamp.streamers[0];
        }
    } else {
        const stream = await client.getChannelWithDrops(activeStream.campaign.game.name, curCamp.id, activeStream.campaign.slug, skipped);
        if (stream && stream.broadcaster && stream.broadcaster.login) {
            targetStreamer = stream.broadcaster.login;
        }
    }

    let streamUrl = "";
    if (targetStreamer) {
        activeStream.campaign.curWatching = targetStreamer;
        streamUrl = `https://www.twitch.tv/${targetStreamer}#atd-managed=1`;
    } else {
        const gameSlug = activeStream.campaign.slug || activeStream.campaign.game.name.toLowerCase().replace(/[^a-z0-9]/g, "-");
        activeStream.campaign.curWatching = "";
        streamUrl = `https://www.twitch.tv/directory/category/${gameSlug}?filter=drops#atd-managed=1`;
    }

    // Reset progress tracking & stall counts for new/re-targeted streamer
    activeStream.campaign.lastMinutesWatched = curCamp.minutesWatched || 0;
    activeStream.campaign.lastProgressTimestamp = Date.now();
    activeStream.campaign.stallCount = 0;

    if (curWindow.id !== 0) {
        try {
            const tab = await chrome.tabs.get(curWindow.id).catch(() => null);
            if (tab) {
                await chrome.tabs.update(curWindow.id, { url: streamUrl, active: false });
            } else {
                await windowManager("open", { active: false, url: streamUrl });
            }
        } catch (e) {
            await windowManager("open", { active: false, url: streamUrl });
        }
    } else {
        await windowManager("open", { active: false, url: streamUrl });
    }

    if (settings.autoMute && curWindow.id !== 0) {
        chrome.tabs.update(curWindow.id, { muted: true }).catch(() => {});
    }

    activeStream.campaign.status = "watching";
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

async function createCampaign(game) {
    await fetchTwitchCookiesAndInitClient();

    const gameSlug = game.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
    let campaigns = await client.getDropCampaigns().catch(() => []);
    if (!campaigns) campaigns = [];

    const gameLower = game.toLowerCase();
    let matchingCampaigns = [];
    if (game === "Badges") {
        matchingCampaigns = campaigns.filter(c => c.detailsURL && c.detailsURL.includes("twitch-chat-badges"));
    } else {
        matchingCampaigns = campaigns.filter(c => c.game != null && (c.game.displayName?.toLowerCase() === gameLower || c.game.name?.toLowerCase() === gameLower || gameLower.includes(c.game.displayName?.toLowerCase()) || gameLower.includes(c.game.name?.toLowerCase())) && c.status === "ACTIVE");
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
        skippedStreamers: [],
        lastMinutesWatched: 0,
        lastProgressTimestamp: Date.now(),
        stallCount: 0,
        reopenAttempts: 0
    };
    activeStream.campaigns = [];

    let inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
    if (!inventory) inventory = { dropCampaignsInProgress: [], gameEventDrops: [] };

    if (matchingCampaigns.length > 0) {
        const campAry = matchingCampaigns.map(c => c.id);
        const campDeets = await client.getDropCampaignDetails(campAry).catch(() => []);

        let itemsToProcess = [];
        if (Array.isArray(campDeets) && campDeets.length > 0) {
            for (const c of campDeets) {
                const dropCamp = c?.data?.user?.dropCampaign || c?.data?.dropCampaign || c?.user?.dropCampaign || c?.dropCampaign;
                if (dropCamp) itemsToProcess.push(dropCamp);
            }
        }
        if (itemsToProcess.length === 0) itemsToProcess = matchingCampaigns;

        const eventDropsList = (inventory && inventory.gameEventDrops) ? inventory.gameEventDrops : [];

        for (const dropCamp of itemsToProcess) {
            if (!dropCamp) continue;
            const streams = [];
            if (dropCamp.allow && dropCamp.allow.channels) {
                for (const stream of dropCamp.allow.channels) {
                    if (stream && stream.name) streams.push(stream.name);
                }
            }
            let maxTime = 0;
            let timeWatched = 0;
            const allDrops = [];

            for (const drop of (dropCamp.timeBasedDrops || [])) {
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
                        self: { isClaimed, currentMinutesWatched: currentWatched }
                    });
                }
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
                minutesNeeded: maxTime,
                minutesWatched: timeWatched,
                streamers: streams,
                items: allDrops
            });
        }
    } else {
        const inProgCamp = inventory.dropCampaignsInProgress?.find(c =>
            c.game && (c.game.displayName?.toLowerCase() === gameLower || c.game.name?.toLowerCase() === gameLower || gameLower.includes(c.game.displayName?.toLowerCase()) || gameLower.includes(c.game.name?.toLowerCase()))
        );

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

                items.push({
                    id: d.id,
                    name: benefitName,
                    picture: benefitImg,
                    reqTime: req,
                    self: { isClaimed, currentMinutesWatched: watched }
                });
            }
        }

        activeStream.campaigns.push({
            game: game,
            id: inProgCamp ? inProgCamp.id : `camp-${gameSlug}`,
            minutesNeeded: maxTime,
            minutesWatched: timeWatched,
            streamers: [],
            items: items
        });
    }

    const isDone = syncCampaignProgressWithInventory(inventory);
    if (isDone) {
        const allDone = activeStream.campaigns.every(c => {
            return (c.items && c.items.length > 0)
                ? c.items.every(i => (i.self && i.self.isClaimed) || (i.self && i.self.currentMinutesWatched >= (i.reqTime || 60)))
                : c.minutesWatched >= c.minutesNeeded;
        });

        if (allDone) {
            activeStream.campaign.isCompleted = true;
            activeStream.campaign.curWatching = null;
            await windowManager("close");
            await saveState();
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
            return;
        }
    }

    await saveState();
    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
    await runCampaign();
}

async function checkForDrops() {
    if (!extEnabled) return;
    await fetchTwitchCookiesAndInitClient();

    if (activeStream.campaign === "none" || (activeStream.campaign && activeStream.campaign.isCompleted)) {
        try {
            const campaigns = await client.getDropCampaigns();
            const inventory = await client.getInventory();
            const gamesToRun = [];

            for (const campaign of (campaigns || [])) {
                if (!campaign || !campaign.game) continue;
                if (autoDropGames.includes(campaign.game.displayName) && campaign.status === "ACTIVE") {
                    const campaignDetails = await client.getDropCampaignDetails(campaign.id);
                    if (!campaignDetails) continue;
                    const endsAt = new Date(campaignDetails.endAt).getTime();
                    let hasUnclaimedDrops = false;

                    const inProgCamp = inventory?.dropCampaignsInProgress?.find(c => c.id === campaign.id);

                    for (const drop of (campaignDetails.timeBasedDrops || [])) {
                        const inProgDrop = inProgCamp?.timeBasedDrops?.find(d => d.id === drop.id);
                        const isClaimed = inProgDrop?.self?.isClaimed || drop?.self?.isClaimed;
                        const watched = inProgDrop?.self?.currentMinutesWatched || 0;
                        const req = drop.requiredMinutesWatched || 60;

                        if (!isClaimed && watched < req) {
                            hasUnclaimedDrops = true;
                            break;
                        }
                    }

                    if (hasUnclaimedDrops) {
                        if (!gamesToRun.some((g) => g.game === campaign.game.displayName)) {
                            gamesToRun.push({ game: campaign.game.displayName, endsAt });
                        }
                    }
                }
            }

            if (gamesToRun.length !== 0) {
                gamesToRun.sort((a, b) => a.endsAt - b.endsAt);
                await createCampaign(gamesToRun[0].game);
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
                            chrome.runtime.sendMessage({ type: "p:activityUpdated", data: { history: activityHistory } }).catch(() => {});
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

async function windowManager(func, data = {}) {
    if (func === "open") {
        const tabOptions = {
            active: false,
            ...data
        };
        if (tabOptions.url && !tabOptions.url.includes("#atd-managed=1")) {
            tabOptions.url = tabOptions.url.includes("#") ? tabOptions.url : `${tabOptions.url}#atd-managed=1`;
        }

        if (curWindow.id === 0) {
            const managedTabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*#atd-managed=1*" }).catch(() => []);
            if (managedTabs && managedTabs.length > 0) {
                const tab = managedTabs[0];
                curWindow.id = tab.id;
                curWindow.type = "tab";
                await saveState();
                if (tabOptions.url && tab.url !== tabOptions.url) {
                    await chrome.tabs.update(tab.id, { url: tabOptions.url, active: false }).catch(() => {});
                }
                return tab;
            }

            const tab = await chrome.tabs.create(tabOptions);
            curWindow.id = tab.id;
            curWindow.type = "tab";
            await saveState();
            return tab;
        } else {
            let tab = await chrome.tabs.get(curWindow.id).catch(() => null);
            if (!tab) {
                const managedTabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*#atd-managed=1*" }).catch(() => []);
                if (managedTabs && managedTabs.length > 0) {
                    tab = managedTabs[0];
                    curWindow.id = tab.id;
                    await saveState();
                } else {
                    tab = await chrome.tabs.create(tabOptions);
                    curWindow.id = tab.id;
                    await saveState();
                    return tab;
                }
            }
            if (tabOptions.url && tabOptions.url !== tab.url) {
                await chrome.tabs.update(curWindow.id, { url: tabOptions.url, active: false }).catch(() => {});
            }
            return tab;
        }
    } else if (func === "close") {
        if (curWindow.id !== 0) {
            await chrome.tabs.remove(curWindow.id).catch(() => {});
            curWindow.id = 0;
            curWindow.type = "none";
            await saveState();
        }
    }
}

function updateBadgeUI() {
    if (!extEnabled) {
        chrome.action.setBadgeText({ text: "OFF" }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: "#666666" }).catch(() => {});
        return;
    }
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
}