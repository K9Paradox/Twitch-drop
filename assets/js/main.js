// Auto Twitch Drops Pro - Popup UI Controller (Manifest V3)
const maniData = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest()
    : { version: "1.5.0" };

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
let currentAllGames = [...POPULAR_DROP_GAMES];
let activeDropGamesSet = new Set();
let currentActiveStream = null;
let currentClaimedInventory = [];
let currentAutoGamesData = { allConnected: [], enabled: [] };
let tabAudioMuted = true;
let authBannerDismissed = false;

const GIFT_SVG_ICON = `
<svg class="rewardFallbackGlyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="20 12 20 22 4 22 4 12"></polyline>
    <rect x="2" y="7" width="20" height="5"></rect>
    <line x1="12" y1="22" x2="12" y2="7"></line>
    <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path>
    <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path>
</svg>`;

function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Document-level error listener in capture phase handles failed images without inline onerror (MV3 CSP compliant)
document.addEventListener("error", (e) => {
    if (e.target && e.target.tagName === "IMG") {
        if (e.target.classList.contains("appLogo")) {
            e.target.src = "assets/img/icon.svg";
        } else if (e.target.classList.contains("img-with-fallback") || e.target.nextElementSibling?.classList.contains("rewardGlyphBox") || e.target.nextElementSibling?.classList.contains("claimedDropGlyph")) {
            e.target.style.display = "none";
            if (e.target.nextElementSibling) {
                e.target.nextElementSibling.style.display = "flex";
            }
        }
    }
}, true);

$(() => {
    // Set Manifest Version
    $("#extVersion").text(`v${maniData.version || "1.5.0"}`);

    // Pre-populate default popular games immediately to eliminate empty-state flashing
    populateGameDropdown(POPULAR_DROP_GAMES.map(g => ({ game: { displayName: g } })));
    populateAutoGamesGrid(currentAutoGamesData);

    // Initial storage hydration & check auth
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([
            "exEnabled",
            "settings",
            "extStats",
            "activityHistory",
            "autoDropGames",
            "listOfConnected",
            "activeStream",
            "oauthToken",
            "authState",
            "claimedInventory",
            "githubUpdate"
        ]).then((val) => {
            if (!val) val = {};

            extEnabled = val.exEnabled !== undefined ? Boolean(val.exEnabled) : true;
            $(".enableEx").prop("checked", extEnabled);

            if (!extEnabled) {
                showPage("extDisabled");
            } else {
                showPage("mainPage");
            }

            if (val.settings && typeof val.settings === "object") {
                settings = { ...settings, ...val.settings };
                for (let k in settings) {
                    $(`#set${k}`).prop("checked", Boolean(settings[k]));
                }
            }

            if (val.extStats) {
                updateStatsUI(val.extStats);
            }

            if (Array.isArray(val.activityHistory)) {
                renderActivityHistory(val.activityHistory);
            }

            if (Array.isArray(val.claimedInventory)) {
                currentClaimedInventory = val.claimedInventory;
                renderClaimedInventory(currentClaimedInventory);
            }

            if (Array.isArray(val.listOfConnected) && val.listOfConnected.length > 0) {
                const merged = Array.from(new Set([...val.listOfConnected, ...POPULAR_DROP_GAMES]));
                populateGameDropdown(merged.map(g => ({ game: { displayName: g } })));
            }

            if (Array.isArray(val.activeDropGames) && val.activeDropGames.length > 0) {
                currentAutoGamesData.allConnected = val.activeDropGames;
            }

            if (Array.isArray(val.autoDropGames)) {
                currentAutoGamesData.enabled = val.autoDropGames;
                populateAutoGamesGrid(currentAutoGamesData);
            }

            if (val.activeStream && val.activeStream.campaign && val.activeStream.campaign !== "none") {
                currentActiveStream = val.activeStream;
                updateDropProgressUI({ activeStream: val.activeStream });
                renderActiveDropsList(val.activeStream);
            }

            if (val.githubUpdate) {
                renderUpdateInfo(val.githubUpdate);
            }

            checkAuthStatus();

            // Request live data from background service worker
            if (extEnabled && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ type: "p:getConnectedGames" }).catch(() => {});
                chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
                chrome.runtime.sendMessage({ type: "getAutoDropGames" }).catch(() => {});
                chrome.runtime.sendMessage({ type: "getExtStats" }).catch(() => {});
                chrome.runtime.sendMessage({ type: "p:getUpdateState" }).then((res) => {
                    if (res) renderUpdateInfo(res);
                }).catch(() => {});
                chrome.runtime.sendMessage({ type: "p:getTabAudioState" }).then((res) => {
                    if (res && res.muted !== undefined) {
                        updateAudioButtonUI(res.muted);
                    }
                }).catch(() => {});
                chrome.runtime.sendMessage({ type: "getActivityHistory" }).then((res) => {
                    if (res && Array.isArray(res.activityHistory)) {
                        renderActivityHistory(res.activityHistory);
                    }
                }).catch(() => {});
            }
        }).catch(() => {});
    }

    // Real-time Reactive Storage Sync
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName && areaName !== "local") return;
            if (!changes || typeof changes !== "object") return;

            // Master enable switch
            if (changes.exEnabled !== undefined) {
                const newEnabled = changes.exEnabled.newValue !== undefined ? Boolean(changes.exEnabled.newValue) : true;
                if (extEnabled !== newEnabled) {
                    extEnabled = newEnabled;
                    $(".enableEx").prop("checked", extEnabled);
                    if (!extEnabled) {
                        showPage("extDisabled");
                        $(".navItem").removeClass("active");
                    } else {
                        showPage("mainPage");
                        $(".navItem").removeClass("active");
                        $('[data-page="mainPage"]').addClass("active");
                    }
                }
            }

            // Settings sync
            if (changes.settings && changes.settings.newValue && typeof changes.settings.newValue === "object") {
                settings = { ...settings, ...changes.settings.newValue };
                for (let k in settings) {
                    $(`#set${k}`).prop("checked", Boolean(settings[k]));
                }
            }

            // Lifetime stats
            if (changes.extStats && changes.extStats.newValue) {
                updateStatsUI(changes.extStats.newValue);
            }

            // Activity log
            if (changes.activityHistory && Array.isArray(changes.activityHistory.newValue)) {
                renderActivityHistory(changes.activityHistory.newValue);
            }

            // Connected games list
            if (changes.listOfConnected && Array.isArray(changes.listOfConnected.newValue)) {
                const merged = Array.from(new Set([...changes.listOfConnected.newValue, ...POPULAR_DROP_GAMES]));
                populateGameDropdown(merged.map(g => ({ game: { displayName: g } })));
            }

            // Auto drop games queue
            if (changes.autoDropGames && Array.isArray(changes.autoDropGames.newValue)) {
                currentAutoGamesData.enabled = changes.autoDropGames.newValue;
                populateAutoGamesGrid(currentAutoGamesData);
            }

            // Active stream / drop progress
            if (changes.activeStream) {
                const newStream = (changes.activeStream.newValue && changes.activeStream.newValue !== "none")
                    ? changes.activeStream.newValue
                    : null;
                currentActiveStream = newStream;
                updateDropProgressUI({ activeStream: newStream });
                renderActiveDropsList(currentActiveStream);
                updateLastCheckTime();
            }

            // Claimed Inventory Drops
            if (changes.claimedInventory && Array.isArray(changes.claimedInventory.newValue)) {
                currentClaimedInventory = changes.claimedInventory.newValue;
                renderClaimedInventory(currentClaimedInventory);
            }

            // Auth state / token changes
            if (changes.oauthToken || changes.authState) {
                checkAuthStatus();
            }

            // GitHub Update Sync
            if (changes.githubUpdate && changes.githubUpdate.newValue) {
                renderUpdateInfo(changes.githubUpdate.newValue);
            }
        });
    }

    // Top Navigation Tabs
    $(".navItem").on("click", (e) => {
        const target = $(e.currentTarget);
        const pageId = target.data("page");

        if (!extEnabled && pageId !== "extDisabled") return;

        $(".navItem").removeClass("active");
        target.addClass("active");
        showPage(pageId);

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            if (pageId === "autoDropsPage") {
                chrome.runtime.sendMessage({ type: "getAutoDropGames" }).then(res => {
                    if (res) populateAutoGamesGrid(res);
                }).catch(() => {});
            } else if (pageId === "activityPage") {
                chrome.runtime.sendMessage({ type: "getExtStats" }).catch(() => {});
                chrome.runtime.sendMessage({ type: "getActivityHistory" }).then((res) => {
                    if (res && Array.isArray(res.activityHistory)) renderActivityHistory(res.activityHistory);
                }).catch(() => {});
            } else if (pageId === "dropsPage") {
                chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
                renderActiveDropsList(currentActiveStream);
            }
        }
    });

    // Stream Quick Control Toolbar Buttons
    $("#skipStreamerBtn").on("click", () => {
        const btn = $("#skipStreamerBtn");
        btn.find("span").text("Skipping...");
        btn.attr("disabled", true);
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:skipStreamer" }).catch(() => {});
        }
        showToast("Switching to next live channel");

        setTimeout(() => {
            btn.find("span").text("Next");
            btn.removeAttr("disabled");
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            }
        }, 2000);
    });

    $("#toggleAudioBtn").on("click", () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:toggleTabAudio" }).then((res) => {
                if (res && res.success && res.muted !== undefined) {
                    updateAudioButtonUI(res.muted);
                    showToast(res.muted ? "Muted stream tab audio" : "Unmuted stream tab audio");
                } else {
                    tabAudioMuted = !tabAudioMuted;
                    updateAudioButtonUI(tabAudioMuted);
                    showToast(tabAudioMuted ? "Muted stream tab audio" : "Unmuted stream tab audio");
                }
            }).catch(() => {
                tabAudioMuted = !tabAudioMuted;
                updateAudioButtonUI(tabAudioMuted);
            });
        } else {
            tabAudioMuted = !tabAudioMuted;
            updateAudioButtonUI(tabAudioMuted);
        }
    });

    $("#reloadStreamBtn").on("click", () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:reloadStream" }).catch(() => {});
        }
        showToast("Stream tab reloaded");
    });

    $("#focusStreamTabBtn").on("click", () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:focusStreamTab" }).catch(() => {});
        }
    });

    // Clicking streamer name in status box focuses the farming tab and window
    $(document).on("click", "#focusFarmTab", (e) => {
        e.preventDefault();
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:focusStreamTab" }).catch(() => {});
        }
    });

    // Stop Campaign Button
    $("#stopCampaignBtn").on("click", () => {
        if (!extEnabled) return;
        const btn = $("#stopCampaignBtn");
        btn.attr("disabled", true);
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:startCampaign", data: { campaign: "none" } }).catch(() => {});
        }
        $("#dropStatus").text("Status: Stopping campaign...");
        showToast("⏹ Farming stopped");
        setTimeout(() => btn.removeAttr("disabled"), 2000);
    });

    // Open Twitch Drops Inventory Button
    $("#openTwitchInventoryBtn").on("click", () => {
        if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
            chrome.tabs.create({ url: "https://www.twitch.tv/drops/inventory", active: true });
        } else {
            window.open("https://www.twitch.tv/drops/inventory", "_blank");
        }
    });

    // Refresh Rewards Button on Active Drops Tab
    $("#refreshRewardsBtn").on("click", () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
        }
        updateLastCheckTime();
        showToast("Synced rewards with Twitch");
    });

    // Clear Activity History Button
    $("#clearHistoryBtn").on("click", () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "clearActivityHistory" }).then(() => {
                renderActivityHistory([]);
                showToast("Claim history cleared");
            }).catch(() => {
                renderActivityHistory([]);
                showToast("Claim history cleared");
            });
        } else {
            renderActivityHistory([]);
            showToast("Claim history cleared");
        }
    });

    // Auto Games Search Filter
    $("#autoGameSearchInput").on("input", (e) => {
        const query = $(e.target).val().toLowerCase().trim();
        filterAutoGamesGrid(query);
    });

    // Start Auto Queue Button
    $("#startAutoQueueBtn").on("click", () => {
        const enabledCount = Array.isArray(currentAutoGamesData.enabled) ? currentAutoGamesData.enabled.length : 0;
        if (enabledCount === 0) {
            showToast("Please enable at least 1 game in the queue first!");
            return;
        }
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:startAutoQueue" }).then(res => {
                if (res && res.success) {
                    showToast("Auto Queue started! Finding live streams...");
                    $(".navItem[data-page='streamPage']").trigger("click");
                }
            }).catch(() => {});
        }
    });

    // Auto Games Select All Button
    $("#autoGameSelectAllBtn").on("click", () => {
        const allGames = Array.isArray(currentAutoGamesData.allConnected) ? currentAutoGamesData.allConnected : [];
        if (allGames.length === 0) return;

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            allGames.forEach(g => {
                chrome.runtime.sendMessage({ type: "toggleAutoDropGame", data: [g, true] }).catch(() => {});
            });
            chrome.runtime.sendMessage({ type: "p:startAutoQueue" }).catch(() => {});
        }
        currentAutoGamesData.enabled = [...allGames];
        $(".autoGameToggle").prop("checked", true);
        $(".autoGameCard").addClass("activeQueueCard").find(".autoGameStatusTag").text("Queued for Farming");
        updateAutoGamesBadge(allGames.length, allGames.length);
        showToast("All active drop games queued for farming");
    });

    // Auto Games Deselect All Button
    $("#autoGameDeselectAllBtn").on("click", () => {
        const allGames = Array.isArray(currentAutoGamesData.allConnected) ? currentAutoGamesData.allConnected : [];

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            allGames.forEach(g => {
                chrome.runtime.sendMessage({ type: "toggleAutoDropGame", data: [g, false] }).catch(() => {});
            });
        }
        currentAutoGamesData.enabled = [];
        $(".autoGameToggle").prop("checked", false);
        $(".autoGameCard").removeClass("activeQueueCard").find(".autoGameStatusTag").text("Inactive");
        updateAutoGamesBadge(0, allGames.length);
        showToast("Auto Farming queue cleared");
    });

    // Master Switch Toggle
    $(".enableEx").on("change", (e) => {
        extEnabled = $(e.target).prop("checked");
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ exEnabled: extEnabled }).catch(() => {});
        }
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "toggleExt", data: extEnabled }).catch(() => {});
        }

        if (extEnabled) {
            showPage("mainPage");
            $(".navItem").removeClass("active");
            $('[data-page="mainPage"]').addClass("active");
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ type: "p:getConnectedGames" }).catch(() => {});
                chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            }
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
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ settings }).catch(() => {});
        }
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:settingsChanged", data: { settings } }).catch(() => {});
            if (settingName === "showAllGames") {
                chrome.runtime.sendMessage({ type: "p:getConnectedGames" }).catch(() => {});
            }
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
        const item = $(e.currentTarget);
        const selectedGame = item.attr("data-game") || item.find("span").first().text().trim() || item.text().trim();
        if (!selectedGame || selectedGame === "No Connected Games Found" || selectedGame === "No matching games") return;

        $(".selectedGame").text(selectedGame);
        $(".selectDropdown").addClass("hidden");
        gameSelectOpen = false;

        $("#dropStatus").text(`Farming: ${selectedGame}`);
        $("#dropGame").text(`Finding live drop stream for ${selectedGame}...`);
        $("#headerStatusPill").html(`<span class="statusDot activeDot"></span><span>${selectedGame}</span>`).addClass("activePill");

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "p:startCampaign", data: { campaign: selectedGame, manual: true } }).then(() => {
                setTimeout(() => {
                    chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
                }, 1000);
            }).catch(() => {});
        }

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
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "claim-drop" }).catch(() => {});
        }
        updateLastCheckTime();
        showToast("Checking and claiming eligible drops");

        setTimeout(() => {
            btn.find("span").text("Claim Drops");
            btn.removeAttr("disabled");
        }, 2500);
    });

    // Re-auth / connection banner dismiss
    $("#authDismissBtn").on("click", (e) => {
        e.stopPropagation();
        authBannerDismissed = true;
        $("#authStatusBanner").slideUp(180);
    });

    // Background Message Listener
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!message || typeof message !== "object") return;

            if (message.type === "p:connectedGames") {
                populateGameDropdown(message.data);
            } else if (message.type === "p:sendCurrentDrops") {
                currentActiveStream = (message.data && message.data.activeStream && message.data.activeStream !== "none")
                    ? message.data.activeStream
                    : null;
                updateDropProgressUI(message.data);
                renderActiveDropsList(currentActiveStream);
                if (message.data && Array.isArray(message.data.claimedInventory)) {
                    currentClaimedInventory = message.data.claimedInventory;
                    renderClaimedInventory(currentClaimedInventory);
                }
                updateLastCheckTime();
                if (chrome.runtime && chrome.runtime.sendMessage) {
                    chrome.runtime.sendMessage({ type: "p:getTabAudioState" }).then((res) => {
                        if (res && res.muted !== undefined) updateAudioButtonUI(res.muted);
                    }).catch(() => {});
                }
            } else if (message.type === "setAutoDropGames") {
                if (message.data) {
                    currentAutoGamesData = message.data;
                    populateAutoGamesGrid(message.data);
                }
            } else if (message.type === "p:statsUpdated") {
                updateStatsUI(message.data);
                updateLastCheckTime();
            } else if (message.type === "p:activityUpdated") {
                renderActivityHistory(message.data);
            } else if (message.type === "p:rewardClaimedSound") {
                if (settings.soundOnClaim) playClaimChime();
            } else if (message.type === "p:authStateChanged") {
                checkAuthStatus();
            }
        });
    }

    // GitHub Update Actions
    $("#checkUpdateBtn").on("click", async () => {
        const btn = $("#checkUpdateBtn");
        const btnText = $("#checkUpdateBtnText");
        btn.prop("disabled", true);
        btnText.text("Checking...");

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            try {
                const res = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ type: "p:checkUpdate" }, (response) => {
                        if (chrome.runtime.lastError) resolve(null);
                        else resolve(response);
                    });
                });

                if (res) {
                    renderUpdateInfo(res);
                    if (res.updateAvailable) {
                        showToast(`🚀 Update Available: v${res.latestVersion}`);
                    } else {
                        showToast(`🟢 Extension is up to date (v${res.currentVersion})`);
                    }
                } else {
                    showToast("Unable to reach GitHub");
                }
            } catch (e) {
                showToast("Update check error");
            } finally {
                btn.prop("disabled", false);
                btnText.text("Check for Updates");
            }
        } else {
            btn.prop("disabled", false);
            btnText.text("Check for Updates");
        }
    });

    function copyGitPullCommand() {
        const cmd = "git pull origin main";
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cmd).then(() => {
                showToast(`📋 Copied "${cmd}" to clipboard!`);
            }).catch(() => {
                prompt("Copy this command:", cmd);
            });
        } else {
            prompt("Copy this command:", cmd);
        }
    }

    $("#copyGitPullBtn, #copyGitPullBannerBtn").on("click", copyGitPullCommand);
    $("#dismissUpdateBannerBtn").on("click", () => {
        $("#githubUpdateBanner").slideUp(200);
    });
});

function renderUpdateInfo(update) {
    if (!update || typeof update !== "object") return;
    const currentVer = update.currentVersion || (typeof chrome !== "undefined" && chrome.runtime?.getManifest?.()?.version) || "1.5.1";
    $("#currentVerDisplay").text(`v${currentVer}`);
    $("#extVersion").text(`v${currentVer}`);

    if (update.lastChecked) {
        try {
            const d = new Date(update.lastChecked);
            $("#lastCheckedDisplay").text(d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
        } catch (e) {
            $("#lastCheckedDisplay").text("Recently");
        }
    }

    if (update.updateAvailable) {
        $("#githubUpdateBanner").slideDown(200);
        $("#updateBannerVersion").text(`v${update.latestVersion}`);
        if (update.commitMessage) {
            $("#updateBannerSubtitle").text(update.commitMessage);
        } else {
            $("#updateBannerSubtitle").text("New update available on GitHub");
        }
        if (update.releaseUrl) {
            $("#viewReleaseLink").attr("href", update.releaseUrl);
        }

        $("#updateStatusPill").removeClass("pillUpToDate").addClass("pillUpdateAvail").text(`v${update.latestVersion} Avail`);
        $("#updateStatusText").html(`<span style="color: #a970ff; font-weight: 600;">Update Available (v${update.latestVersion})</span>`);
    } else {
        $("#githubUpdateBanner").slideUp(200);
        $("#updateStatusPill").removeClass("pillUpdateAvail").addClass("pillUpToDate").text(`v${currentVer}`);
        $("#updateStatusText").text("Up to date");
    }
}

async function checkAuthStatus() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    try {
        const stored = await chrome.storage.local.get(["oauthToken", "authState"]).catch(() => ({}));
        let hasToken = Boolean(stored && stored.oauthToken);
        let authErr = (stored && stored.authState && stored.authState.error) ? stored.authState.error : null;

        if (!hasToken && chrome.cookies && chrome.cookies.get) {
            const cookie = await chrome.cookies.get({ url: "https://www.twitch.tv", name: "auth-token" }).catch(() => null);
            if (cookie && cookie.value) {
                hasToken = true;
            }
        }

        const banner = $("#authStatusBanner");
        if (authErr) {
            $("#authBannerTitle").text("Twitch Connection Error");
            $("#authBannerDesc").text(typeof authErr === "string" ? authErr : "Network or authentication issue detected while communicating with Twitch.");
            if (!authBannerDismissed) banner.slideDown(200);
        } else if (!hasToken) {
            $("#authBannerTitle").text("Twitch Authentication Required");
            $("#authBannerDesc").text("Please log in to Twitch in your browser to discover campaigns and farm drops automatically.");
            if (!authBannerDismissed) banner.slideDown(200);
        } else {
            banner.slideUp(150);
        }
    } catch (e) {
        console.warn("Error checking auth status:", e);
    }
}

function updateAudioButtonUI(isMuted) {
    tabAudioMuted = Boolean(isMuted);
    const btn = $("#toggleAudioBtn");
    const textSpan = $("#audioBtnText");

    if (tabAudioMuted) {
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
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtxClass) return;
        const audioCtx = new AudioCtxClass();
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15);

        gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);

        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        osc.start();
        osc.stop(audioCtx.currentTime + 0.35);
    } catch (e) {}
}

function showToast(text) {
    if (!text) return;
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
    if (!pageId) return;
    $(".page").hide();
    $(`#${pageId}`).show();
}

function updateLastCheckTime() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("#lastCheckTime").text(`Last check: ${timeStr}`);
}

function updateStatsUI(stats) {
    if (!stats || typeof stats !== "object") return;
    if (stats.claimedDrops !== undefined) {
        const dropsNum = Number(stats.claimedDrops) || 0;
        $("#totalClaimedDrops").text(dropsNum.toLocaleString());
    }
    if (stats.claimedPoints !== undefined) {
        const pointsNum = Number(stats.claimedPoints) || 0;
        $("#totalClaimedPoints").text(pointsNum.toLocaleString());
    }
}

function renderActivityHistory(history) {
    const list = $("#activityHistoryList");
    list.empty();

    if (!Array.isArray(history) || history.length === 0) {
        list.html(`<p class="subText">No claims recorded yet. As rewards and points are claimed, they will appear here in real time.</p>`);
        return;
    }

    history.forEach(item => {
        if (!item || typeof item !== "object") return;
        const timeAgo = formatTimeAgo(item.timestamp ? new Date(item.timestamp) : new Date());
        const hasValidImg = item.imgUrl && (typeof item.imgUrl === "string") && (item.imgUrl.startsWith("http://") || item.imgUrl.startsWith("https://"));
        const title = item.title || "Reward Claimed";
        const game = item.game || "Twitch";

        const safeImgUrl = hasValidImg ? encodeURI(item.imgUrl) : "";
        const imgHtml = hasValidImg
            ? `<img src="${safeImgUrl}" class="activityThumb img-with-fallback" alt="${escapeHtml(title)}">
               <div class="rewardGlyphBox miniGlyph" style="display:none;">${GIFT_SVG_ICON}</div>`
            : `<div class="rewardGlyphBox miniGlyph">${GIFT_SVG_ICON}</div>`;

        const card = $(`
            <div class="activityItem">
                ${imgHtml}
                <div class="activityMeta">
                    <span class="activityTitle" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                    <span class="activitySub">${escapeHtml(game)} &bull; <span class="activityTime">${escapeHtml(timeAgo)}</span></span>
                </div>
            </div>
        `);
        list.append(card);
    });
}

function formatTimeAgo(date) {
    if (!date || isNaN(date.getTime())) return "recently";
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
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

    const uniqueGames = new Set(POPULAR_DROP_GAMES);
    activeDropGamesSet.clear();

    if (Array.isArray(data)) {
        data.forEach(camp => {
            let name = "";
            let isActive = false;
            if (camp && camp.game && camp.game.displayName) {
                name = camp.game.displayName;
                isActive = Boolean(camp.hasActiveDrops || camp.status === "ACTIVE");
            } else if (camp && camp.displayName) {
                name = camp.displayName;
                isActive = Boolean(camp.hasActiveDrops);
            } else if (camp && camp.name) {
                name = camp.name;
                isActive = Boolean(camp.hasActiveDrops);
            } else if (typeof camp === "string" && camp.trim()) {
                name = camp.trim();
            }
            if (name) {
                uniqueGames.add(name);
                if (isActive) activeDropGamesSet.add(name);
            }
        });
    }

    currentAllGames = Array.from(uniqueGames).sort((a, b) => {
        const aActive = activeDropGamesSet.has(a);
        const bActive = activeDropGamesSet.has(b);
        if (aActive !== bActive) return aActive ? -1 : 1;
        return a.localeCompare(b);
    });

    const curVal = $("#gameSearchInput").val();
    filterDropdownItems(curVal ? curVal.toLowerCase().trim() : "");
}

function filterDropdownItems(query) {
    const list = $("#gameDropdownItems");
    list.empty();

    const q = query ? query.toLowerCase().trim() : "";
    const filtered = currentAllGames.filter(game => game.toLowerCase().includes(q));

    if (filtered.length === 0) {
        list.append(`<li style="color: #adadb8; cursor: default;">No matching games</li>`);
        return;
    }

    filtered.forEach(gameName => {
        const isActive = activeDropGamesSet.has(gameName);
        const badgeMarkup = isActive
            ? `<span class="activeGameBadgeTag">🟢 Active Drops</span>`
            : "";
        list.append(`
            <li data-game="${escapeHtml(gameName)}" class="dropdownItemRow">
                <span>${escapeHtml(gameName)}</span>
                ${badgeMarkup}
            </li>
        `);
    });
}

function updateDropProgressUI(data) {
    if (!data || !data.activeStream || data.activeStream.campaign === "none" || !data.activeStream.campaign) {
        $("#stopCampaignBtn").hide();
        $("#dropStatus").text("Status: Ready & Monitoring");
        $("#dropGame").text("Game: Select a campaign below or enable Auto Games");
        $("#headerStatusPill").html('<span class="statusDot idleDot"></span><span>Idle</span>').removeClass("activePill");
        $(".progressBarInner").css({ "width": "0%", "background": "var(--twitch-purple)" });
        $(".progressPercentText").text("0%");
        $("#activeDropDetails").empty();
        $("#streamToolbar").hide();
        return;
    }

    $("#stopCampaignBtn").show();
    const active = data.activeStream;
    const camp = active.campaign || {};
    const gameName = camp.game ? (camp.game.name || camp.game.displayName || "Twitch Drop") : (typeof camp === "string" ? camp : "Twitch Drop");

    if (gameName && gameName !== "Twitch Drop" && gameName !== "none") {
        $(".selectedGame").text(gameName);
    }

    if (camp.status === "no_active_drops") {
        $("#stopCampaignBtn").hide();
        $("#dropStatus").text(`No Active Drops: ${gameName}`);
        $("#dropGame").html(`Twitch does not have an active drop campaign for <strong>${escapeHtml(gameName)}</strong> right now.`);
        $("#headerStatusPill").html('<span class="statusDot idleDot"></span><span>No Active Drops</span>').removeClass("activePill");
        $(".progressBarInner").css({ "width": "0%", "background": "var(--bg-input)" });
        $(".progressPercentText").text("No drops available");
        $("#streamToolbar").hide();

        let detailsBox = $("#activeDropDetails");
        if (detailsBox.length === 0) {
            detailsBox = $('<div id="activeDropDetails" class="activeDropMetaRow"></div>');
            $(".dropProgressContainer").prepend(detailsBox);
        }

        detailsBox.html(`
            <div class="noDropsAlertCard">
                <div class="noDropsIconBox">${GIFT_SVG_ICON}</div>
                <div class="noDropsContent">
                    <span class="noDropsTitle">No Active Drops for ${escapeHtml(gameName)}</span>
                    <span class="noDropsDesc">There is currently no official drop campaign running on Twitch for this game. Farming is paused until a campaign goes live.</span>
                    <span class="noDropsTip">Select a game with active drops (marked 🟢) from the dropdown above, or check back when a campaign begins.</span>
                </div>
            </div>
        `);
        return;
    }

    if (camp.status === "nostream") {
        $("#stopCampaignBtn").show();

        const curCamp = (Array.isArray(active.campaigns) && active.campaigns.length > 0)
            ? (active.campaigns[camp.onCamp || 0] || active.campaigns[0])
            : null;
        const requiredStreamers = (camp.requiredStreamers && camp.requiredStreamers.length > 0)
            ? camp.requiredStreamers
            : (curCamp && Array.isArray(curCamp.streamers) ? curCamp.streamers : []);

        const hasSpecific = Array.isArray(requiredStreamers) && requiredStreamers.length > 0;
        let pillText = "No Drops Live";
        let statusTitle = `No Drops Live: ${gameName}`;
        let subTitle = `No broadcasters streaming <strong>${escapeHtml(gameName)}</strong> with drops enabled right now.`;
        let waitText = "Waiting for stream...";
        let cardTitle = "No Drops Streams Live";
        let cardDesc = `There are currently no broadcasters streaming <strong>${escapeHtml(gameName)}</strong> with drops enabled on Twitch.`;

        if (hasSpecific) {
            if (requiredStreamers.length === 1) {
                const singleChan = requiredStreamers[0];
                pillText = `${singleChan} offline`;
                statusTitle = `${singleChan} is offline`;
                subTitle = `Required channel <strong>${escapeHtml(singleChan)}</strong> for <strong>${escapeHtml(gameName)}</strong> is offline.`;
                waitText = `Waiting for ${singleChan}...`;
                cardTitle = `${singleChan} is Offline`;
                cardDesc = `Drops for <strong>${escapeHtml(gameName)}</strong> require watching <strong>${escapeHtml(singleChan)}</strong>, which is currently offline.`;
            } else {
                const chanListStr = requiredStreamers.join(", ");
                pillText = "Channels offline";
                statusTitle = `Channels Offline: ${gameName}`;
                subTitle = `Required channels (<strong>${escapeHtml(chanListStr)}</strong>) are currently offline.`;
                waitText = "Waiting for live channel...";
                cardTitle = "Required Channels Offline";
                cardDesc = `This drop campaign requires watching specific channel(s) that are not currently broadcasting.`;
            }
        }

        $("#dropStatus").text(statusTitle);
        $("#dropGame").html(subTitle);
        $("#headerStatusPill").html(`<span class="statusDot" style="background: #f0a232;"></span><span>${escapeHtml(pillText)}</span>`).removeClass("activePill");
        $(".progressBarInner").css({ "width": "0%", "background": "var(--bg-input)" });
        $(".progressPercentText").text(waitText);
        $("#streamToolbar").hide();

        let detailsBox = $("#activeDropDetails");
        if (detailsBox.length === 0) {
            detailsBox = $('<div id="activeDropDetails" class="activeDropMetaRow"></div>');
            $(".dropProgressContainer").prepend(detailsBox);
        }

        const channelBadgeHtml = hasSpecific
            ? `<div class="reqChannelsRow" style="margin-top: 6px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                   <strong style="font-size: 11px; color: #f0a232; text-transform: uppercase; letter-spacing: 0.5px;">Required:</strong>
                   ${requiredStreamers.map(ch => `<span class="channelReqBadge">${escapeHtml(ch)}</span>`).join("")}
               </div>`
            : "";

        detailsBox.html(`
            <div class="noDropsAlertCard" style="border-color: rgba(240, 162, 50, 0.3); background: rgba(240, 162, 50, 0.05);">
                <div class="noDropsIconBox" style="color: #f0a232; border-color: rgba(240, 162, 50, 0.4);">${GIFT_SVG_ICON}</div>
                <div class="noDropsContent">
                    <span class="noDropsTitle" style="color: #f0a232;">${cardTitle}</span>
                    <span class="noDropsDesc">${cardDesc}</span>
                    ${channelBadgeHtml}
                    <span class="noDropsTip" style="margin-top: 6px;">The Smart Auto-Queue will check for other queued games or resume farming as soon as an eligible channel starts broadcasting.</span>
                </div>
            </div>
        `);
        return;
    }

    let currentRewardItem = null;
    let allItems = [];
    let allClaimed = false;

    if (Array.isArray(active.campaigns) && active.campaigns.length > 0) {
        const curCampIdx = (typeof camp.onCamp === "number" && camp.onCamp >= 0) ? camp.onCamp : 0;
        const curCamp = active.campaigns[curCampIdx] || active.campaigns[0];
        if (curCamp) {
            const items = curCamp.items || curCamp.drops || curCamp.timeBasedDrops || [];
            if (Array.isArray(items) && items.length > 0) {
                allItems = [...items].sort((a, b) => {
                    const reqA = a.reqTime || a.requiredMinutesWatched || 0;
                    const reqB = b.reqTime || b.requiredMinutesWatched || 0;
                    return reqA - reqB;
                });

                allClaimed = true;
                allItems.forEach(i => {
                    const req = i.reqTime || i.requiredMinutesWatched || 60;
                    const itemWatched = (i.self && i.self.currentMinutesWatched !== undefined)
                        ? i.self.currentMinutesWatched
                        : (curCamp.minutesWatched || 0);
                    const isClaimed = Boolean((i.self && i.self.isClaimed === true) || (itemWatched >= req && req > 0));
                    i._computedClaimed = isClaimed;
                    i._computedWatched = itemWatched;
                    i._computedReq = req;

                    if (!isClaimed) {
                        allClaimed = false;
                    }
                });

                currentRewardItem = allItems.find(i => !i._computedClaimed) || allItems[allItems.length - 1];
            } else {
                allClaimed = false;
            }
        }
    }

    let detailsBox = $("#activeDropDetails");
    if (detailsBox.length === 0) {
        detailsBox = $('<div id="activeDropDetails" class="activeDropMetaRow"></div>');
        $(".dropProgressContainer").prepend(detailsBox);
    }

    // ALL DROPS FOR GAME COMPLETED
    if (allItems.length > 0 && allClaimed) {
        $("#dropStatus").text(`All drops for ${gameName} completed`);
        $("#dropGame").html(`Game: <strong style="color:var(--emerald-green);">${escapeHtml(gameName)}</strong> &bull; All Rewards Claimed`);
        $("#headerStatusPill").html('<span class="statusDot activeDot"></span><span>Completed</span>').addClass("activePill");
        $(".progressBarInner").css({ "width": "100%", "background": "linear-gradient(90deg, #00f59b 0%, #00d684 100%)" });
        $(".progressPercentText").text("100% (All Rewards Claimed)");
        $("#streamToolbar").hide();

        const iconsHtml = allItems.map(item => {
            const pic = item.picture || item.imageAssetURL || item.imageURL || "";
            const hasImg = pic && (typeof pic === "string") && (pic.startsWith("http://") || pic.startsWith("https://"));
            const title = item.name || item.title || "Reward";
            const reqMins = item.reqTime || item.requiredMinutesWatched || 60;
            const safePic = hasImg ? encodeURI(pic) : "";

            const imgMarkup = hasImg
                ? `<img src="${safePic}" class="completedThumb img-with-fallback" alt="${escapeHtml(title)}">
                   <div class="rewardGlyphBox miniGlyph" style="display:none;">${GIFT_SVG_ICON}</div>`
                : `<div class="rewardGlyphBox miniGlyph">${GIFT_SVG_ICON}</div>`;

            return `
                <div class="completedRewardIconCard" title="${escapeHtml(title)} (${reqMins} min requirement)">
                    ${imgMarkup}
                    <svg class="completedBadgeCheck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <span class="completedRewardLabel">${escapeHtml(title)}</span>
                </div>
            `;
        }).join("");

        detailsBox.html(`
            <div class="allCompletedCardBox">
                <div class="completedHeader">
                    <span class="completedTitle">All Running Drops for ${escapeHtml(gameName)} Completed</span>
                    <span class="completedSub">All rewards claimed & in your inventory</span>
                </div>
                ${allItems.length > 0 ? `<div class="completedGridRow">${iconsHtml}</div>` : ""}
            </div>
        `);
        return;
    }

    // Active In-Progress Mode:
    if (camp.curWatching) {
        $("#dropGame").html(`Watching: <a href="https://www.twitch.tv/${encodeURIComponent(camp.curWatching)}#atd-managed=1" id="focusFarmTab" class="streamerLink" title="Click to view stream tab">@${escapeHtml(camp.curWatching)} ↗</a>`);
        $("#headerStatusPill").html(`<span class="statusDot activeDot"></span><span>@${escapeHtml(camp.curWatching)}</span>`).addClass("activePill");
        $("#streamToolbar").show();
    } else {
        $("#dropGame").text(`Finding live drop stream for ${gameName}...`);
        $("#headerStatusPill").html(`<span class="statusDot activeDot"></span><span>${escapeHtml(gameName)}</span>`).addClass("activePill");
        $("#streamToolbar").hide();
    }
    $("#dropStatus").text(`Farming: ${gameName}`);

    const curCampObj = (Array.isArray(active.campaigns) && active.campaigns.length > 0)
        ? (active.campaigns[camp.onCamp || 0] || active.campaigns[0])
        : null;
    const itemWatched = currentRewardItem ? (currentRewardItem._computedWatched || 0) : (curCampObj?.minutesWatched || 0);
    const targetMins = currentRewardItem ? (currentRewardItem._computedReq || 60) : (curCampObj?.minutesNeeded || 60);

    const minsLeft = Math.max(0, targetMins - itemWatched);
    const etaText = minsLeft > 0 ? `~${minsLeft}m remaining` : "Ready to claim";
    const percent = Math.min(100, Math.round((itemWatched / Math.max(1, targetMins)) * 100));
    $(".progressBarInner").css({ "width": `${percent}%`, "background": "linear-gradient(90deg, var(--twitch-purple) 0%, var(--twitch-purple-light) 100%)" });
    $(".progressPercentText").text(`${percent}% (${itemWatched}/${targetMins} min)`);

    const rewardName = currentRewardItem ? (currentRewardItem.name || currentRewardItem.title || `${gameName} Drop Reward`) : `${gameName} Drop Reward`;
    const rewardImg = currentRewardItem ? (currentRewardItem.picture || currentRewardItem.imageAssetURL || currentRewardItem.imageURL || "") : "";
    const hasValidImg = rewardImg && (typeof rewardImg === "string") && (rewardImg.startsWith("http://") || rewardImg.startsWith("https://"));
    const safeRewardImg = hasValidImg ? encodeURI(rewardImg) : "";

    const imageHtml = hasValidImg
        ? `<img src="${safeRewardImg}" class="activeRewardThumb img-with-fallback" alt="${escapeHtml(rewardName)}">
           <div class="rewardGlyphBox" style="display:none;">${GIFT_SVG_ICON}</div>`
        : `<div class="rewardGlyphBox">${GIFT_SVG_ICON}</div>`;

    detailsBox.html(`
        <div class="activeRewardItem">
            ${imageHtml}
            <div class="activeRewardMeta">
                <span class="activeRewardTitle" title="${escapeHtml(rewardName)}">${escapeHtml(rewardName)}</span>
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
    const gameName = camp.game ? (camp.game.name || camp.game.displayName || "Selected Game") : (typeof camp === "string" ? camp : "Selected Game");

    if (camp.status === "no_active_drops") {
        container.html(`
            <div class="emptyDropsCard" style="padding: 16px; background: rgba(240, 162, 50, 0.05); border: 1px solid rgba(240, 162, 50, 0.25); border-radius: 8px; text-align: center;">
                <div style="display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 8px;">
                    <div class="noDropsIconBox" style="width: 28px; height: 28px; min-width: 28px;">${GIFT_SVG_ICON}</div>
                    <strong style="color: #f0a232; font-size: 14px;">No Active Drops: ${escapeHtml(gameName)}</strong>
                </div>
                <p style="color: var(--text-secondary); font-size: 12px; margin-bottom: 12px; line-height: 1.4;">
                    Twitch does not have an active drop campaign for <strong>${escapeHtml(gameName)}</strong> right now. When a campaign goes live, rewards and requirements will appear here automatically.
                </p>
                <div style="display: flex; gap: 8px; justify-content: center;">
                    <a href="https://www.twitch.tv/drops/campaigns" target="_blank" class="actionBtn miniBtn secondaryBtn">View Twitch Campaigns ↗</a>
                    <button class="actionBtn miniBtn" id="dropsPageSyncBtn">Sync Drops</button>
                </div>
            </div>
        `);

        $("#dropsPageSyncBtn").on("click", () => {
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            }
            showToast("Syncing drops with Twitch...");
        });
        return;
    }

    if (camp.status === "nostream") {
        const curCamp = (Array.isArray(activeStream.campaigns) && activeStream.campaigns.length > 0)
            ? (activeStream.campaigns[camp.onCamp || 0] || activeStream.campaigns[0])
            : null;
        const requiredStreamers = (camp.requiredStreamers && camp.requiredStreamers.length > 0)
            ? camp.requiredStreamers
            : (curCamp && Array.isArray(curCamp.streamers) ? curCamp.streamers : []);

        const hasSpecific = Array.isArray(requiredStreamers) && requiredStreamers.length > 0;
        const bannerTitle = hasSpecific
            ? (requiredStreamers.length === 1 ? `${escapeHtml(requiredStreamers[0])} is Offline` : "Required Channels Offline")
            : "No Drops Stream Live";
        const bannerDesc = hasSpecific
            ? `This drop campaign requires watching <strong>${escapeHtml(requiredStreamers.join(", "))}</strong>, which is currently offline.`
            : `No broadcasters are streaming <strong>${escapeHtml(gameName)}</strong> with drops enabled right now.`;

        container.append(`
            <div class="emptyDropsCard" style="padding: 12px 14px; background: rgba(240, 162, 50, 0.05); border: 1px solid rgba(240, 162, 50, 0.25); border-radius: 8px; margin-bottom: 12px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                    <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #f0a232;"></span>
                    <strong style="color: #f0a232; font-size: 13px;">${bannerTitle}</strong>
                </div>
                <p style="color: var(--text-secondary); font-size: 12px; margin: 0 0 6px 0; line-height: 1.4;">
                    ${bannerDesc} Available rewards for this campaign are listed below; farming will resume automatically when an eligible stream goes live.
                </p>
                ${hasSpecific ? `
                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                        <span style="font-size: 11px; color: #f0a232; font-weight: 600;">REQUIRED:</span>
                        ${requiredStreamers.map(ch => `<span class="channelReqBadge">${escapeHtml(ch)}</span>`).join("")}
                    </div>
                ` : ""}
            </div>
        `);
    }

    const campaigns = Array.isArray(activeStream.campaigns) ? activeStream.campaigns : [];
    const allRewardsList = [];

    campaigns.forEach((campaignObj) => {
        if (!campaignObj) return;
        const dropList = campaignObj.items || campaignObj.drops || campaignObj.timeBasedDrops || [];

        if (Array.isArray(dropList)) {
            dropList.forEach((drop, index) => {
                if (!drop) return;
                const title = drop.name || drop.title || `Reward #${index + 1}`;
                const minsNeeded = drop.reqTime || drop.minutesNeeded || drop.requiredMinutesWatched || campaignObj.minutesNeeded || 60;
                const itemMinsWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                    ? drop.self.currentMinutesWatched
                    : (campaignObj.minutesWatched || 0);

                const isClaimed = Boolean((drop.self && drop.self.isClaimed === true) || (itemMinsWatched >= minsNeeded && minsNeeded > 0));

                let imgUrl = drop.picture || drop.imageAssetURL || drop.imageURL || "";
                if (drop.benefitEdges && Array.isArray(drop.benefitEdges) && drop.benefitEdges[0]) {
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
        }
    });

    if (allRewardsList.length === 0) {
        container.html(`
            <div class="emptyDropsCard" style="padding: 16px; background: rgba(240, 162, 50, 0.05); border: 1px solid rgba(240, 162, 50, 0.25); border-radius: 8px; text-align: center;">
                <div style="display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 8px;">
                    <div class="noDropsIconBox" style="width: 28px; height: 28px; min-width: 28px;">${GIFT_SVG_ICON}</div>
                    <strong style="color: #f0a232; font-size: 14px;">No Drops Available: ${escapeHtml(gameName)}</strong>
                </div>
                <p style="color: var(--text-secondary); font-size: 12px; margin-bottom: 12px; line-height: 1.4;">
                    No drop rewards were found for <strong>${escapeHtml(gameName)}</strong>. Check the official Twitch campaigns page or select another game.
                </p>
                <div style="display: flex; gap: 8px; justify-content: center;">
                    <a href="https://www.twitch.tv/drops/campaigns" target="_blank" class="actionBtn miniBtn secondaryBtn">View Twitch Campaigns ↗</a>
                    <button class="actionBtn miniBtn" id="dropsPageSyncBtn">Sync Drops</button>
                </div>
            </div>
        `);

        $("#dropsPageSyncBtn").on("click", () => {
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ type: "p:getCurrentDrops" }).catch(() => {});
            }
            showToast("Syncing drops with Twitch...");
        });
        return;
    }

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

        const hasValidImg = reward.imgUrl && (typeof reward.imgUrl === "string") && (reward.imgUrl.startsWith("http://") || reward.imgUrl.startsWith("https://"));
        const safeRewardImg = hasValidImg ? encodeURI(reward.imgUrl) : "";
        const imgMarkup = hasValidImg
            ? `<img src="${safeRewardImg}" class="rewardImage img-with-fallback" alt="Reward">
               <div class="rewardGlyphBox" style="display:none;">${GIFT_SVG_ICON}</div>`
            : `<div class="rewardGlyphBox">${GIFT_SVG_ICON}</div>`;

        const card = $(`
            <div class="dropRewardCard ${reward.isClaimed ? "isClaimedCard" : ""}">
                ${imgMarkup}
                <div class="rewardInfo">
                    <span class="rewardName" title="${escapeHtml(reward.title)}">${escapeHtml(reward.title)}</span>
                    <span class="rewardTime">Requirement: ${reward.minsNeeded} minutes</span>
                </div>
                <span class="rewardBadge ${statusClass}">${statusText}</span>
            </div>
        `);

        container.append(card);
    });
}

function renderClaimedInventory(claimedDrops) {
    const container = $("#claimedInventoryList");
    const countBadge = $("#claimedInventoryCountBadge");
    if (container.length === 0) return;

    if (!Array.isArray(claimedDrops) || claimedDrops.length === 0) {
        container.html(`<p class="subText">No claimed rewards found in your Twitch inventory.</p>`);
        countBadge.text("0 Claimed");
        return;
    }

    countBadge.text(`${claimedDrops.length} Claimed`);

    container.empty();
    claimedDrops.forEach(drop => {
        if (!drop) return;
        const name = drop.name || "Drop Reward";
        const gameName = drop.game ? (drop.game.displayName || drop.game.name || "") : "";
        const timeAgo = drop.lastAwardedAt ? formatTimeAgo(new Date(drop.lastAwardedAt)) : "";
        const imgUrl = drop.imageURL || "";
        const hasValidImg = imgUrl && (typeof imgUrl === "string") && (imgUrl.startsWith("http://") || imgUrl.startsWith("https://"));
        const safeImg = hasValidImg ? encodeURI(imgUrl) : "";

        const imgMarkup = hasValidImg
            ? `<img src="${safeImg}" class="claimedDropThumb img-with-fallback" alt="${escapeHtml(name)}">
               <div class="claimedDropGlyph" style="display:none;">${GIFT_SVG_ICON}</div>`
            : `<div class="claimedDropGlyph">${GIFT_SVG_ICON}</div>`;

        const subText = [gameName, timeAgo ? `Claimed ${timeAgo}` : ""].filter(Boolean).join(" &bull; ");

        container.append(`
            <div class="claimedDropItem">
                ${imgMarkup}
                <div class="claimedDropMeta">
                    <span class="claimedDropTitle" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <span class="claimedDropSub">${subText}</span>
                </div>
                <span class="claimedDropBadge">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    Claimed
                </span>
            </div>
        `);
    });
}

function updateAutoGamesBadge(enabledCount, totalCount) {
    const eCount = Number(enabledCount) || 0;
    const tCount = Number(totalCount) || 0;
    $("#autoGameCountBadge").text(`${eCount} / ${tCount} Active Queue`);
}

function populateAutoGamesGrid(data) {
    const grid = $("#autoGamesList");
    grid.empty();

    let allGames = (data && Array.isArray(data.allConnected))
        ? data.allConnected
        : (Array.isArray(currentAutoGamesData.allConnected) ? currentAutoGamesData.allConnected : []);

    currentAutoGamesData.allConnected = allGames;

    const enabledList = (data && Array.isArray(data.enabled))
        ? data.enabled
        : (Array.isArray(currentAutoGamesData.enabled) ? currentAutoGamesData.enabled : []);
    const enabledSet = new Set(enabledList);
    const sortedGames = [...allGames].sort((a, b) => a.localeCompare(b));

    const activeEnabledCount = sortedGames.filter(g => enabledSet.has(g)).length;
    updateAutoGamesBadge(activeEnabledCount, sortedGames.length);

    if (sortedGames.length === 0) {
        grid.html(`
            <div class="emptyDropsCard" style="padding: 24px 16px; text-align: center; border: 1px dashed var(--border-color); border-radius: 8px; margin: 12px 0;">
                <div class="noDropsIconBox" style="width: 32px; height: 32px; min-width: 32px; margin: 0 auto 10px; color: var(--text-muted);">${GIFT_SVG_ICON}</div>
                <strong style="color: var(--text-secondary); font-size: 13px; display: block; margin-bottom: 6px;">No Active Drop Campaigns on Twitch</strong>
                <p style="color: var(--text-muted); font-size: 12px; margin: 0; line-height: 1.4;">
                    Only games with currently active Twitch Drop campaigns appear in this queue. When a new campaign launches, its game will appear here automatically.
                </p>
            </div>
        `);
        return;
    }

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

    $(".autoGameToggle").off("change").on("change", (e) => {
        const game = $(e.target).data("game");
        const checked = $(e.target).prop("checked");
        const card = $(e.target).closest(".autoGameCard");

        if (checked) {
            card.addClass("activeQueueCard").find(".autoGameStatusTag").text("Queued for Farming");
            if (!currentAutoGamesData.enabled.includes(game)) currentAutoGamesData.enabled.push(game);
        } else {
            card.removeClass("activeQueueCard").find(".autoGameStatusTag").text("Inactive");
            currentAutoGamesData.enabled = currentAutoGamesData.enabled.filter(g => g !== game);
        }

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "toggleAutoDropGame", data: [game, checked] }).catch(() => {});
        }

        const newCheckedCount = $(".autoGameToggle:checked").length;
        updateAutoGamesBadge(newCheckedCount, sortedGames.length);

        showToast(checked ? `Added ${game} to Auto Queue` : `Removed ${game} from Auto Queue`);
    });
}

function filterAutoGamesGrid(query) {
    const q = query ? query.toLowerCase().trim() : "";
    $(".autoGameCard").each((i, el) => {
        const card = $(el);
        const name = card.data("gamename") || "";
        if (name.includes(q)) {
            card.removeClass("hidden");
        } else {
            card.addClass("hidden");
        }
    });
}