/** 
 * Auto Twitch Drops Pro - Background Service Worker (Manifest V3)
 **/
import { Client } from "./background/twitchApi.js";

let client = null;
let settings = {
    autoRefresh: true,
    showAllGames: true,
    autoGetToken: true,
    watchPopout: true,
    autoMute: true,
    setShowBadges: true,
    soundOnClaim: false
};
let listOfConnected = [];
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
            activityHistory: activityHistory.slice(0, 50)
        });
    } catch (e) {
        console.warn("Error saving state to storage:", e);
    }
}

async function hydrateState() {
    if (isHydrated) return;
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
            "activityHistory",
            "oauthToken",
            "deviceId",
            "userId",
            "uuid"
        ]);

        extEnabled = val.exEnabled !== undefined ? val.exEnabled : true;
        if (val.settings) settings = { ...settings, ...val.settings };
        if (val.autoDropGames) autoDropGames = val.autoDropGames;
        if (val.priorityStreams) priorityStreams = val.priorityStreams;
        if (val.listOfConnected) listOfConnected = val.listOfConnected;
        if (val.activityHistory) activityHistory = val.activityHistory;
        if (val.extStats) extStats = { ...extStats, ...val.extStats };

        if (val.curWindow) curWindow = val.curWindow;
        if (val.activeStream && val.activeStream.campaign && val.activeStream.campaign !== "none") {
            activeStream = val.activeStream;
        }

        await fetchTwitchCookiesAndInitClient();
        isHydrated = true;
    } catch (e) {
        console.warn("Error hydrating state:", e);
    }
}

function logActivity(type, title, game, points = 0, imgUrl = "assets/img/atd-48.png") {
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type, // 'drop' or 'points'
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
        const authCookie = await chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" }).catch(() => null);
        const deviceCookie = await chrome.cookies.get({ url: "https://www.twitch.tv", name: "unique_id" }).catch(() => null);

        let oauthToken = authCookie ? authCookie.value : null;
        let deviceId = deviceCookie ? deviceCookie.value : null;

        const localData = await chrome.storage.local.get(["oauthToken", "deviceId", "userId", "uuid"]).catch(() => ({}));

        oauthToken = oauthToken || localData.oauthToken;
        deviceId = deviceId || localData.deviceId;

        if (oauthToken) {
            await chrome.storage.local.set({ oauthToken, deviceId }).catch(() => {});
            if (client === null) {
                client = new Client({ clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko", oauthToken, deviceId, userId: localData.userId, uuid: localData.uuid });
            } else {
                client.updateUserInfo({ oauthToken, deviceId, userId: localData.userId, uuid: localData.uuid });
            }
        } else if (client === null) {
            client = new Client({ clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko" });
        }
    } catch (e) {
        console.warn("Error fetching Twitch cookies:", e);
        if (client === null) {
            client = new Client({ clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko" });
        }
    }
}

function isDropItemClaimed(item, eventDropsList) {
    if (!item) return false;
    if (item.self && item.self.isClaimed === true) return true;
    if (!eventDropsList || eventDropsList.length === 0) return false;

    const itemId = (item.id || "").toLowerCase();
    const benefitId = (item.benefitId || "").toLowerCase();
    const itemName = (item.name || item.title || "").toLowerCase();

    for (const evt of eventDropsList) {
        if (!evt) continue;
        const evtId = (evt.id || "").toLowerCase();
        const evtName = (evt.name || evt.title || "").toLowerCase();

        if (evtId && (evtId === itemId || evtId === benefitId)) return true;

        if (evtName && evtName.length >= 3) {
            if (itemName.includes(evtName) || evtName.includes(itemName)) return true;

            const coreEvt = evtName.replace(/spray|skin|charm|doodle|dev|icon|emote|lootbox|loot box|card/gi, "").trim();
            const coreItem = itemName.replace(/spray|skin|charm|doodle|dev|icon|emote|lootbox|loot box|card/gi, "").trim();
            if (coreEvt.length >= 3 && coreItem.length >= 3) {
                if (coreItem.includes(coreEvt) || coreEvt.includes(coreItem)) return true;
            }
        }
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
        const matchedDropCamp = inProgressList.find(c =>
            c.id === curCamp.id ||
            (c.game && (c.game.displayName === activeStream.campaign.game.name || c.game.name === activeStream.campaign.game.name))
        );

        if (matchedDropCamp && matchedDropCamp.timeBasedDrops) {
            let maxWatchedInCamp = 0;
            let allDropsClaimedInCamp = true;

            for (const drop of matchedDropCamp.timeBasedDrops) {
                if (drop.requiredMinutesWatched > curCamp.minutesNeeded) {
                    curCamp.minutesNeeded = drop.requiredMinutesWatched;
                }

                const isClaimed = (drop.self && drop.self.isClaimed === true) || isDropItemClaimed(drop, eventDropsList);
                const currentWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                    ? drop.self.currentMinutesWatched
                    : (isClaimed ? drop.requiredMinutesWatched : 0);

                if (currentWatched > maxWatchedInCamp) {
                    maxWatchedInCamp = currentWatched;
                }

                if (!isClaimed && currentWatched < drop.requiredMinutesWatched) {
                    allDropsClaimedInCamp = false;
                }

                if (curCamp.items) {
                    const matchedItem = curCamp.items.find(i => i.id === drop.id || isDropItemClaimed(i, [drop]));
                    if (matchedItem) {
                        matchedItem.self = matchedItem.self || {};
                        matchedItem.self.isClaimed = isClaimed;
                        matchedItem.self.currentMinutesWatched = currentWatched;
                    }
                }
            }

            if (maxWatchedInCamp > (curCamp.minutesWatched || 0)) {
                curCamp.minutesWatched = maxWatchedInCamp;
            }

            if (allDropsClaimedInCamp || curCamp.minutesWatched >= curCamp.minutesNeeded) {
                curCamp.minutesWatched = curCamp.minutesNeeded;
            } else {
                allCampaignsCompleted = false;
            }
        } else {
            let allItemsClaimed = true;
            if (curCamp.items && curCamp.items.length > 0) {
                for (const item of curCamp.items) {
                    const isClaimed = isDropItemClaimed(item, eventDropsList) || (item.self && item.self.isClaimed === true);
                    item.self = item.self || {};
                    item.self.isClaimed = isClaimed;
                    if (isClaimed) {
                        item.self.currentMinutesWatched = item.reqTime || curCamp.minutesNeeded;
                    }

                    if (!item.self.isClaimed && (curCamp.minutesWatched || 0) < curCamp.minutesNeeded) {
                        allItemsClaimed = false;
                    }
                }
            } else {
                if ((curCamp.minutesWatched || 0) < curCamp.minutesNeeded) {
                    allItemsClaimed = false;
                }
            }

            if (allItemsClaimed) {
                curCamp.minutesWatched = curCamp.minutesNeeded;
            } else {
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
            const inventory = await client.getInventory().catch(() => null);
            if (inventory) {
                const isDone = syncCampaignProgressWithInventory(inventory);
                await checkClaimDrop();

                if (isDone || (activeStream.campaigns && activeStream.campaigns[activeStream.campaign.onCamp] && activeStream.campaigns[activeStream.campaign.onCamp].minutesWatched >= activeStream.campaigns[activeStream.campaign.onCamp].minutesNeeded)) {
                    const allDone = activeStream.campaigns && activeStream.campaigns.every(c => c.minutesWatched >= c.minutesNeeded);
                    if (allDone) {
                        console.log("All campaigns completed! Preserving finished state...");
                        if (activeStream.campaign) {
                            activeStream.campaign.isCompleted = true;
                            activeStream.campaign.curWatching = null;
                        }
                        await windowManager("close");
                        await saveState();
                        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                        await checkForDrops();
                        return;
                    } else {
                        activeStream.campaign.reOpening = true;
                        activeStream.campaign.onCamp = (activeStream.campaigns.length - 1) === activeStream.campaign.onCamp ? 0 : activeStream.campaign.onCamp + 1;
                        await runCampaign();
                        return;
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
                setTimeout(checkForDrops, 2000);
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
                }
                sendResponse({ success: true });
                break;

            case "claim-points":
                await fetchTwitchCookiesAndInitClient();
                if (client && message.data) {
                    try {
                        const success = await client.claimChannelPoints(message.data.claimID, message.data.channelID);
                        if (success && success.success) {
                            const pts = success.points || 50;
                            extStats.claimedPoints += pts;
                            logActivity("points", `+${pts} Channel Points`, "Twitch Channel", pts);
                            await saveState();
                            chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
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
                    extStats.claimedPoints += earned;
                    logActivity("points", `+${earned} Channel Points (Watch Bonus)`, "Twitch Stream", earned);
                    await saveState();
                    chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
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

                // Fallback default games
                const defaultGames = [
                    { game: { displayName: "World of Warcraft" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Rust" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Valorant" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Overwatch 2" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Apex Legends" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Counter-Strike 2" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Escape from Tarkov" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Dead by Daylight" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Fortnite" }, self: { isAccountConnected: true } },
                    { game: { displayName: "Palworld" }, self: { isAccountConnected: true } }
                ];
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
                                activeStream.campaign.isCompleted = true;
                                activeStream.campaign.curWatching = null;
                                await saveState();
                            }
                        }
                    } catch (err) {}
                }
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
                sendResponse({ activeStream });
                break;

            case "p:settingsChanged":
                settings = { ...settings, ...message.data.settings };
                await saveState();
                sendResponse({ success: true, settings });
                break;

            case "getAutoDropGames":
                chrome.runtime.sendMessage({
                    type: "setAutoDropGames",
                    data: { allConnected: listOfConnected, enabled: autoDropGames }
                }).catch(() => {});
                sendResponse({ allConnected: listOfConnected, enabled: autoDropGames });
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

    return true; // Keep sendResponse open
});

// --- Tab Watchdog ---

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await hydrateState();
    if (activeStream.campaign !== "none" && extEnabled) {
        if (tabId === curWindow.id && (!activeStream.campaign || !activeStream.campaign.reOpening)) {
            curWindow.id = 0;
            curWindow.type = "none";
            await saveState();
            // Try recovering or opening next stream in 5s
            setTimeout(async () => {
                await hydrateState();
                if (activeStream.campaign !== "none" && !activeStream.campaign.isCompleted) {
                    await runCampaign();
                }
            }, 5000);
        }
    }
});

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);

async function startup() {
    console.log("Auto Twitch Drops Pro background initialized");
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

async function runCampaign() {
    if (!activeStream.campaign || !activeStream.campaigns || activeStream.campaigns.length === 0) return;
    if (activeStream.campaign.reOpening) activeStream.campaign.reOpening = false;

    let curCamp = activeStream.campaigns[activeStream.campaign.onCamp];
    if (!curCamp) {
        await endCampaign();
        return;
    }

    let allDropsGot = activeStream.campaigns.every(camp => camp.minutesWatched >= camp.minutesNeeded && camp.minutesNeeded > 0);
    if (allDropsGot) {
        console.log("All drops claimed for campaign!");
        if (activeStream.campaign) {
            activeStream.campaign.isCompleted = true;
            activeStream.campaign.curWatching = null;
        }
        await windowManager("close");
        await saveState();
        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
        return;
    }

    await fetchTwitchCookiesAndInitClient();

    if (!curCamp.streamers || curCamp.streamers.length === 0) {
        const stream = await client.getChannelWithDrops(activeStream.campaign.game.name, curCamp.id, activeStream.campaign.slug);
        if (stream === "nostream" || !stream || !stream.broadcaster) {
            activeStream.campaign.onCamp = (activeStream.campaigns.length - 1) === activeStream.campaign.onCamp ? 0 : activeStream.campaign.onCamp + 1;
            await saveState();
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
            await windowManager("wait");
            return;
        }
        activeStream.campaign.curWatching = stream.broadcaster.login;
        await saveState();
    } else {
        const streamInfo = await getStreamForGame();
        if (streamInfo === null || !streamInfo.login) {
            const stream = await client.getChannelWithDrops(activeStream.campaign.game.name, curCamp.id, activeStream.campaign.slug);
            if (stream !== "nostream" && stream && stream.broadcaster) {
                activeStream.campaign.curWatching = stream.broadcaster.login;
                await saveState();
            } else {
                activeStream.campaign.onCamp = (activeStream.campaigns.length - 1) === activeStream.campaign.onCamp ? 0 : activeStream.campaign.onCamp + 1;
                await saveState();
                return;
            }
        } else {
            activeStream.campaign.curWatching = streamInfo.login;
            await saveState();
        }
    }

    const streamUrl = `https://www.twitch.tv/${activeStream.campaign.curWatching}`;
    const tab = await windowManager("open", { active: true, url: streamUrl });

    if (settings.autoMute && tab && tab.id) {
        chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    }

    activeStream.campaign.status = "watching";
    await saveState();
    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
    updateBadgeUI();
}

async function endCampaign() {
    console.log("Ending active campaign...");
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

    let campaigns = await client.getDropCampaigns().catch(() => []);
    if (!campaigns || campaigns.length === 0) return;

    if (game === "Badges") {
        campaigns = campaigns.filter(c => c.detailsURL && c.detailsURL.includes("twitch-chat-badges"));
    } else {
        campaigns = campaigns.filter(c => c.game != null && c.game.displayName === game && c.status === "ACTIVE");
    }

    if (campaigns.length === 0) return;

    const campAry = campaigns.map(c => c.id);
    activeStream.campaign = {
        game: {
            name: game === "Badges" ? "Badges" : campaigns[0].game.displayName
        },
        onCamp: 0,
        curWatching: "",
        lastLoop: 0,
        allowGen: true,
        slug: null,
        status: "starting",
        reOpening: false
    };
    activeStream.campaigns = [];

    const campDeets = await client.getDropCampaignDetails(campAry).catch(() => []);
    let inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
    if (!inventory) inventory = { dropCampaignsInProgress: [], gameEventDrops: [] };

    let itemsToProcess = [];
    if (Array.isArray(campDeets) && campDeets.length > 0) {
        for (const c of campDeets) {
            const dropCamp = c?.data?.user?.dropCampaign || c?.data?.dropCampaign;
            if (dropCamp) itemsToProcess.push(dropCamp);
        }
    }

    if (itemsToProcess.length === 0) {
        itemsToProcess = campaigns;
    }

    const eventDropsList = (inventory && inventory.gameEventDrops) ? inventory.gameEventDrops : [];

    for (const dropCamp of itemsToProcess) {
        if (!dropCamp) continue;
        const streams = [];
        if (activeStream.campaign.slug === null && dropCamp.game) {
            activeStream.campaign.slug = dropCamp.game.slug;
        }
        if (dropCamp.allow && dropCamp.allow.channels) {
            for (const stream of dropCamp.allow.channels) {
                if (stream && stream.name) streams.push(stream.name);
            }
        }
        activeStream.campaign.allowGen = false;
        let maxTime = 0;
        let timeWatched = 0;
        const allDrops = [];

        for (const drop of (dropCamp.timeBasedDrops || [])) {
            if (drop.requiredMinutesWatched > maxTime) maxTime = drop.requiredMinutesWatched;
            if (drop.requiredMinutesWatched !== 0 && drop.benefitEdges && drop.benefitEdges[0]) {
                const benefitId = drop.benefitEdges[0].benefit.id;
                const isClaimedInEvents = eventDropsList.some(e => e.id === drop.id || e.id === benefitId || (e.name && drop.name && e.name.toLowerCase() === drop.name.toLowerCase()));
                const isClaimedInSelf = Boolean(drop.self && drop.self.isClaimed);
                const isClaimed = isClaimedInEvents || isClaimedInSelf;
                const currentWatched = (drop.self && drop.self.currentMinutesWatched) ? drop.self.currentMinutesWatched : (isClaimed ? drop.requiredMinutesWatched : 0);

                allDrops.push({
                    name: `${drop.name} - ${drop.benefitEdges[0].benefit.name}`,
                    picture: drop.benefitEdges[0].benefit.imageAssetURL,
                    reqTime: drop.requiredMinutesWatched,
                    id: drop.id,
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
                        const matchedItem = allDrops.find(item => item.id === drop.id);
                        if (matchedItem) {
                            const isClaimed = drop.self.isClaimed || matchedItem.self.isClaimed || drop.self.currentMinutesWatched >= drop.requiredMinutesWatched;
                            matchedItem.self.isClaimed = isClaimed;
                            matchedItem.self.currentMinutesWatched = drop.self.currentMinutesWatched;
                        }
                    }
                }
            }
        }

        if (maxTime === 0) maxTime = 60;

        activeStream.campaigns.push({
            game: dropCamp.game ? dropCamp.game.name : game,
            id: dropCamp.id,
            minutesNeeded: maxTime,
            minutesWatched: timeWatched,
            streamers: streams,
            items: allDrops
        });
    }

    const isDone = syncCampaignProgressWithInventory(inventory);
    if (isDone) {
        console.log(`All drops for ${game} already claimed!`);
        if (activeStream && activeStream.campaign) {
            activeStream.campaign.isCompleted = true;
            activeStream.campaign.curWatching = null;
        }
        await windowManager("close");
        await saveState();
        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream } }).catch(() => {});
        return;
    }

    await saveState();
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
                    let finalDrop = { id: "", time: 0 };
                    let gotFinalDrop = false;

                    for (const drop of (campaignDetails.timeBasedDrops || [])) {
                        if (drop.requiredMinutesWatched > finalDrop.time && drop.benefitEdges && drop.benefitEdges[0]) {
                            finalDrop = {
                                id: drop.benefitEdges[0].benefit.id,
                                time: drop.requiredMinutesWatched
                            };
                        }
                    }

                    if (inventory && inventory.gameEventDrops) {
                        for (const itemInv of inventory.gameEventDrops) {
                            if (itemInv.id === finalDrop.id) {
                                gotFinalDrop = true;
                            }
                        }
                    }

                    if (!gotFinalDrop && finalDrop.time !== 0) {
                        if (!gamesToRun.some((g) => g.game === campaign.game.displayName)) {
                            gamesToRun.push({ game: campaign.game.displayName, endsAt });
                        }
                    }
                }
            }

            if (gamesToRun.length !== 0) {
                // Priority to campaigns ending soonest!
                gamesToRun.sort((a, b) => a.endsAt - b.endsAt);
                console.log(`Auto queue selecting next priority game: ${gamesToRun[0].game}`);
                await createCampaign(gamesToRun[0].game);
            }
        } catch (e) {
            console.error("Error in checkForDrops:", e);
        }
    }
}

async function getStreamForGame() {
    if (gettingStreamObj.lastPull + 60 <= Date.now() / 1000) {
        gettingStreamObj.allStreamers = await client.getAllLiveForGame(activeStream.campaign.game.name).catch(() => []);
        gettingStreamObj.lastPull = Date.now() / 1000;
    }
    if (!gettingStreamObj.allStreamers || gettingStreamObj.allStreamers.length === 0) return null;

    let selectedStream = "";
    let dropLive = false;

    for (const stream of gettingStreamObj.allStreamers) {
        if (stream && stream.data && stream.data.userOrError && stream.data.userOrError.login) {
            const login = stream.data.userOrError.login;
            const curCamp = activeStream.campaigns[activeStream.campaign.onCamp];
            if (curCamp && curCamp.streamers && curCamp.streamers.includes(login) && stream.data.userOrError.stream != null) {
                selectedStream = login;
                dropLive = true;
                break;
            }
        }
    }

    if (!dropLive) {
        const first = gettingStreamObj.allStreamers[0];
        if (first && first.data && first.data.userOrError) {
            selectedStream = first.data.userOrError.login;
        } else {
            return null;
        }
    }

    const currentStreamInfo = await client.getStreamMetadata(selectedStream).catch(() => null);
    if (currentStreamInfo) {
        currentStreamInfo.login = selectedStream;
    }
    return currentStreamInfo;
}

async function checkClaimDrop() {
    if (!client) return;
    try {
        const inventory = await client.getInventory();
        if (!inventory || !inventory.dropCampaignsInProgress) return;

        for (const camp of inventory.dropCampaignsInProgress) {
            for (const drop of (camp.timeBasedDrops || [])) {
                if (drop.requiredMinutesWatched !== 0 && drop.self && drop.requiredMinutesWatched <= drop.self.currentMinutesWatched && !drop.self.isClaimed) {
                    const dropClaim = await client.claimDropReward(drop.self.dropInstanceID);
                    if (dropClaim) {
                        console.log("Claimed Drop successfully:", drop.name);
                        extStats.claimedDrops++;
                        const img = drop.benefitEdges && drop.benefitEdges[0] ? drop.benefitEdges[0].benefit.imageAssetURL : "assets/img/atd-48.png";
                        logActivity("drop", drop.name || "Drop Reward Claimed", camp.game ? camp.game.displayName : "Twitch Drop", 0, img);
                        await saveState();
                        chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
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
            chrome.windows.create({ focused: false, type: "popup", url: "https://www.twitch.tv/drops/inventory/" }).then((window) => {
                if (window) autoGetTokenWindow = window.id;
            }).catch(() => {});
        }
    }
}

async function windowManager(func, data) {
    if (func === "open") {
        if (curWindow.id === 0) {
            const existingTabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
            if (existingTabs && existingTabs.length > 0) {
                const tab = existingTabs[0];
                curWindow.id = tab.id;
                curWindow.type = "tab";
                await saveState();
                if (data.url && tab.url !== data.url) {
                    await chrome.tabs.update(tab.id, { url: data.url }).catch(() => {});
                }
                return tab;
            }

            const tab = await chrome.tabs.create(data);
            curWindow.id = tab.id;
            curWindow.type = "tab";
            await saveState();
            return tab;
        } else {
            let tab = await chrome.tabs.get(curWindow.id).catch(() => null);
            if (!tab) {
                const existingTabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
                if (existingTabs && existingTabs.length > 0) {
                    tab = existingTabs[0];
                    curWindow.id = tab.id;
                    await saveState();
                } else {
                    tab = await chrome.tabs.create(data);
                    curWindow.id = tab.id;
                    await saveState();
                    return tab;
                }
            }
            if (data.url && data.url !== tab.url) {
                await chrome.tabs.update(curWindow.id, { url: data.url }).catch(() => {});
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
    } else if (func === "wait") {
        const waitingURL = chrome.runtime.getURL("waiting.html");
        if (curWindow.id !== 0) {
            await chrome.tabs.update(curWindow.id, { url: waitingURL }).catch(async () => {
                const tab = await chrome.tabs.create({ active: true, url: waitingURL });
                curWindow.id = tab.id;
                await saveState();
            });
        } else {
            const tab = await chrome.tabs.create({ active: true, url: waitingURL });
            curWindow.id = tab.id;
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
    if (activeStream && activeStream.campaign && activeStream.campaign !== "none" && activeStream.campaign.status === "watching") {
        chrome.action.setBadgeText({ text: "LIVE" }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: "#00F59B" }).catch(() => {});
    } else {
        chrome.action.setBadgeText({ text: "PRO" }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: "#9146FF" }).catch(() => {});
    }
}