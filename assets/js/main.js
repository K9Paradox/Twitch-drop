let maniData = chrome.runtime.getManifest();
// Must mirror the defaults in background.js so a fresh popup can never send a
// partial settings object that wipes everything else.
const DEFAULT_SETTINGS = {
    autoRefresh: true,
    showAllGames: true,
    autoGetToken: true,
    watchPopout: true,
    autoMute: true,
    setShowBadges: true
};
let settings = { ...DEFAULT_SETTINGS };
let extEnabled = true;
let gameSelectOpen = false;
let currentAllGames = [];
let currentActiveStream = null;
let currentAutoGamesData = null;

/** Escape untrusted API-provided strings before injecting them into HTML. */
function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * MV3 extension pages block inline event handler attributes (script-src 'self'),
 * so `onerror="..."` in generated HTML never fires. Bind the fallback instead.
 */
function bindImgFallback($container) {
    $container.find("img").each((i, img) => {
        img.addEventListener("error", () => {
            if (!img.src.endsWith("assets/img/atd-48.png")) {
                img.src = "assets/img/atd-48.png";
            }
        }, { once: true });
    });
}

$(() => {
    // Set Manifest Version
    $("#extVersion").html(`v${maniData.version}`);

    // Load initial state
    chrome.storage.local.get(["exEnabled", "settings", "extStats"]).then((val) => {
        extEnabled = val.exEnabled !== undefined ? val.exEnabled : true;
        $(".enableEx").prop("checked", extEnabled);

        if (!extEnabled) {
            showPage("extDisabled");
        } else {
            showPage("mainPage");
        }

        settings = { ...DEFAULT_SETTINGS, ...(val.settings || {}) };
        for (let k in settings) {
            $(`#set${k}`).prop("checked", settings[k]);
        }

        if (val.extStats) {
            updateStatsUI(val.extStats);
        }

        // Pre-populate default popular games (Alphabetical)
        populateGameDropdown([
            { game: { displayName: "Apex Legends" } },
            { game: { displayName: "Counter-Strike 2" } },
            { game: { displayName: "Dead by Daylight" } },
            { game: { displayName: "Escape from Tarkov" } },
            { game: { displayName: "Fortnite" } },
            { game: { displayName: "Overwatch 2" } },
            { game: { displayName: "Palworld" } },
            { game: { displayName: "Rust" } },
            { game: { displayName: "Valorant" } },
            { game: { displayName: "World of Warcraft" } }
        ]);

        // Request live connected games & current status
        if (extEnabled) {
            chrome.runtime.sendMessage({ type: "p:getConnectedGames" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "getAutoDropGames" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "getExtStats" }).catch(() => {});
        }
    }).catch(() => {});

    // Sidebar Navigation
    $(".navItem").on("click", (e) => {
        const target = $(e.currentTarget);
        const pageId = target.data("page");

        if (!extEnabled && pageId !== "extDisabled") return;

        $(".navItem").removeClass("active");
        target.addClass("active");
        showPage(pageId);

        if (pageId === "autoDropsPage") {
            chrome.runtime.sendMessage({ type: "getAutoDropGames" }).catch(() => {});
        } else if (pageId === "statsPage") {
            chrome.runtime.sendMessage({ type: "getExtStats" }).catch(() => {});
        } else if (pageId === "dropsPage") {
            chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            renderActiveDropsList(currentActiveStream);
        }
    });

    // Open Twitch Drops Inventory Button
    $("#openTwitchInventoryBtn").on("click", () => {
        chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory", active: true });
    });

    // Refresh Rewards Button on Active Drops Tab
    $("#refreshRewardsBtn").on("click", () => {
        chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
        updateLastCheckTime();
        showToast("🔄 Synced rewards with Twitch");
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
        updateAutoGamesBadge(allGames.length, allGames.length);
        showToast("✅ All games enabled for Auto Farming");
    });

    // Auto Games Deselect All Button
    $("#autoGameDeselectAllBtn").on("click", () => {
        if (!currentAutoGamesData || !currentAutoGamesData.allConnected) return;
        const allGames = currentAutoGamesData.allConnected;
        allGames.forEach(g => {
            chrome.runtime.sendMessage({ type: "toggleAutoDropGame", data: [g, false] }).catch(() => {});
        });
        $(".autoGameToggle").prop("checked", false);
        updateAutoGamesBadge(0, allGames.length);
        showToast("⏸️ Auto Farming queue cleared");
    });

    // Master Switch Toggle
    $(".enableEx").on("change", (e) => {
        extEnabled = $(e.target).prop("checked");
        chrome.storage.local.set({ exEnabled: extEnabled });
        chrome.runtime.sendMessage({ type: "toggleExt", data: extEnabled }).catch(() => {});

        if (extEnabled) {
            showPage("mainPage");
            $('[data-page="mainPage"]').addClass("active");
            chrome.runtime.sendMessage({ type: "p:getConnectedGames" }).catch(() => {});
            chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            showToast("🟢 Auto Twitch Drops Enabled");
        } else {
            $(".navItem").removeClass("active");
            showPage("extDisabled");
            showToast("⏸️ Auto Twitch Drops Disabled");
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
        showToast("⚙️ Settings updated");
    });

    // Custom Select Dropdown Handler
    $("#selGame").on("click", () => {
        if (!extEnabled) return;
        gameSelectOpen = !gameSelectOpen;
        if (gameSelectOpen) {
            // Fresh search every time the dropdown opens
            $("#gameSearchInput").val("");
            filterDropdownItems("");
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
        const $li = $(e.target).closest("li");
        // Ignore informational rows ("No Connected Games Found", etc.) — they
        // previously kicked off a campaign named after the placeholder text.
        if ($li.hasClass("emptyItem")) return;

        const selectedGame = $li.text();
        $(".selectedGame").text(selectedGame);
        $(".selectDropdown").addClass("hidden");
        gameSelectOpen = false;

        chrome.runtime.sendMessage({ type: "p:startCampaign", data: { campaign: selectedGame } }).catch(() => {});
        $("#dropStatus").text(`Starting Campaign: ${selectedGame}...`);
        updateLastCheckTime();
        showToast(`🎯 Target Game set to ${selectedGame}`);
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
        btn.text("⏳ Checking Claims...").attr("disabled", true);
        chrome.runtime.sendMessage({ type: "claim-drop" }).catch(() => {});
        updateLastCheckTime();
        showToast("✨ Checked for claimable drops");

        setTimeout(() => {
            btn.text("✨ Claim Drops Now").removeAttr("disabled");
        }, 3000);
    });

    // Stop Farming Button
    $("#stopCampaignBtn").on("click", () => {
        if (!extEnabled) return;
        const btn = $("#stopCampaignBtn");
        btn.attr("disabled", true);
        chrome.runtime.sendMessage({ type: "p:startCampaign", data: { campaign: "none" } }).catch(() => {});
        $("#dropStatus").text("Status: Stopping campaign...");
        showToast("⏹ Farming stopped");
        setTimeout(() => btn.removeAttr("disabled"), 2000);
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
        } else if (message.type === "setAutoDropGames") {
            currentAutoGamesData = message.data;
            populateAutoGamesGrid(message.data);
        } else if (message.type === "p:statsUpdated") {
            updateStatsUI(message.data);
            updateLastCheckTime();
        }
    });
});

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
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $("#lastCheckTime").text(`Last check: ${timeStr}`);
}

function updateStatsUI(stats) {
    if (!stats) return;
    if (stats.claimedDrops !== undefined) {
        $("#totalClaimedDrops").text(Number(stats.claimedDrops).toLocaleString());
    }
    if (stats.claimedPoints !== undefined) {
        $("#totalClaimedPoints").text(Number(stats.claimedPoints).toLocaleString());
    }
}

function populateGameDropdown(data) {
    const list = $("#gameDropdownItems");
    list.empty();

    if (data === "noclient" || !data || data.length === 0) {
        list.append(`<li class="emptyItem">No Connected Games Found</li>`);
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
        list.append(`<li class="emptyItem" style="color: #adadb8; cursor: default;">No matching games</li>`);
        return;
    }

    filtered.forEach(gameName => {
        // .text() keeps game names safe — no HTML/attribute injection
        const li = $("<li></li>").text(gameName);
        list.append(li);
    });
}

function updateDropProgressUI(data) {
    if (!data || !data.activeStream) return;
    const active = data.activeStream;

    if (active.campaign === "none" || !active.campaign) {
        $("#dropStatus").text("Status: Ready & Monitoring");
        $("#dropGame").text("Game: Select a campaign or turn on Auto Games");
        $("#headerStatusPill").text("⚪ Idle").removeClass("activePill");
        $(".progressBarInner").css({ "width": "0%", "background": "var(--twitch-purple)" });
        $(".progressPercentText").text("0%");
        $("#activeDropDetails").empty();
        $("#stopCampaignBtn").hide();
        return;
    }

    $("#stopCampaignBtn").show();

    const camp = active.campaign;
    const gameName = camp.game ? (camp.game.name || camp.game.displayName) : 'Twitch Drop';

    let minutesWatched = 0;
    let targetMins = 60;
    let currentRewardItem = null;
    let allItems = [];
    let allClaimed = true;

    if (data.activeStream.campaigns && data.activeStream.campaigns.length > 0) {
        const curCamp = data.activeStream.campaigns[camp.onCamp || 0];
        if (curCamp) {
            minutesWatched = curCamp.minutesWatched || 0;
            const items = curCamp.items || curCamp.drops || curCamp.timeBasedDrops || [];
            if (items.length > 0) {
                allItems = [...items].sort((a, b) => {
                    const reqA = a.reqTime || a.requiredMinutesWatched || 0;
                    const reqB = b.reqTime || b.requiredMinutesWatched || 0;
                    return reqA - reqB;
                });

                allItems.forEach(i => {
                    const req = i.reqTime || i.requiredMinutesWatched || 60;
                    const itemWatched = (i.self && i.self.currentMinutesWatched !== undefined) ? i.self.currentMinutesWatched : minutesWatched;
                    const isClaimed = Boolean((i.self && i.self.isClaimed === true) || (itemWatched >= req && req > 0) || (curCamp.minutesWatched >= curCamp.minutesNeeded && curCamp.minutesNeeded > 0));
                    i._computedClaimed = isClaimed;
                    if (!isClaimed) allClaimed = false;
                });

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

    // ALL DROPS FOR GAME X ARE COMPLETED
    if (allClaimed || camp.isCompleted) {
        $("#dropStatus").text(`🎉 All running drops for ${gameName} are completed!`);
        $("#dropGame").html(`Game: <strong style="color:#00f59b;">${escapeHtml(gameName)}</strong> &bull; All Rewards Claimed!`);
        $("#headerStatusPill").html(`🎉 ${escapeHtml(gameName)} Complete`).addClass("activePill");
        $(".progressBarInner").css({ "width": "100%", "background": "linear-gradient(90deg, #00f59b 0%, #00d684 100%)" });
        $(".progressPercentText").text(`100% (All Rewards Claimed! ✅)`);

        let iconsHtml = allItems.map(item => {
            let img = item.picture || item.imageAssetURL || item.imageURL || "assets/img/atd-48.png";
            let title = item.name || item.title || "Reward";
            let reqMins = item.reqTime || item.requiredMinutesWatched || 60;
            return `
                <div class="completedRewardIconCard" title="${escapeHtml(title)} (${reqMins} min requirement)">
                    <img src="${escapeHtml(img)}" class="completedThumb">
                    <span class="completedBadgeCheck">✅</span>
                    <span class="completedRewardLabel">${escapeHtml(title)}</span>
                </div>
            `;
        }).join("");

        detailsBox.html(`
            <div class="allCompletedCardBox">
                <div class="completedHeader">
                    <span class="completedTitle">✨ All Running Drops for ${escapeHtml(gameName)} Completed</span>
                    <span class="completedSub">All ${allItems.length > 0 ? allItems.length : ''} rewards claimed & in your inventory</span>
                </div>
                ${allItems.length > 0 ? `<div class="completedGridRow">${iconsHtml}</div>` : ''}
            </div>
        `);
        bindImgFallback(detailsBox);
        return;
    }

    // Normal In-Progress Mode:
    if (camp.curWatching) {
        $("#dropGame").html(`Watching Streamer: <a href="https://www.twitch.tv/${encodeURIComponent(camp.curWatching)}" target="_blank" class="streamerLink">@${escapeHtml(camp.curWatching)} ↗</a>`);
        $("#headerStatusPill").html(`🟢 @${escapeHtml(camp.curWatching)}`).addClass("activePill");
    } else if (camp.status === "nostream") {
        $("#dropGame").text(`Waiting for a live stream with drops enabled...`);
        $("#headerStatusPill").text(`⏸ Waiting for ${gameName}`).removeClass("activePill");
    } else {
        $("#dropGame").text(`Finding active stream...`);
        $("#headerStatusPill").text(`🟢 Farming ${escapeHtml(gameName)}`).addClass("activePill");
    }
    $("#dropStatus").text(`Farming: ${gameName}`);

    if (currentRewardItem) {
        targetMins = currentRewardItem.reqTime || currentRewardItem.requiredMinutesWatched || 60;
    }

    const minsLeft = Math.max(0, targetMins - minutesWatched);
    const etaText = minsLeft > 0 ? `~${minsLeft}m remaining` : "Ready to claim!";
    const percent = Math.min(100, Math.round((minutesWatched / Math.max(1, targetMins)) * 100));
    $(".progressBarInner").css({ "width": `${percent}%`, "background": "linear-gradient(90deg, var(--twitch-purple) 0%, #a970ff 100%)" });
    $(".progressPercentText").text(`${percent}% (${minutesWatched}/${targetMins} min)`);

    let rewardName = currentRewardItem ? (currentRewardItem.name || currentRewardItem.title || "Reward") : `${gameName} Drop Reward`;
    let rewardImg = "assets/img/atd-48.png";
    if (currentRewardItem) {
        rewardImg = currentRewardItem.picture || currentRewardItem.imageAssetURL || currentRewardItem.imageURL || rewardImg;
    }

    detailsBox.html(`
        <div class="activeRewardItem">
            <img src="${escapeHtml(rewardImg)}" class="activeRewardThumb" alt="Reward">
            <div class="activeRewardMeta">
                <span class="activeRewardTitle" title="${escapeHtml(rewardName)}">${escapeHtml(rewardName)}</span>
                <span class="activeRewardSub">${percent}% completed &bull; ⏳ ${escapeHtml(etaText)}</span>
            </div>
        </div>
    `);
    bindImgFallback(detailsBox);
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

    let allRewardsList = [];

    campaigns.forEach((campaignObj) => {
        const dropList = campaignObj.items || campaignObj.drops || campaignObj.timeBasedDrops || [];

        dropList.forEach((drop, index) => {
            const title = drop.name || drop.title || `Reward #${index + 1}`;
            const minsNeeded = drop.reqTime || drop.minutesNeeded || drop.requiredMinutesWatched || campaignObj.minutesNeeded || 60;
            const itemMinsWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                ? drop.self.currentMinutesWatched
                : (campaignObj.minutesWatched || 0);

            const isClaimed = Boolean(
                camp.isCompleted === true ||
                (drop.self && drop.self.isClaimed === true) ||
                (itemMinsWatched >= minsNeeded && minsNeeded > 0) ||
                (campaignObj.minutesWatched >= minsNeeded && minsNeeded > 0)
            );

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
        const gameName = camp.game ? (camp.game.name || camp.game.displayName) : 'selected game';
        container.html(`<p class="subText">Active campaign selected (${escapeHtml(gameName)}). Twitch GQL is fetching reward details, items will display momentarily.</p>`);
        return;
    }

    // Sort: In-Progress & Unclaimed FIRST (by reqTime ascending), Claimed LAST
    allRewardsList.sort((a, b) => {
        if (a.isClaimed !== b.isClaimed) {
            return a.isClaimed ? 1 : -1;
        }
        return a.minsNeeded - b.minsNeeded;
    });

    allRewardsList.forEach((reward) => {
        let statusClass = reward.isClaimed ? 'claimedBadge' : 'pendingBadge';
        let statusText;
        if (reward.isClaimed) {
            statusText = 'Claimed ✅';
        } else if (reward.minsWatched > 0) {
            statusText = `${reward.minsWatched}/${reward.minsNeeded} min`;
        } else {
            statusText = `0/${reward.minsNeeded} min`;
        }

        const card = $(`
            <div class="dropRewardCard ${reward.isClaimed ? 'isClaimedCard' : ''}">
                <img src="${escapeHtml(reward.imgUrl)}" class="rewardImage" alt="Reward">
                <div class="rewardInfo">
                    <span class="rewardName" title="${escapeHtml(reward.title)}">${escapeHtml(reward.title)}</span>
                    <span class="rewardTime">Watch requirement: ${reward.minsNeeded} minutes</span>
                </div>
                <span class="rewardBadge ${statusClass}">${statusText}</span>
            </div>
        `);

        container.append(card);
    });
    bindImgFallback(container);
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

    sortedGames.forEach((gameName, idx) => {
        const isChecked = enabledSet.has(gameName);

        const card = $(`
            <div class="autoGameCard ${isChecked ? 'activeQueueCard' : ''}" data-gamename="${escapeHtml(gameName.toLowerCase())}">
                <div class="autoGameMeta">
                    <span class="autoGameIcon">🎮</span>
                    <div class="autoGameTitleGroup">
                        <span class="autoGameName">${escapeHtml(gameName)}</span>
                        <span class="autoGameStatusTag">${isChecked ? '⚡ Queued for Farming' : '⏸️ Inactive'}</span>
                    </div>
                </div>
                <label class="switch">
                    <input type="checkbox" class="autoGameToggle" data-game="${escapeHtml(gameName)}" ${isChecked ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        `);
        grid.append(card);
    });

    // Bind toggle events (fresh nodes each render, so no duplicate handlers)
    grid.find(".autoGameToggle").on("change", (e) => {
        const game = $(e.target).data("game");
        const checked = $(e.target).prop("checked");
        const card = $(e.target).closest(".autoGameCard");

        if (checked) {
            card.addClass("activeQueueCard").find(".autoGameStatusTag").text("⚡ Queued for Farming");
        } else {
            card.removeClass("activeQueueCard").find(".autoGameStatusTag").text("⏸️ Inactive");
        }

        chrome.runtime.sendMessage({ type: "toggleAutoDropGame", data: [game, checked] }).catch(() => {});

        // Update badge count
        const newCheckedCount = $(".autoGameToggle:checked").length;
        updateAutoGamesBadge(newCheckedCount, sortedGames.length);

        showToast(checked ? `+ Added ${game} to Auto Queue` : `- Removed ${game} from Auto Queue`);
    });
}

function filterAutoGamesGrid(query) {
    $(".autoGameCard").each((i, el) => {
        const card = $(el);
        const name = String(card.data("gamename") || "");
        if (name.includes(query)) {
            card.removeClass("hidden");
        } else {
            card.addClass("hidden");
        }
    });
}
