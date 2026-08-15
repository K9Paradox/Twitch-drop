// Auto Twitch Drops Pro - Popup UI Controller
const maniData = chrome.runtime.getManifest();
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
let extEnabled = true;
let gameSelectOpen = false;
let currentAllGames = [];
let currentActiveStream = null;
let currentAutoGamesData = null;
let tabAudioMuted = true;

$(() => {
    // Set Manifest Version
    $("#extVersion").text(`v${maniData.version}`);

    // Load initial state
    chrome.storage.local.get(["exEnabled", "settings", "extStats", "activityHistory"]).then((val) => {
        extEnabled = val.exEnabled !== undefined ? val.exEnabled : true;
        $(".enableEx").prop("checked", extEnabled);

        if (!extEnabled) {
            showPage("extDisabled");
        } else {
            showPage("mainPage");
        }

        if (val.settings) {
            settings = { ...settings, ...val.settings };
            for (let k in settings) {
                $(`#set${k}`).prop("checked", settings[k]);
            }
        }

        if (val.extStats) {
            updateStatsUI(val.extStats);
        }

        if (val.activityHistory) {
            renderActivityHistory(val.activityHistory);
        }

        // Pre-populate default popular games (Alphabetical)
        populateGameDropdown([
            { game: { displayName: "Overwatch 2" } },
            { game: { displayName: "Apex Legends" } },
            { game: { displayName: "Counter-Strike 2" } },
            { game: { displayName: "Dead by Daylight" } },
            { game: { displayName: "Escape from Tarkov" } },
            { game: { displayName: "Fortnite" } },
            { game: { displayName: "Palworld" } },
            { game: { displayName: "Rust" } },
            { game: { displayName: "Valorant" } },
            { game: { displayName: "World of Warcraft" } }
        ]);

        // Request live connected games, audio state, and current status
        if (extEnabled) {
            chrome.runtime.sendMessage({ type: "p:getConnectedGames" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "getAutoDropGames" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "getExtStats" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "p:getTabAudioState" }).then((res) => {
                if (res && res.muted !== undefined) {
                    updateAudioButtonUI(res.muted);
                }
            }).catch(() => {});
            chrome.runtime.sendMessage({ type: "getActivityHistory" }).then((res) => {
                if (res && res.activityHistory) renderActivityHistory(res.activityHistory);
            }).catch(() => {});
        }
    }).catch(() => {});

    // Top Navigation Tabs
    $(".navItem").on("click", (e) => {
        const target = $(e.currentTarget);
        const pageId = target.data("page");

        if (!extEnabled && pageId !== "extDisabled") return;

        $(".navItem").removeClass("active");
        target.addClass("active");
        showPage(pageId);

        if (pageId === "autoDropsPage") {
            chrome.runtime.sendMessage({ type: "getAutoDropGames" }).catch(() => {});
        } else if (pageId === "activityPage") {
            chrome.runtime.sendMessage({ type: "getExtStats" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "getActivityHistory" }).then((res) => {
                if (res && res.activityHistory) renderActivityHistory(res.activityHistory);
            }).catch(() => {});
        } else if (pageId === "dropsPage") {
            chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            renderActiveDropsList(currentActiveStream);
        }
    });

    // Stream Quick Control Toolbar Buttons
    $("#skipStreamerBtn").on("click", () => {
        const btn = $("#skipStreamerBtn");
        btn.find("span").text("Skipping...");
        btn.attr("disabled", true);
        chrome.runtime.sendMessage({ type: "p:skipStreamer" }).catch(() => {});
        showToast("Switching to next live channel");

        setTimeout(() => {
            btn.find("span").text("Next");
            btn.removeAttr("disabled");
            chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
        }, 3000);
    });

    $("#toggleAudioBtn").on("click", () => {
        chrome.runtime.sendMessage({ type: "p:toggleTabAudio" }).then((res) => {
            if (res && res.success) {
                updateAudioButtonUI(res.muted);
                showToast(res.muted ? "Muted stream tab audio" : "Unmuted stream tab audio");
            }
        }).catch(() => {});
    });

    $("#reloadStreamBtn").on("click", () => {
        chrome.runtime.sendMessage({ type: "p:reloadStream" }).catch(() => {});
        showToast("Stream tab reloaded");
    });

    $("#focusStreamTabBtn").on("click", () => {
        chrome.runtime.sendMessage({ type: "p:focusStreamTab" }).catch(() => {});
    });

    // Open Twitch Drops Inventory Button
    $("#openTwitchInventoryBtn").on("click", () => {
        chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory", active: true });
    });

    // Refresh Rewards Button on Active Drops Tab
    $("#refreshRewardsBtn").on("click", () => {
        chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
        updateLastCheckTime();
        showToast("Synced rewards with Twitch");
    });

    // Clear Activity History Button
    $("#clearHistoryBtn").on("click", () => {
        chrome.runtime.sendMessage({ type: "clearActivityHistory" }).then(() => {
            renderActivityHistory([]);
            showToast("Claim history cleared");
        }).catch(() => {});
    });

    // Auto Games Search Filter
    $("#autoGameSearchInput").on("input", (e) => {
        const query = $(e.target).val().toLowerCase().trim();
        filterAutoGamesGrid(query);
    });

    // Auto Games Select All Button
    $("#autoGameSelectAllBtn").on("click", () => {
        if (!currentAutoGamesData || !currentAutoGamesData.allConnected) return;
        const allGames = currentAutoGamesData.allConnected;
        allGames.forEach(g => {
            chrome.runtime.sendMessage({ type: "toggleAutoDropGame", data: [g, true] }).catch(() => {});
        });
        $(".autoGameToggle").prop("checked", true);
        $(".autoGameCard").addClass("activeQueueCard").find(".autoGameStatusTag").text("Queued for Farming");
        updateAutoGamesBadge(allGames.length, allGames.length);
        showToast("All games enabled for Auto Farming");
    });

    // Auto Games Deselect All Button
    $("#autoGameDeselectAllBtn").on("click", () => {
        if (!currentAutoGamesData || !currentAutoGamesData.allConnected) return;
        const allGames = currentAutoGamesData.allConnected;
        allGames.forEach(g => {
            chrome.runtime.sendMessage({ type: "toggleAutoDropGame", data: [g, false] }).catch(() => {});
        });
        $(".autoGameToggle").prop("checked", false);
        $(".autoGameCard").removeClass("activeQueueCard").find(".autoGameStatusTag").text("Inactive");
        updateAutoGamesBadge(0, allGames.length);
        showToast("Auto Farming queue cleared");
    });

    // Master Switch Toggle
    $(".enableEx").on("change", (e) => {
        extEnabled = $(e.target).prop("checked");
        chrome.storage.local.set({ exEnabled: extEnabled });
        chrome.runtime.sendMessage({ type: "toggleExt", data: extEnabled }).catch(() => {});

        if (extEnabled) {
            showPage("mainPage");
            $(".navItem").removeClass("active");
            $('[data-page="mainPage"]').addClass("active");
            chrome.runtime.sendMessage({ type: "p:getConnectedGames" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            showToast("Auto Twitch Drops Enabled");
        } else {
            $(".navItem").removeClass("active");
            showPage("extDisabled");
            showToast("Auto Twitch Drops Disabled");
        }
    });

    // Settings Toggle Handler
    $(".settingsBool").on("change", (e) => {
        const settingName = e.target.id.replace("set", "");
        settings[settingName] = e.target.checked;
        chrome.storage.local.set({ settings });
        chrome.runtime.sendMessage({ type: "p:settingsChanged", data: { settings } }).catch(() => {});

        if (settingName === "showAllGames") {
            chrome.runtime.sendMessage({ type: "p:getConnectedGames" }).catch(() => {});
        }
        showToast("Settings updated");
    });

    // Custom Select Dropdown Handler
    $("#selGame").on("click", () => {
        if (!extEnabled) return;
        gameSelectOpen = !gameSelectOpen;
        if (gameSelectOpen) {
            $(".selectDropdown").removeClass("hidden");
            $("#gameSearchInput").focus();
        } else {
            $(".selectDropdown").addClass("hidden");
        }
    });

    // Game Search Bar Filtering
    $("#gameSearchInput").on("input", (e) => {
        const query = $(e.target).val().toLowerCase().trim();
        filterDropdownItems(query);
    });

    // Clear Search Input Button
    $("#clearSearchBtn").on("click", (e) => {
        e.stopPropagation();
        $("#gameSearchInput").val("").focus();
        filterDropdownItems("");
    });

    // Select Item from Dropdown
    $(document).on("click", "#gameDropdownItems li", (e) => {
        const selectedGame = $(e.target).text().trim();
        if (selectedGame === "No Connected Games Found" || selectedGame === "No matching games") return;

        $(".selectedGame").text(selectedGame);
        $(".selectDropdown").addClass("hidden");
        gameSelectOpen = false;

        $("#dropStatus").text(`Farming: ${selectedGame}`);
        $("#dropGame").text(`Finding live drop stream for ${selectedGame}...`);
        $("#headerStatusPill").html(`<span class="statusDot activeDot"></span><span>${selectedGame}</span>`).addClass("activePill");

        chrome.runtime.sendMessage({ type: "p:startCampaign", data: { campaign: selectedGame } }).then(() => {
            setTimeout(() => {
                chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            }, 1000);
        }).catch(() => {});

        updateLastCheckTime();
        showToast(`Target Game: ${selectedGame}`);
    });

    // Close dropdown on outside click
    $(document).on("click", (e) => {
        if (!$(e.target).closest(".customSelectWrapper").length) {
            $(".selectDropdown").addClass("hidden");
            gameSelectOpen = false;
        }
    });

    // Manual Claim Button Click
    $("#manualClaimBtn").on("click", () => {
        if (!extEnabled) return;
        const btn = $("#manualClaimBtn");
        btn.find("span").text("Checking Claims...");
        btn.attr("disabled", true);
        chrome.runtime.sendMessage({ type: "claim-drop" }).catch(() => {});
        updateLastCheckTime();
        showToast("Checking and claiming eligible drops");

        setTimeout(() => {
            btn.find("span").text("Claim Drops");
            btn.removeAttr("disabled");
        }, 2500);
    });

    // Background Message Listener
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return;

        if (message.type === "p:connectedGames") {
            populateGameDropdown(message.data);
        } else if (message.type === "p:sendCurrentDrops") {
            currentActiveStream = message.data ? message.data.activeStream : null;
            updateDropProgressUI(message.data);
            renderActiveDropsList(currentActiveStream);
            updateLastCheckTime();
            chrome.runtime.sendMessage({ type: "p:getTabAudioState" }).then((res) => {
                if (res && res.muted !== undefined) updateAudioButtonUI(res.muted);
            }).catch(() => {});
        } else if (message.type === "setAutoDropGames") {
            currentAutoGamesData = message.data;
            populateAutoGamesGrid(message.data);
        } else if (message.type === "p:statsUpdated") {
            updateStatsUI(message.data);
            updateLastCheckTime();
        } else if (message.type === "p:activityUpdated") {
            renderActivityHistory(message.data);
        } else if (message.type === "p:rewardClaimedSound") {
            if (settings.soundOnClaim) playClaimChime();
        }
    });
});

function updateAudioButtonUI(isMuted) {
    tabAudioMuted = isMuted;
    const btn = $("#toggleAudioBtn");
    const textSpan = $("#audioBtnText");

    if (isMuted) {
        textSpan.text("Unmute");
        btn.attr("title", "Unmute stream tab audio to listen");
        btn.find(".audioGlyph").html('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>');
    } else {
        textSpan.text("Mute");
        btn.attr("title", "Mute stream tab audio for silence");
        btn.find(".audioGlyph").html('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>');
    }
}

function playClaimChime() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
        osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15); // A5

        gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);

        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        osc.start();
        osc.stop(audioCtx.currentTime + 0.35);
    } catch (e) {}
}

function showToast(text) {
    let toast = $("#toastNotification");
    if (toast.length === 0) {
        toast = $('<div id="toastNotification" class="toastNotice"></div>');
        $("#appContainer").append(toast);
    }
    toast.text(text).addClass("show");
    setTimeout(() => {
        toast.removeClass("show");
    }, 2500);
}

function showPage(pageId) {
    $(".page").hide();
    $(`#${pageId}`).show();
}

function updateLastCheckTime() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("#lastCheckTime").text(`Last check: ${timeStr}`);
}

function updateStatsUI(stats) {
    if (!stats) return;
    if (stats.claimedDrops !== undefined) {
        $("#totalClaimedDrops").text(stats.claimedDrops.toLocaleString());
    }
    if (stats.claimedPoints !== undefined) {
        $("#totalClaimedPoints").text(stats.claimedPoints.toLocaleString());
    }
}

function renderActivityHistory(history) {
    const list = $("#activityHistoryList");
    list.empty();

    if (!history || history.length === 0) {
        list.html(`<p class="subText">No claims recorded yet. As rewards and points are claimed, they will appear here in real time.</p>`);
        return;
    }

    history.forEach(item => {
        const timeAgo = formatTimeAgo(new Date(item.timestamp));
        const thumb = item.imgUrl || "assets/img/atd-48.png";

        const card = $(`
            <div class="activityItem">
                <img src="${thumb}" class="activityThumb" alt="${item.title}" onerror="this.onerror=null; this.src='assets/img/atd-48.png';">
                <div class="activityMeta">
                    <span class="activityTitle" title="${item.title}">${item.title}</span>
                    <span class="activitySub">${item.game} &bull; <span class="activityTime">${timeAgo}</span></span>
                </div>
            </div>
        `);
        list.append(card);
    });
}

function formatTimeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function populateGameDropdown(data) {
    const list = $("#gameDropdownItems");
    list.empty();

    if (data === "noclient" || !data || data.length === 0) {
        list.append(`<li>No Connected Games Found</li>`);
        return;
    }

    const uniqueGames = new Set();
    data.forEach(camp => {
        if (camp && camp.game && camp.game.displayName) {
            uniqueGames.add(camp.game.displayName);
        } else if (typeof camp === "string") {
            uniqueGames.add(camp);
        }
    });

    // Sort Alphabetically (A-Z)
    currentAllGames = Array.from(uniqueGames).sort((a, b) => a.localeCompare(b));

    filterDropdownItems("");
}

function filterDropdownItems(query) {
    const list = $("#gameDropdownItems");
    list.empty();

    const filtered = currentAllGames.filter(game => game.toLowerCase().includes(query));

    if (filtered.length === 0) {
        list.append(`<li style="color: #adadb8; cursor: default;">No matching games</li>`);
        return;
    }

    filtered.forEach(gameName => {
        list.append(`<li>${gameName}</li>`);
    });
}

function updateDropProgressUI(data) {
    if (!data || !data.activeStream) return;
    const active = data.activeStream;

    if (active.campaign === "none" || !active.campaign) {
        $("#dropStatus").text("Status: Ready & Monitoring");
        $("#dropGame").text("Game: Select a campaign or turn on Auto Games");
        $("#headerStatusPill").html('<span class="statusDot idleDot"></span><span>Idle</span>').removeClass("activePill");
        $(".progressBarInner").css({ "width": "0%", "background": "var(--twitch-purple)" });
        $(".progressPercentText").text("0%");
        $("#activeDropDetails").empty();
        $("#streamToolbar").hide();
        return;
    }

    const camp = active.campaign;
    const gameName = camp.game ? (camp.game.name || camp.game.displayName) : "Twitch Drop";

    let currentRewardItem = null;
    let allItems = [];
    let allClaimed = true;

    if (data.activeStream.campaigns && data.activeStream.campaigns.length > 0) {
        const curCamp = data.activeStream.campaigns[camp.onCamp || 0];
        if (curCamp) {
            const items = curCamp.items || curCamp.drops || curCamp.timeBasedDrops || [];
            if (items.length > 0) {
                allItems = [...items].sort((a, b) => {
                    const reqA = a.reqTime || a.requiredMinutesWatched || 0;
                    const reqB = b.reqTime || b.requiredMinutesWatched || 0;
                    return reqA - reqB;
                });

                allItems.forEach(i => {
                    const req = i.reqTime || i.requiredMinutesWatched || 60;
                    const itemWatched = (i.self && i.self.currentMinutesWatched !== undefined) ? i.self.currentMinutesWatched : (curCamp.minutesWatched || 0);
                    const isClaimed = Boolean((i.self && i.self.isClaimed === true) || (itemWatched >= req && req > 0));
                    i._computedClaimed = isClaimed;
                    i._computedWatched = itemWatched;
                    i._computedReq = req;

                    if (!isClaimed) {
                        allClaimed = false;
                    }
                });

                // Pick the first unclaimed / in-progress reward
                currentRewardItem = allItems.find(i => !i._computedClaimed) || allItems[allItems.length - 1];
            } else {
                if ((curCamp.minutesWatched || 0) < (curCamp.minutesNeeded || 1)) allClaimed = false;
            }
        }
    } else {
        allClaimed = false;
    }

    let detailsBox = $("#activeDropDetails");
    if (detailsBox.length === 0) {
        detailsBox = $('<div id="activeDropDetails" class="activeDropMetaRow"></div>');
        $(".dropProgressContainer").prepend(detailsBox);
    }

    // ALL DROPS FOR GAME COMPLETED
    if (allItems.length > 0 && allClaimed) {
        $("#dropStatus").text(`All running drops for ${gameName} are completed`);
        $("#dropGame").html(`Game: <strong style="color:var(--emerald-green);">${gameName}</strong> &bull; All Rewards Claimed`);
        $("#headerStatusPill").html('<span class="statusDot activeDot"></span><span>Completed</span>').addClass("activePill");
        $(".progressBarInner").css({ "width": "100%", "background": "linear-gradient(90deg, #00f59b 0%, #00d684 100%)" });
        $(".progressPercentText").text("100% (All Rewards Claimed)");
        $("#streamToolbar").hide();

        const iconsHtml = allItems.map(item => {
            const img = item.picture || item.imageAssetURL || item.imageURL || "assets/img/atd-48.png";
            const title = item.name || item.title || "Reward";
            const reqMins = item.reqTime || item.requiredMinutesWatched || 60;
            return `
                <div class="completedRewardIconCard" title="${title} (${reqMins} min requirement)">
                    <img src="${img}" class="completedThumb" onerror="this.onerror=null; this.src='assets/img/atd-48.png';">
                    <svg class="completedBadgeCheck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <span class="completedRewardLabel">${title}</span>
                </div>
            `;
        }).join("");

        detailsBox.html(`
            <div class="allCompletedCardBox">
                <div class="completedHeader">
                    <span class="completedTitle">All Running Drops for ${gameName} Completed</span>
                    <span class="completedSub">All ${allItems.length > 0 ? allItems.length : ""} rewards claimed & in your inventory</span>
                </div>
                ${allItems.length > 0 ? `<div class="completedGridRow">${iconsHtml}</div>` : ""}
            </div>
        `);
        return;
    }

    // Normal In-Progress Mode:
    if (camp.curWatching) {
        $("#dropGame").html(`Watching: <a href="https://www.twitch.tv/${camp.curWatching}" target="_blank" class="streamerLink">@${camp.curWatching} ↗</a>`);
        $("#headerStatusPill").html(`<span class="statusDot activeDot"></span><span>@${camp.curWatching}</span>`).addClass("activePill");
        $("#streamToolbar").show();
    } else {
        $("#dropGame").text(`Finding live stream for ${gameName}...`);
        $("#headerStatusPill").html(`<span class="statusDot activeDot"></span><span>${gameName}</span>`).addClass("activePill");
        $("#streamToolbar").hide();
    }
    $("#dropStatus").text(`Farming: ${gameName}`);

    const itemWatched = currentRewardItem ? (currentRewardItem._computedWatched || 0) : 0;
    const targetMins = currentRewardItem ? (currentRewardItem._computedReq || 60) : 60;

    const minsLeft = Math.max(0, targetMins - itemWatched);
    const etaText = minsLeft > 0 ? `~${minsLeft}m remaining` : "Ready to claim";
    const percent = Math.min(100, Math.round((itemWatched / Math.max(1, targetMins)) * 100));
    $(".progressBarInner").css({ "width": `${percent}%`, "background": "linear-gradient(90deg, var(--twitch-purple) 0%, var(--twitch-purple-light) 100%)" });
    $(".progressPercentText").text(`${percent}% (${itemWatched}/${targetMins} min)`);

    const rewardName = currentRewardItem ? (currentRewardItem.name || currentRewardItem.title || "Reward") : `${gameName} Drop Reward`;
    let rewardImg = "assets/img/atd-48.png";
    if (currentRewardItem) {
        rewardImg = currentRewardItem.picture || currentRewardItem.imageAssetURL || currentRewardItem.imageURL || rewardImg;
    }

    detailsBox.html(`
        <div class="activeRewardItem">
            <img src="${rewardImg}" class="activeRewardThumb" alt="Reward" onerror="this.onerror=null; this.src='assets/img/atd-48.png';">
            <div class="activeRewardMeta">
                <span class="activeRewardTitle" title="${rewardName}">${rewardName}</span>
                <span class="activeRewardSub">${percent}% completed &bull; ${etaText}</span>
            </div>
        </div>
    `);
}

function renderActiveDropsList(activeStream) {
    const container = $("#allDrops");
    container.empty();

    if (!activeStream || activeStream.campaign === "none" || !activeStream.campaign) {
        container.html(`<p class="subText">No active campaign selected. Choose a game on the Home tab.</p>`);
        return;
    }

    const camp = activeStream.campaign;
    const campaigns = activeStream.campaigns || [];
    const allRewardsList = [];

    campaigns.forEach((campaignObj) => {
        const dropList = campaignObj.items || campaignObj.drops || campaignObj.timeBasedDrops || [];

        dropList.forEach((drop, index) => {
            const title = drop.name || drop.title || `Reward #${index + 1}`;
            const minsNeeded = drop.reqTime || drop.minutesNeeded || drop.requiredMinutesWatched || campaignObj.minutesNeeded || 60;
            const itemMinsWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                ? drop.self.currentMinutesWatched
                : (campaignObj.minutesWatched || 0);

            // Strict claim verification:
            const isClaimed = Boolean((drop.self && drop.self.isClaimed === true) || (itemMinsWatched >= minsNeeded && minsNeeded > 0));

            let imgUrl = "assets/img/atd-48.png";
            if (drop.picture) {
                imgUrl = drop.picture;
            } else if (drop.imageAssetURL) {
                imgUrl = drop.imageAssetURL;
            } else if (drop.imageURL) {
                imgUrl = drop.imageURL;
            } else if (drop.benefitEdges && drop.benefitEdges[0]) {
                const benefit = drop.benefitEdges[0].benefit || drop.benefitEdges[0].node;
                if (benefit && benefit.imageAssetURL) {
                    imgUrl = benefit.imageAssetURL;
                }
            }

            allRewardsList.push({
                title,
                minsNeeded,
                minsWatched: itemMinsWatched,
                isClaimed,
                imgUrl
            });
        });
    });

    if (allRewardsList.length === 0) {
        const gameName = camp.game ? (camp.game.name || camp.game.displayName) : "selected game";
        container.html(`<p class="subText">Active campaign selected (${gameName}). Twitch GQL is fetching reward details, items will display momentarily.</p>`);
        return;
    }

    // Sort: In-Progress & Unclaimed FIRST (by requirement ascending), Claimed LAST
    allRewardsList.sort((a, b) => {
        if (a.isClaimed !== b.isClaimed) {
            return a.isClaimed ? 1 : -1;
        }
        return a.minsNeeded - b.minsNeeded;
    });

    allRewardsList.forEach((reward) => {
        const statusClass = reward.isClaimed ? "claimedBadge" : "pendingBadge";
        let statusText = reward.isClaimed ? "Claimed" : "In Progress";

        if (!reward.isClaimed) {
            const pct = Math.min(100, Math.round((reward.minsWatched / Math.max(1, reward.minsNeeded)) * 100));
            statusText = `${pct}% (${reward.minsWatched}/${reward.minsNeeded}m)`;
        }

        const card = $(`
            <div class="dropRewardCard ${reward.isClaimed ? "isClaimedCard" : ""}">
                <img src="${reward.imgUrl}" class="rewardImage" alt="Reward" onerror="this.onerror=null; this.src='assets/img/atd-48.png';">
                <div class="rewardInfo">
                    <span class="rewardName" title="${reward.title}">${reward.title}</span>
                    <span class="rewardTime">Requirement: ${reward.minsNeeded} minutes</span>
                </div>
                <span class="rewardBadge ${statusClass}">${statusText}</span>
            </div>
        `);

        container.append(card);
    });
}

function updateAutoGamesBadge(enabledCount, totalCount) {
    $("#autoGameCountBadge").text(`${enabledCount} / ${totalCount} Active Queue`);
}

function populateAutoGamesGrid(data) {
    const grid = $("#autoGamesList");
    grid.empty();

    if (!data || !data.allConnected || data.allConnected.length === 0) {
        grid.html(`<p class="subText">No connected drop campaigns found in your Twitch account.</p>`);
        updateAutoGamesBadge(0, 0);
        return;
    }

    const enabledSet = new Set(data.enabled || []);
    const sortedGames = [...data.allConnected].sort((a, b) => a.localeCompare(b));

    updateAutoGamesBadge(enabledSet.size, sortedGames.length);

    sortedGames.forEach((gameName) => {
        const isChecked = enabledSet.has(gameName);

        const card = $(`
            <div class="autoGameCard ${isChecked ? "activeQueueCard" : ""}" data-gamename="${gameName.toLowerCase()}">
                <div class="autoGameMeta">
                    <svg class="autoGameGlyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="6"></rect><line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="11" x2="15.01" y2="11"></line><line x1="18" y1="13" x2="18.01" y2="13"></line></svg>
                    <div class="autoGameTitleGroup">
                        <span class="autoGameName">${gameName}</span>
                        <span class="autoGameStatusTag">${isChecked ? "Queued for Farming" : "Inactive"}</span>
                    </div>
                </div>
                <label class="switch">
                    <input type="checkbox" class="autoGameToggle" data-game="${gameName}" ${isChecked ? "checked" : ""}>
                    <span class="slider"></span>
                </label>
            </div>
        `);
        grid.append(card);
    });

    // Re-bind toggle event
    $(".autoGameToggle").on("change", (e) => {
        const game = $(e.target).data("game");
        const checked = $(e.target).prop("checked");
        const card = $(e.target).closest(".autoGameCard");

        if (checked) {
            card.addClass("activeQueueCard").find(".autoGameStatusTag").text("Queued for Farming");
        } else {
            card.removeClass("activeQueueCard").find(".autoGameStatusTag").text("Inactive");
        }

        chrome.runtime.sendMessage({ type: "toggleAutoDropGame", data: [game, checked] }).catch(() => {});

        const newCheckedCount = $(".autoGameToggle:checked").length;
        updateAutoGamesBadge(newCheckedCount, sortedGames.length);

        showToast(checked ? `Added ${game} to Auto Queue` : `Removed ${game} from Auto Queue`);
    });
}

function filterAutoGamesGrid(query) {
    $(".autoGameCard").each((i, el) => {
        const card = $(el);
        const name = card.data("gamename") || "";
        if (name.includes(query)) {
            card.removeClass("hidden");
        } else {
            card.addClass("hidden");
        }
    });
}