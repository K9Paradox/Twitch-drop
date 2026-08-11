/** 
@typedef {import("./types").activeStream} activeStream
**/
import { Client } from "./background/twitchApi.js"

let client = null;
let settings = {
    autoRefresh: true,
    showAllGames: true,
    autoGetToken: true,
    watchPopout: true,
    autoMute: true,
    setShowBadges: true
};
let listOfConnected = [];
let autoDropGames = [];
let priorityStreams = [];
let windowId = 0;
let premiumStatus = {
    email: "pro@unlocked.local",
    premium: true
};
let extStats = {
    claimedDrops: 0,
    claimedPoints: 0,
    installed: new Date().toISOString(),
    premium: true,
    premiumAquired: Date.now(),
    connectedGames: [],
    success: true,
    uuid: "unlocked-uuid-local",
    stripecustomer: "",
    subscription: "",
    dev: 0
};
let config = {
    announcement: "Pro features fully unlocked! Auto Drops & Auto Points are active.",
    disabled: false,
    priorityStreams: [],
    priorityStreamsDefault: "",
    claimpoints: true,
    badgesGameNames: ""
};
let extEnabled = true;
/** @type {activeStream} */
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
let currentBadgeDrops = [];
let cfdInterval, agtInterval, startupTimeout, recheckCampTimeout, ssdInterval;

function saveState() {
    chrome.storage.local.set({ activeStream, curWindow }).catch(() => {});
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

        let oauthToken = authCookie ? authCookie.value : null;
        let deviceId = deviceCookie ? deviceCookie.value : null;

        let localData = await chrome.storage.local.get(["oauthToken", "deviceId", "userId", "uuid"]).catch(() => ({}));
        
        oauthToken = oauthToken || localData.oauthToken;
        deviceId = deviceId || localData.deviceId;

        if (oauthToken) {
            chrome.storage.local.set({ oauthToken, deviceId });
            if (client === null) {
                client = new Client({ clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko", oauthToken, deviceId, userId: localData.userId, uuid: localData.uuid });
            } else {
                client.updateUserInfo({ oauthToken, deviceId, userId: localData.userId, uuid: localData.uuid });
            }
        } else if (client === null) {
            client = new Client({ clientId: "kimne78kx3ncx6brgo4mv6wki5h1ko" });
        }
    } catch (e) {
        console.warn("Error fetching Twitch cookies directly:", e);
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
                const currentWatched = (drop.self && drop.self.currentMinutesWatched !== undefined) ? drop.self.currentMinutesWatched : (isClaimed ? drop.requiredMinutesWatched : 0);

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

// MV3 Alarm Keepalive
chrome.alarms.create("keepAliveAlarm", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepAliveAlarm") {
        if (extEnabled) {
            fetchTwitchCookiesAndInitClient().then(() => {
                checkForDrops();
                if (activeStream && activeStream.campaign !== "none") {
                    checkClaimDrop();
                }
            });
        }
    }
});

startupTimeout = setTimeout(startup, 1000);

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (!message) return;
    if (extEnabled) {
        if (message.type === "clientInfo") {
            if (message.data && message.data.oauthToken) {
                if (client === null)
                    client = new Client(message.data);
                else
                    client.updateUserInfo(message.data);
                chrome.storage.local.set({ oauthToken: message.data.oauthToken, deviceId: message.data.deviceId, userId: message.data.userId });
            }
        } else if (message.type === "sendInteg") {
            if (client === null) {
                chrome.storage.sync.set({ twitchInteg: message.data });
                await fetchTwitchCookiesAndInitClient();
            } else {
                client.setInteg(message.data);
            }
            if (autoGetTokenWindow !== 0) {
                chrome.windows.remove(autoGetTokenWindow).catch(() => {});
                autoGetTokenWindow = 0;
            }
        } else if (message.type === "claim-points") {
            console.log("Claiming channel points...", message.data);
            await fetchTwitchCookiesAndInitClient();
            if (client) {
                try {
                    let success = await client.claimChannelPoints(message.data.claimID, message.data.channelID);
                    if (success && success.success) {
                        extStats.claimedPoints += (success.points || 50);
                        chrome.storage.local.set({ extStats });
                        chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
                    }
                } catch (e) {
                    console.error("Error claiming channel points:", e);
                }
            }
        } else if (message.type === "points-earned") {
            extStats.claimedPoints += (message.data.points || 50);
            chrome.storage.local.set({ extStats });
            chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
        } else if (message.type === "claim-drop") {
            console.log("Triggering drop claim check...");
            await fetchTwitchCookiesAndInitClient();
            if (client) {
                checkClaimDrop();
            }
        } else if (message.type === "p:getConnectedGames") {
            const sendGames = async () => {
                await fetchTwitchCookiesAndInitClient();
                try {
                    let data = await client.getDropCampaigns();
                    if (Array.isArray(data) && data.length > 0) {
                        chrome.runtime.sendMessage({ type: "p:connectedGames", data }).catch(() => {});
                        for (const c of data) {
                            if (c && c.game && !listOfConnected.includes(c.game.displayName)) {
                                listOfConnected.push(c.game.displayName);
                            }
                        }
                        extStats.connectedGames = listOfConnected;
                        chrome.storage.local.set({ listOfConnected, extStats });
                        chrome.runtime.sendMessage({
                            type: "setAutoDropGames", data: {
                                allConnected: listOfConnected,
                                enabled: autoDropGames
                            }
                        }).catch(() => {});
                        return;
                    }
                } catch (e) {
                    console.error("Error fetching drop campaigns:", e);
                }

                // Fallback default games list so dropdown is never empty
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
            };
            sendGames();
        } else if (message.type === "p:startCampaign") {
            if (message.data.campaign === "none") {
                if (activeStream.campaign !== "none" && curWindow.id !== 0) {
                    endCampaign();
                }
                activeStream = { campaign: "none" };
                saveState();
                chrome.storage.local.remove(["drops", "activeStream"]);
                chrome.runtime.sendMessage({ type: "p:startedCampaign", data: { drops: "none" } }).catch(() => {});
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
                return;
            }
            createCampaign(message.data.campaign);
        } else if (message.type === "p:getCurrentDrops") {
            await fetchTwitchCookiesAndInitClient();
            chrome.storage.local.get(["activeStream"]).then(async (res) => {
                if (res.activeStream && res.activeStream.campaign !== "none") {
                    activeStream = res.activeStream;
                }
                if (client && activeStream.campaign && activeStream.campaign !== "none" && activeStream.campaigns) {
                    try {
                        let inventory = await client.getInventory().catch(() => null);
                        if (inventory) {
                            let isDone = syncCampaignProgressWithInventory(inventory);
                            if (isDone) {
                                console.log("Current campaign completed during sync! Preserving completed campaign state...");
                                if (activeStream && activeStream.campaign) {
                                    activeStream.campaign.isCompleted = true;
                                    activeStream.campaign.curWatching = null;
                                }
                                saveState();
                                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
                                return;
                            }
                        }
                    } catch (err) {}
                }
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
            });
        } else if (message.type === "p:getConfig") {
            chrome.runtime.sendMessage({ type: "p:setConfig", data: config }).catch(() => {});
        } else if (message.type === "setAutoDrops") {
            if (activeStream.campaign && activeStream.campaign.game) {
                chrome.storage.local.set({ autoDrops: activeStream.campaign.game.name });
            }
        } else if (message.type === "updatePriorityStreams") {
            priorityStreams = message.data.prio;
            meshPrioStreams();
        } else if (message.type === "p:settingsChanged") {
            settings = message.data.settings;
            chrome.storage.local.set({ settings });
        } else if (message.type === "p:changeToStream") {
            if (activeStream.campaign) {
                activeStream.campaign.reOpening = true;
                clearInterval(activeStream.campaign.interval);
                activeStream.campaigns.forEach((v, i) => {
                    if (v.streamers.includes(message.data) && message.data !== "gen") {
                        activeStream.campaign.onCamp = i;
                    } else if (message.data === "gen" && v.streamers === "gen") {
                        activeStream.campaign.onCamp = i;
                    }
                });
                runCampaign();
            }
        } else if (message.type === "p:deleteDrop") {
            if (activeStream.campaigns) {
                activeStream.campaigns.forEach((v, i) => {
                    if (v.streamers.includes(message.data) && message.data !== "gen") {
                        activeStream.campaigns.splice(i, 1);
                    } else if (message.data === "gen" && v.streamers === "gen") {
                        activeStream.campaigns.splice(i, 1);
                    }
                });
            }
        } else if (message.type === "p:recheckPrem") {
            getPremiumStatus();
        } else if (message.type === "getAutoDropGames") {
            chrome.runtime.sendMessage({
                type: "setAutoDropGames", data: {
                    allConnected: listOfConnected,
                    enabled: autoDropGames
                }
            }).catch(() => {});
        } else if (message.type === "toggleAutoDropGame") {
            if (message.data[1] === true) {
                if (!autoDropGames.includes(message.data[0]))
                    autoDropGames.push(message.data[0]);
                chrome.storage.local.set({ autoDropGames: autoDropGames });
            } else {
                const idx = autoDropGames.indexOf(message.data[0]);
                if (idx !== -1) autoDropGames.splice(idx, 1);
                chrome.storage.local.set({ autoDropGames: autoDropGames });
            }
        } else if (message.type === "getPremiumStatus") {
            getPremiumStatus();
        } else if (message.type === "getExtStats") {
            chrome.runtime.sendMessage({ type: "p:statsUpdated", data: extStats }).catch(() => {});
        }
    }
    if (message.type === "toggleExt") {
        extEnabled = message.data;
        chrome.storage.local.set({ exEnabled: extEnabled });
        if (extEnabled) {
            enableAutoplayForTwitch();
            createClient();
            setTimeout(checkForDrops, 3000);
            cfdInterval = setInterval(checkForDrops, 180000);
            ssdInterval = setInterval(displayBadgeDrops, 600000);
            agtInterval = setInterval(autoGetToken, 960000);
        } else {
            clearInterval(cfdInterval);
            clearInterval(ssdInterval);
            clearInterval(agtInterval);

            if (activeStream.campaign !== "none" && curWindow.id !== 0) {
                endCampaign();
            }
            activeStream = { campaign: "none" };
            saveState();
            chrome.storage.local.remove(["drops", "activeStream"]);
            chrome.runtime.sendMessage({ type: "p:startedCampaign", data: { drops: "none" } }).catch(() => {});
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
        }
    }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (activeStream.campaign !== "none" && extEnabled) {
        if (tabId === curWindow.id && (!activeStream.campaign || !activeStream.campaign.reOpening)) {
            clearInterval(activeStream.interval);
            endCampaign();
        }
    }
});

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);

async function startup() {
    clearTimeout(startupTimeout);
    console.log("Auto Twitch Drops background started");
    enableAutoplayForTwitch();
    chrome.storage.local.set({ curBadgeDrops: [] });
    
    await fetchTwitchCookiesAndInitClient();

    chrome.storage.local.get(["settings", "autoDropGames", "exEnabled", "priorityStreams", "extStats", "listOfConnected", "activeStream", "curWindow"], (val) => {
        if (val.extStats) {
            extStats = { ...extStats, ...val.extStats, premium: true };
        }
        if (val.listOfConnected) {
            listOfConnected = val.listOfConnected;
        }

        if (val.curWindow) {
            curWindow = val.curWindow;
        }

        if (val.activeStream && val.activeStream.campaign && val.activeStream.campaign !== "none") {
            activeStream = val.activeStream;
            console.log("Restored activeStream session:", activeStream);
        }

        if (!val.settings) {
            chrome.storage.local.set({ settings });
        } else {
            settings = { ...settings, ...val.settings };
            chrome.storage.local.set({ settings });
        }

        autoDropGames = val.autoDropGames || [];
        extEnabled = val.exEnabled !== undefined ? val.exEnabled : true;

        if (extEnabled) {
            priorityStreams = val.priorityStreams || [];
            setTimeout(autoGetToken, 5000);
            setTimeout(checkForDrops, 5000);
            setTimeout(displayBadgeDrops, 10000);
            
            cfdInterval = setInterval(checkForDrops, 180000);
            agtInterval = setInterval(autoGetToken, 960000);
            ssdInterval = setInterval(displayBadgeDrops, 600000);
        }
    });
}

function createClient() {
    fetchTwitchCookiesAndInitClient();
}

async function runCampaign() {
    if (!activeStream.campaign || !activeStream.campaigns || activeStream.campaigns.length === 0) return;
    if (activeStream.campaign.reOpening)
        activeStream.campaign.reOpening = false;

    if (activeStream.campaign.onCamp === 0) {
        if (Math.round((new Date().getTime() / 1000) - 20) <= activeStream.campaign.lastLoop) {
            let tempBool = true;
            for (const camp of activeStream.campaigns) {
                if (camp.minutesWatched < camp.minutesNeeded)
                    tempBool = false;
            }
            if (!tempBool) {
                activeStream.campaign.allowGen = true;
                activeStream.campaign.status = "nostream";
                saveState();
                gettingStreamObj.notPlayingGame = [];
                chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
                windowManager("wait");
                recheckCampTimeout = setTimeout(() => {
                    runCampaign();
                }, 180000);
                return;
            } else {
                endCampaign();
                return;
            }
        }
        activeStream.campaign.lastLoop = Math.round(new Date().getTime() / 1000);
    }

    let curCamp = activeStream.campaigns[activeStream.campaign.onCamp];
    if (!curCamp) {
        endCampaign();
        return;
    }

    if (curCamp.streamers && curCamp.streamers.length === 0 && !activeStream.campaign.allowGen && activeStream.campaigns.length > 1) {
        activeStream.campaign.onCamp = (activeStream.campaigns.length - 1) === activeStream.campaign.onCamp ? 0 : activeStream.campaign.onCamp + 1;
        saveState();
        runCampaign();
        return;
    }

    if (curCamp.minutesWatched >= curCamp.minutesNeeded && curCamp.minutesNeeded !== 0 && curCamp.minutesWatched !== 0) {
        activeStream.campaign.onCamp = (activeStream.campaigns.length - 1) === activeStream.campaign.onCamp ? 0 : activeStream.campaign.onCamp + 1;
        saveState();
        runCampaign();
        return;
    }

    let allDropsGot = true;
    for (const camp of activeStream.campaigns) {
        if (camp.minutesWatched < camp.minutesNeeded) {
            allDropsGot = false;
        }
    }
    if (allDropsGot) {
        console.log("All drops got in runCampaign! Preserving completed campaign state...");
        if (activeStream && activeStream.campaign) {
            activeStream.campaign.isCompleted = true;
            activeStream.campaign.curWatching = null;
        }
        windowManager("close");
        saveState();
        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
        return;
    }

    await fetchTwitchCookiesAndInitClient();

    if (!curCamp.streamers || curCamp.streamers.length === 0) {
        let stream = await client.getChannelWithDrops(activeStream.campaign.game.name, curCamp.id, activeStream.campaign.slug);
        if (stream === "nostream" || !stream || !stream.broadcaster) {
            activeStream.campaign.onCamp = (activeStream.campaigns.length - 1) === activeStream.campaign.onCamp ? 0 : activeStream.campaign.onCamp + 1;
            saveState();
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
            windowManager("wait");
            runCampaign();
            return;
        }
        activeStream.campaign.curWatching = stream.broadcaster.login;
        saveState();
    } else {
        let streamInfo = await getStreamForGame();
        if (streamInfo === null || !streamInfo.login) {
            let stream = await client.getChannelWithDrops(activeStream.campaign.game.name, curCamp.id, activeStream.campaign.slug);
            if (stream !== "nostream" && stream && stream.broadcaster) {
                activeStream.campaign.curWatching = stream.broadcaster.login;
                saveState();
            } else {
                activeStream.campaign.onCamp = (activeStream.campaigns.length - 1) === activeStream.campaign.onCamp ? 0 : activeStream.campaign.onCamp + 1;
                saveState();
                runCampaign();
                return;
            }
        } else {
            activeStream.campaign.curWatching = streamInfo.login;
            saveState();
        }
    }

    let streamUrl = `https://www.twitch.tv/${activeStream.campaign.curWatching}`;
    windowManager("open", { active: true, url: streamUrl }).then(async tab => {
        if (settings.autoMute && tab && tab.id) {
            chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
        }
        activeStream.campaign.status = "watching";
        saveState();
        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
        
        clearInterval(activeStream.campaign.interval);
        activeStream.campaign.interval = setInterval(async () => {
            if (!client || !activeStream.campaign || !activeStream.campaign.curWatching) return;
            let inventory = await client.getInventory().catch(() => null);
            if (!inventory) return;

            let isDone = syncCampaignProgressWithInventory(inventory);
            checkClaimDrop();

            if (isDone || (activeStream.campaigns[activeStream.campaign.onCamp] && activeStream.campaigns[activeStream.campaign.onCamp].minutesWatched >= activeStream.campaigns[activeStream.campaign.onCamp].minutesNeeded)) {
                let allDone = activeStream.campaigns.every(c => c.minutesWatched >= c.minutesNeeded);
                if (allDone) {
                    console.log("All campaigns completed during interval! Preserving completed state...");
                    if (activeStream && activeStream.campaign) {
                        activeStream.campaign.isCompleted = true;
                        activeStream.campaign.curWatching = null;
                    }
                    if (activeStream && activeStream.campaign && activeStream.campaign.interval) {
                        clearInterval(activeStream.campaign.interval);
                    }
                    windowManager("close");
                    saveState();
                    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
                    return;
                } else {
                    clearInterval(activeStream.campaign.interval);
                    activeStream.campaign.reOpening = true;
                    activeStream.campaign.onCamp = (activeStream.campaigns.length - 1) === activeStream.campaign.onCamp ? 0 : activeStream.campaign.onCamp + 1;
                    runCampaign();
                    return;
                }
            }

            saveState();
            chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
        }, 30000);
    }).catch(() => {});
}

function endCampaign() {
    console.log("Campaign finished!");
    if (activeStream && activeStream.campaign && activeStream.campaign.interval) {
        clearInterval(activeStream.campaign.interval);
    }
    clearTimeout(recheckCampTimeout);
    windowManager("close");
    activeStream = { campaign: "none" };
    gettingStreamObj.notPlayingGame = [];
    saveState();
    chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
    chrome.storage.local.remove(["activeStream", "drops"]);
    checkClaimDrop();
}

async function createCampaign(game) {
    await fetchTwitchCookiesAndInitClient();

    let campaigns = await client.getDropCampaigns().catch(() => []);
    if (!campaigns || campaigns.length === 0) return;

    if (game === "Badges")
        campaigns = campaigns.filter(c => c.detailsURL && c.detailsURL.includes("twitch-chat-badges"));
    else
        campaigns = campaigns.filter(c => c.game != null && c.game.displayName === game && c.status === "ACTIVE");

    if (campaigns.length === 0) return;

    let campAry = campaigns.map(c => c.id);
    activeStream.campaign = {
        game: {
            name: game === "Badges" ? "Badges" : campaigns[0].game.displayName
        },
        onCamp: 0,
        curWatching: "",
        lastLoop: 0,
        interval: 0,
        allowGen: true,
        slug: null,
        status: "starting",
        reOpening: false
    };
    activeStream.campaigns = [];

    let campDeets = await client.getDropCampaignDetails(campAry).catch(() => []);
    let inventory = await client.getInventory().catch(() => ({ dropCampaignsInProgress: [], gameEventDrops: [] }));
    if (!inventory) inventory = { dropCampaignsInProgress: [], gameEventDrops: [] };

    let itemsToProcess = [];
    if (Array.isArray(campDeets) && campDeets.length > 0) {
        for (const c of campDeets) {
            let dropCamp = c?.data?.user?.dropCampaign || c?.data?.dropCampaign;
            if (dropCamp) itemsToProcess.push(dropCamp);
        }
    }

    if (itemsToProcess.length === 0) {
        itemsToProcess = campaigns;
    }

    const eventDropsList = (inventory && inventory.gameEventDrops) ? inventory.gameEventDrops : [];

    for (const dropCamp of itemsToProcess) {
        if (!dropCamp) continue;
        let streams = [];
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
        let allDrops = [];
        
        for (const drop of (dropCamp.timeBasedDrops || [])) {
            if (drop.requiredMinutesWatched > maxTime)
                maxTime = drop.requiredMinutesWatched;
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
        
        let dropStarted = inventory.dropCampaignsInProgress ? inventory.dropCampaignsInProgress.some(obj => obj.id === dropCamp.id) : false;
        if (dropStarted) {
            let inProg = inventory.dropCampaignsInProgress.find(obj => obj.id === dropCamp.id);
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
            noProgress: 0,
            streamers: streams,
            items: allDrops
        });
    }

    let isDone = syncCampaignProgressWithInventory(inventory);
    if (isDone) {
        console.log(`All drops for ${game} already claimed/completed! Preserving completed campaign state...`);
        if (activeStream && activeStream.campaign) {
            activeStream.campaign.isCompleted = true;
            activeStream.campaign.curWatching = null;
        }
        windowManager("close");
        saveState();
        chrome.runtime.sendMessage({ type: "p:sendCurrentDrops", data: { activeStream: activeStream } }).catch(() => {});
        return;
    }

    runCampaign();
    saveState();
}

async function checkForDrops() {
    if (!extEnabled) return;
    await fetchTwitchCookiesAndInitClient();

    if (activeStream.campaign === "none") {
        try {
            let campaigns = await client.getDropCampaigns();
            let inventory = await client.getInventory();
            let gamesToRun = [];

            for (const campaign of (campaigns || [])) {
                if (!campaign || !campaign.game) continue;
                if (autoDropGames.includes(campaign.game.displayName) && campaign.status === "ACTIVE") {
                    let campaignDetails = await client.getDropCampaignDetails(campaign.id);
                    if (!campaignDetails) continue;
                    let endsAt = new Date(campaignDetails.endAt).getTime();
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
                        if (!gamesToRun.some((g) => g.game === campaign.game.displayName))
                            gamesToRun.push({ game: campaign.game.displayName, endsAt });
                    }
                }
            }
            if (activeStream.campaign === "none" && gamesToRun.length !== 0) {
                gamesToRun.sort((a, b) => a.endsAt - b.endsAt);
                createCampaign(gamesToRun[0].game);
            }
        } catch (e) {
            console.error("Error in checkForDrops:", e);
        }
    }
}

async function getStreamForGame() {
    if (gettingStreamObj.lastPull + 60 <= new Date().getTime() / 1000) {
        gettingStreamObj.allStreamers = await client.getAllLiveForGame(activeStream.campaign.game.name).catch(() => []);
        gettingStreamObj.lastPull = new Date().getTime() / 1000;
    }
    if (!gettingStreamObj.allStreamers || gettingStreamObj.allStreamers.length === 0) return null;

    let selectedStream = "";
    let dropLive = false;

    for (const stream of gettingStreamObj.allStreamers) {
        if (stream && stream.data && stream.data.userOrError && stream.data.userOrError.login) {
            let login = stream.data.userOrError.login;
            if (activeStream.campaigns[activeStream.campaign.onCamp].streamers.includes(login) && stream.data.userOrError.stream != null) {
                selectedStream = login;
                dropLive = true;
                break;
            }
        }
    }
    if (!dropLive) {
        let first = gettingStreamObj.allStreamers[0];
        if (first && first.data && first.data.userOrError) {
            selectedStream = first.data.userOrError.login;
        } else {
            return null;
        }
    }
    let currentStreamInfo = await client.getStreamMetadata(selectedStream).catch(() => null);
    if (currentStreamInfo) {
        currentStreamInfo.login = selectedStream;
    }
    return currentStreamInfo;
}

async function checkClaimDrop() {
    if (!client) return;
    try {
        let inventory = await client.getInventory();
        if (!inventory || !inventory.dropCampaignsInProgress) return;
        
        for (const camp of inventory.dropCampaignsInProgress) {
            for (const drop of (camp.timeBasedDrops || [])) {
                if (drop.requiredMinutesWatched !== 0 && drop.requiredMinutesWatched <= drop.self.currentMinutesWatched && !drop.self.isClaimed) {
                    let dropClaim = await client.claimDropReward(drop.self.dropInstanceID);
                    if (dropClaim) {
                        console.log("Claimed Drop successfully!");
                        extStats.claimedDrops++;
                        chrome.storage.local.set({ extStats });
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
        if (!client || !client.integrity || client.integrity.expiration - 960000 < new Date().getTime()) {
            chrome.windows.create({ focused: false, type: "popup", url: "https://www.twitch.tv/drops/inventory/" }).then((window) => {
                if (window) autoGetTokenWindow = window.id;
            }).catch(() => {});
        }
    }
}

async function windowManager(func, data) {
    if (func === "open") {
        if (curWindow.id === 0) {
            let existingTabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
            if (existingTabs && existingTabs.length > 0) {
                let tab = existingTabs[0];
                curWindow.id = tab.id;
                curWindow.type = "tab";
                saveState();
                if (data.url && tab.url !== data.url) {
                    chrome.tabs.update(tab.id, { url: data.url }).catch(() => {});
                }
                return tab;
            }

            let tab = await chrome.tabs.create(data);
            curWindow.id = tab.id;
            curWindow.type = "tab";
            saveState();
            return tab;
        } else {
            let tab = await chrome.tabs.get(curWindow.id).catch(() => null);
            if (!tab) {
                let existingTabs = await chrome.tabs.query({ url: "*://*.twitch.tv/*" }).catch(() => []);
                if (existingTabs && existingTabs.length > 0) {
                    tab = existingTabs[0];
                    curWindow.id = tab.id;
                    saveState();
                } else {
                    tab = await chrome.tabs.create(data);
                    curWindow.id = tab.id;
                    saveState();
                    return tab;
                }
            }
            if (data.url && data.url !== tab.url) {
                chrome.tabs.update(curWindow.id, { url: data.url }).catch(() => {});
            }
            return tab;
        }
    } else if (func === "close") {
        if (curWindow.id !== 0) {
            chrome.tabs.remove(curWindow.id).catch(() => {});
            curWindow.id = 0;
            curWindow.type = "none";
            saveState();
        }
    } else if (func === "wait") {
        let waitingURL = chrome.runtime.getURL("waiting.html");
        if (curWindow.id !== 0) {
            chrome.tabs.update(curWindow.id, { url: waitingURL }).catch(async () => {
                let tab = await chrome.tabs.create({ active: true, url: waitingURL });
                curWindow.id = tab.id;
                saveState();
            });
        } else {
            let tab = await chrome.tabs.create({ active: true, url: waitingURL });
            curWindow.id = tab.id;
            saveState();
        }
    }
}

function meshPrioStreams() {
    config.priorityStreams = priorityStreams;
}

function displayBadgeDrops() {
    if (settings.setShowBadges) {
        chrome.action.getBadgeText({}).then((curBadge) => {
            if (curBadge !== "New") {
                let newText = currentBadgeDrops.length !== 0 ? `${currentBadgeDrops.length} B` : "PRO";
                chrome.action.setBadgeText({ text: newText });
                chrome.action.setBadgeBackgroundColor({ color: "#9146FF" });
            }
        }).catch(() => {});
    }
}

function getPremiumStatus() {
    premiumStatus = { email: "pro@unlocked.local", premium: true };
    chrome.runtime.sendMessage({ type: "p:premiumStatus", data: premiumStatus }).catch(() => {});
}