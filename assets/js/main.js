// Auto Twitch Drops Pro - Popup UI Controller (Manifest V3)

// Apply the cached theme before first paint to avoid a flash.
(function applyEarlyTheme() {
    try {
        const t = localStorage.getItem("atd.theme");
        if (t === "auto" || t === "dark" || t === "light") {
            document.documentElement.setAttribute("data-theme", t);
        }
    } catch (e) { /* storage unavailable */ }
})();

const maniData = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest()
    : { version: "2.0.0" };

const HAS_RUNTIME = typeof chrome !== "undefined" && Boolean(chrome.runtime && chrome.runtime.sendMessage);
const HAS_STORAGE = typeof chrome !== "undefined" && Boolean(chrome.storage && chrome.storage.local);

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

/* Explicit setting key <-> checkbox selector map (DOM ids are test-locked). */
const SETTINGS_BINDINGS = {
    autoClaimPoints: "#setautoClaimPoints",
    setShowBadges: "#setsetShowBadges",
    desktopNotifications: "#setdesktopNotifications",
    soundOnClaim: "#setsoundOnClaim",
    autoRefresh: "#setautoRefresh",
    showAllGames: "#setshowAllGames",
    autoGetToken: "#setautoGetToken",
    autoCheckUpdates: "#setautoCheckUpdates"
};

const THEMES = ["auto", "dark", "light"];
const DEFAULT_SETTINGS = {
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

function isOverwatchGame(name) {
    if (!name || typeof name !== "string") return false;
    const clean = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return clean === "overwatch" || clean === "overwatch2";
}

function areGameNamesMatching(gameA, gameB) {
    if (!gameA || !gameB) return false;
    if (typeof gameA !== "string" || typeof gameB !== "string") return false;

    const a = gameA.trim();
    const b = gameB.trim();
    if (!a || !b) return false;
    if (a.toLowerCase() === b.toLowerCase()) return true;

    if (isOverwatchGame(a) && isOverwatchGame(b)) {
        return true;
    }

    const normA = a.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normB = b.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!normA || !normB) return false;
    if (normA === normB) return true;

    if (normA.length >= 6 && normB.length >= 6) {
        const lowerA = a.toLowerCase();
        const lowerB = b.toLowerCase();
        const isSubtitleVariant = (base, full) => {
            if (!full.startsWith(base)) return false;
            const remainder = full.slice(base.length);
            return /^\s*(?::|-|—|–)\s*/.test(remainder);
        };
        if (isSubtitleVariant(lowerA, lowerB) || isSubtitleVariant(lowerB, lowerA)) {
            return true;
        }
    }

    return false;
}

/* ------------------------------------------------------------------ state */
let settings = { ...DEFAULT_SETTINGS };
let extEnabled = true;
let gameSelectOpen = false;
let currentAllGames = [];
let lastGamesData = null;
const activeDropGamesSet = new Set();
let currentActiveStream = null;
let currentClaimedInventory = [];
let claimedViewMode = "recent";
let currentAutoGamesData = { allConnected: [], enabled: [] };
let currentPage = "mainPage";
let twitchServerTimeOffset = 0;
let lastUpdateInfo = null;
let updateBannerDismissed = false;
let authDismissedFor = null;
let lastAuthState = null;
let lastCheckAt = 0;
let lastHistory = [];
let historyCountSeen = null;
let etaState = null;
let tickerHandle = null;
let pollHandle = null;
let toastTimer = null;
let clearConfirmTimer = null;
let dropdownActiveIndex = -1;
const loaded = { claimed: false, queue: false, history: false };

function getEffectiveNow() {
    return Date.now() + (Number(twitchServerTimeOffset) || 0);
}

/* ---------------------------------------------------------------- helpers */
function icon(name, cls) {
    return `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

const GIFT_SVG_ICON = `<svg class="rewardFallbackGlyph" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-gift"/></svg>`;

function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function isHttpUrl(u) {
    return typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"));
}

function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* ignore */ }
}

/* Background request: never throws. Returns response, null (no payload) or { ok:false, error }. */
async function request(type, data) {
    if (!HAS_RUNTIME) return null;
    try {
        const msg = data === undefined ? { type } : { type, data };
        const res = await chrome.runtime.sendMessage(msg);
        return res === undefined ? null : res;
    } catch (e) {
        return { ok: false, error: (e && e.message) ? e.message : "Background service unavailable" };
    }
}
const isFailed = (res) => Boolean(res && res.ok === false);
const errorText = (res, fallback) => (res && res.error) ? String(res.error) : fallback;
function payloadOf(res) {
    if (res && typeof res === "object" && res.ok !== undefined && res.data !== undefined) return res.data;
    return res;
}

// Document-level error listener (capture) handles failed images without inline handlers (MV3 CSP safe)
document.addEventListener("error", (e) => {
    const t = e.target;
    if (!t || t.tagName !== "IMG") return;
    if (t.classList.contains("appLogo")) {
        t.hidden = true;
    } else if (t.classList.contains("img-with-fallback")) {
        t.hidden = true;
        if (t.nextElementSibling) t.nextElementSibling.hidden = false;
    }
}, true);

/* ------------------------------------------------------------------ toast */
function showToast(text, type) {
    if (!text) return;
    const toast = $("#toastNotification");
    toast.removeClass("toast-success toast-info toast-error")
        .addClass(`toast-${type || "info"}`)
        .text(text)
        .addClass("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.removeClass("show"), type === "error" ? 4000 : 2500);
}

async function copyText(text, okMsg) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            showToast(okMsg || "Copied to clipboard", "success");
            return true;
        }
    } catch (e) { /* fall through */ }
    showToast("Clipboard unavailable. Select and copy manually.", "error");
    return false;
}

/* ----------------------------------------------------------- status engine */
const PAUSED_STATE = {
    kind: "paused",
    pill: "Paused",
    title: "Extension paused",
    sub: "Switch it back on to resume farming.",
    pct: 0,
    label: "Paused",
    toolbar: false,
    stop: false
};

/*
 * Single renderer for header pill, hero status card, and progress bar.
 * Visuals come exclusively from [data-status] on #appContainer (see main.css).
 * state: { kind, pill, title, sub(html), pct, label, toolbar, stop }
 */
function renderStatus(state) {
    const s = extEnabled ? state : PAUSED_STATE;
    $("#appContainer").attr("data-status", s.kind);
    $("#headerStatusText").text(s.pill);
    $("#dropStatus").text(s.title);
    $("#dropGame").html(s.sub || "");
    const pct = Math.max(0, Math.min(100, Number(s.pct) || 0));
    $(".progressBarInner").css("width", `${pct}%`);
    $(".progressBarOuter").attr("aria-valuenow", pct);
    $(".progressPercentText").text(s.label != null ? s.label : `${pct}%`);
    $("#streamToolbar").prop("hidden", !s.toolbar);
    $("#stopCampaignBtn").prop("hidden", !s.stop);
}

function noticeHtml(o) {
    return `
        <div class="noticeCard ${o.tone || ""} ${o.center ? "center" : ""}">
            <div class="noticeIcon">${icon(o.iconName || "gift")}</div>
            <div class="noticeBody">
                <span class="noticeTitle">${o.title || ""}</span>
                ${o.desc ? `<span class="noticeDesc">${o.desc}</span>` : ""}
                ${o.extra || ""}
            </div>
        </div>`;
}

function thumbHtml(url, imgClass, boxClass, alt) {
    const has = isHttpUrl(url);
    const box = `<div class="${boxClass}"${has ? " hidden" : ""}>${GIFT_SVG_ICON}</div>`;
    if (!has) return box;
    return `<img src="${escapeHtml(encodeURI(url))}" class="${imgClass} img-with-fallback" alt="${escapeHtml(alt || "")}">${box}`;
}

/* ------------------------------------------------------- time / tickers */
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

function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, "0");
    return `${m}:${sec}`;
}

function markChecked() {
    lastCheckAt = Date.now();
    renderLastCheck();
}

function renderLastCheck() {
    if (!lastCheckAt) return;
    const secs = Math.floor((Date.now() - lastCheckAt) / 1000);
    let text;
    if (secs < 5) text = "Checked just now";
    else if (secs < 60) text = `Checked ${secs}s ago`;
    else text = `Checked ${Math.floor(secs / 60)}m ago`;
    $("#lastCheckTime").text(text);
}

function formatEtaFromState(state) {
    if (!state || state.minsLeft <= 0) return "Ready to claim";
    const elapsed = Math.max(0, Math.min(59, (Date.now() - state.at) / 1000));
    const remaining = Math.max(1, state.minsLeft * 60 - elapsed);
    return `~${formatClock(remaining)} left`;
}

function tick() {
    renderLastCheck();
    if (etaState && extEnabled) {
        $("#etaText").text(formatEtaFromState(etaState));
    }
}

function startTicker() {
    stopTicker();
    tick();
    tickerHandle = setInterval(tick, 1000);
    pollHandle = setInterval(() => {
        if (extEnabled) loadDrops();
    }, 15000);
}
function stopTicker() {
    if (tickerHandle) clearInterval(tickerHandle);
    if (pollHandle) clearInterval(pollHandle);
    tickerHandle = null;
    pollHandle = null;
}

/* --------------------------------------------------------------- loaders */
async function loadDrops() {
    const res = await request("p:getCurrentDrops");
    if (isFailed(res)) {
        if (!loaded.claimed) renderListError($("#claimedInventoryList"), errorText(res, "Could not load claimed rewards."), "drops");
        return false;
    }
    const p = payloadOf(res);
    if (p && typeof p === "object" && ("activeStream" in p || "claimedInventory" in p)) {
        applyDrops(p);
    }
    markChecked();
    return true;
}

function normalizeStream(v) {
    return (v && v !== "none" && v.campaign && v.campaign !== "none") ? v : null;
}

function applyDrops(p) {
    if ("activeStream" in p) {
        currentActiveStream = normalizeStream(p.activeStream);
        updateDropProgressUI({ activeStream: currentActiveStream });
        renderActiveDropsList(currentActiveStream);
    }
    if (Array.isArray(p.claimedInventory)) {
        currentClaimedInventory = p.claimedInventory;
        renderClaimedInventory(currentClaimedInventory);
    } else if (!loaded.claimed) {
        renderClaimedInventory(currentClaimedInventory);
    }
}

async function loadGames() {
    const res = await request("p:getConnectedGames");
    if (isFailed(res)) return false;
    const p = payloadOf(res);
    const list = Array.isArray(p) ? p : (p && (Array.isArray(p.games) ? p.games : (Array.isArray(p.data) ? p.data : null)));
    if (list) populateGameDropdown(list);
    return true;
}

async function loadQueue() {
    const res = await request("getAutoDropGames");
    if (isFailed(res)) {
        if (!loaded.queue) renderListError($("#autoGamesList"), errorText(res, "Could not load the queue."), "queue");
        return false;
    }
    const p = payloadOf(res);
    if (p && typeof p === "object") populateAutoGamesGrid(p);
    return true;
}

async function loadActivity() {
    const [stats, hist] = await Promise.all([request("getExtStats"), request("getActivityHistory")]);
    const sp = payloadOf(stats);
    if (sp && typeof sp === "object" && !isFailed(stats)) updateStatsUI(sp.extStats || sp);
    if (isFailed(hist)) {
        if (!loaded.history) renderListError($("#activityHistoryList"), errorText(hist, "Could not load history."), "activity");
        return false;
    }
    const hp = payloadOf(hist);
    const items = Array.isArray(hp) ? hp : (hp && Array.isArray(hp.activityHistory) ? hp.activityHistory : null);
    if (items) renderActivityHistory(items);
    return true;
}

async function loadUpdateState() {
    const res = await request("p:getUpdateState");
    const p = payloadOf(res);
    if (p && typeof p === "object" && !isFailed(res)) renderUpdateInfo(p);
}

function renderListError(container, message, retryKey) {
    container.html(noticeHtml({
        tone: "error",
        iconName: "alert",
        title: "Something went wrong",
        desc: escapeHtml(message),
        extra: `<div class="noticeActions"><button type="button" class="btn btnSm retryBtn" data-retry="${retryKey}">${icon("refresh")}<span>Retry</span></button></div>`
    }));
}

function refreshAll() {
    loadGames();
    loadDrops();
    loadQueue();
    loadActivity();
    loadUpdateState();
}

/* ----------------------------------------------------------------- pages */
const PAUSED_ALLOWED_PAGES = new Set(["activityPage", "settingsPage"]);

function showPage(pageId, navTabOverride) {
    if (!pageId) return;
    currentPage = pageId;
    $(".page").prop("hidden", true);
    $(`#${pageId}`).prop("hidden", false);
    $("#contentArea").scrollTop(0);

    const activeTabId = navTabOverride || pageId;
    const isTab = $(`.navItem[data-page="${activeTabId}"]`).length > 0;
    $(".navItem").each((i, el) => {
        const on = isTab && $(el).data("page") === activeTabId;
        $(el).toggleClass("active", on).attr({ "aria-selected": on ? "true" : "false", tabindex: on ? "0" : "-1" });
    });
    if (!isTab) {
        $("#topNav .navItem").first().attr("tabindex", "0");
    }
    if (pageId !== "extDisabled" && isTab) lsSet("atd.lastTab", pageId);
    if (pageId === "activityPage") {
        $("#activityNavDot").prop("hidden", true);
        historyCountSeen = lastHistory.length;
    }
}

function activatePage(pageId) {
    if (!extEnabled) {
        if (PAUSED_ALLOWED_PAGES.has(pageId)) {
            showPage(pageId);
            if (pageId === "activityPage") loadActivity();
            else if (pageId === "settingsPage") loadUpdateState();
        } else {
            showPage("extDisabled", pageId);
        }
        return;
    }
    showPage(pageId);
    if (pageId === "autoDropsPage") loadQueue();
    else if (pageId === "activityPage") loadActivity();
    else if (pageId === "dropsPage") { renderActiveDropsList(currentActiveStream); loadDrops(); }
}

function applyEnabledState(enabled, opts) {
    extEnabled = enabled;
    $(".enableEx").prop("checked", enabled);
    if (!enabled) {
        $("#githubUpdateBanner, #authStatusBanner").prop("hidden", true);
        if (PAUSED_ALLOWED_PAGES.has(currentPage)) {
            showPage(currentPage);
        } else {
            const last = lsGet("atd.lastTab");
            if (opts && opts.restore && PAUSED_ALLOWED_PAGES.has(last)) {
                showPage(last);
            } else {
                showPage("extDisabled", "mainPage");
            }
        }
        renderStatus(PAUSED_STATE);
    } else {
        const last = lsGet("atd.lastTab");
        const target = (opts && opts.restore && $(`.navItem[data-page="${last}"]`).length)
            ? last
            : (PAUSED_ALLOWED_PAGES.has(currentPage) ? currentPage : "mainPage");
        showPage(target);
        updateDropProgressUI({ activeStream: currentActiveStream });
        renderUpdateInfo(lastUpdateInfo);
        renderAuth(lastAuthState);
    }
}

/* ---------------------------------------------------------------- settings */
function applyTheme(theme) {
    const t = THEMES.includes(theme) ? theme : "auto";
    document.documentElement.setAttribute("data-theme", t);
    lsSet("atd.theme", t);
    $("#themeSeg button").each((i, el) => {
        $(el).attr("aria-checked", $(el).data("theme-val") === t ? "true" : "false");
    });
}

function syncSettingsToDom() {
    Object.keys(SETTINGS_BINDINGS).forEach((key) => {
        $(SETTINGS_BINDINGS[key]).prop("checked", Boolean(settings[key]));
    });
    applyTheme(settings.theme);
}

function persistSettings(changedKey) {
    if (HAS_STORAGE) {
        chrome.storage.local.set({ settings }).catch(() => showToast("Could not save settings", "error"));
    }
    request("p:settingsChanged", { settings }).then((res) => {
        if (isFailed(res)) showToast(errorText(res, "Background did not accept the setting"), "error");
    });
    if (changedKey === "showAllGames") {
        rebuildGameDropdown();
        loadGames();
    }
}

/* ------------------------------------------------------------------ auth */
function renderAuth(auth) {
    if (auth) lastAuthState = auth;
    const banner = $("#authStatusBanner");
    const state = lastAuthState;
    if (!extEnabled || !state || state.status === "ok") {
        banner.prop("hidden", true);
        authDismissedFor = null;
        return;
    }
    const key = `${state.status}:${state.reason || ""}`;
    banner.data("key", key);
    if (authDismissedFor === key) {
        banner.prop("hidden", true);
        return;
    }
    if (state.status === "unauthenticated") {
        $("#authBannerTitle").text("Twitch login required");
        $("#authBannerDesc").text("Log in to Twitch in this browser so drops can be discovered and farmed.");
        $("#authLoginBtn").prop("hidden", false);
    } else {
        $("#authBannerTitle").text("Twitch connection problem");
        $("#authBannerDesc").text(state.reason ? String(state.reason) : "Could not talk to Twitch. It will retry automatically.");
        $("#authLoginBtn").prop("hidden", true);
    }
    banner.prop("hidden", false);
}

async function checkAuthStatus() {
    if (!HAS_STORAGE) return;
    try {
        const stored = await chrome.storage.local.get(["authState"]);
        if (stored && stored.authState && typeof stored.authState === "object") {
            renderAuth(stored.authState);
        }
    } catch (e) {
        console.warn("Error checking auth status:", e);
    }
}

/* ----------------------------------------------------------------- update */
function renderUpdateInfo(update) {
    if (!update || typeof update !== "object") return;
    lastUpdateInfo = update;
    const currentVer = update.currentVersion || maniData.version || "2.0.0";
    $("#currentVerDisplay").text(`v${currentVer}`);
    $("#extVersion").text(`v${currentVer}`);

    if (update.lastChecked) {
        const d = new Date(update.lastChecked);
        $("#lastCheckedDisplay").text(isNaN(d.getTime()) ? "Recently" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    }

    const statusText = $("#updateStatusText").removeClass("accent");
    if (update.updateAvailable) {
        $("#updateBannerVersion").text(`v${update.latestVersion}`);
        $("#updateBannerSubtitle").text(update.commitMessage || "A new release is available on GitHub.");
        if (isHttpUrl(update.releaseUrl)) $("#viewReleaseLink").attr("href", update.releaseUrl);
        $("#githubUpdateBanner").prop("hidden", !extEnabled || updateBannerDismissed);
        $("#updateStatusPill").removeClass("pillUpToDate").addClass("pillUpdateAvail").text(`v${update.latestVersion} available`);
        statusText.addClass("accent").text(`Update available (v${update.latestVersion})`);
    } else {
        $("#githubUpdateBanner").prop("hidden", true);
        $("#updateStatusPill").removeClass("pillUpdateAvail").addClass("pillUpToDate").text(`v${currentVer}`);
        statusText.text(update.ok === false ? "Could not check" : "Up to date");
    }
}

/* ------------------------------------------------------------------ audio */
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
    } catch (e) { /* audio unavailable */ }
}

/* ------------------------------------------------------------------ stats */
function updateStatsUI(stats) {
    if (!stats || typeof stats !== "object") return;
    if (stats.claimedDrops !== undefined) {
        $("#totalClaimedDrops").text((Number(stats.claimedDrops) || 0).toLocaleString());
    }
    if (stats.claimedPoints !== undefined) {
        $("#totalClaimedPoints").text((Number(stats.claimedPoints) || 0).toLocaleString());
    }
}

function normalizeHistory(history) {
    if (Array.isArray(history)) return history;
    if (history && Array.isArray(history.history)) return history.history;
    if (history && Array.isArray(history.activityHistory)) return history.activityHistory;
    return [];
}

function renderActivityHistory(history) {
    loaded.history = true;
    const items = normalizeHistory(history).filter((i) => i && typeof i === "object");
    const grew = historyCountSeen !== null && items.length > historyCountSeen;
    lastHistory = items;
    if (historyCountSeen === null || currentPage === "activityPage") historyCountSeen = items.length;
    if (grew && currentPage !== "activityPage") $("#activityNavDot").prop("hidden", false);

    const list = $("#activityHistoryList").empty();
    $("#copyHistoryBtn, #clearHistoryBtn").prop("disabled", items.length === 0);
    if (items.length === 0) {
        list.html(`<p class="subText">No claims yet. Rewards and points will show up here as they are claimed.</p>`);
        return;
    }

    items.forEach((item) => {
        const timeAgo = formatTimeAgo(item.timestamp ? new Date(item.timestamp) : new Date());
        const title = item.title || "Reward claimed";
        const game = item.game || "Twitch";
        list.append(`
            <div class="activityItem">
                ${thumbHtml(item.imgUrl, "activityThumb", "rewardGlyphBox miniGlyph", title)}
                <div class="activityMeta">
                    <span class="activityTitle" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                    <span class="activitySub">${escapeHtml(game)} &bull; <span class="activityTime">${escapeHtml(timeAgo)}</span></span>
                </div>
            </div>
        `);
    });
}

/* ----------------------------------------------------------- game picker */
function rebuildGameDropdown() {
    populateGameDropdown(lastGamesData);
}

function campaignDisplayName(camp) {
    if (typeof camp === "string") return camp.trim();
    if (!camp) return "";
    if (camp.game && camp.game.displayName) return camp.game.displayName;
    return camp.displayName || camp.name || "";
}

function populateGameDropdown(data) {
    lastGamesData = data;
    const uniqueMap = new Map();
    activeDropGamesSet.clear();

    if (Array.isArray(data)) {
        const now = getEffectiveNow();
        data.forEach((camp) => {
            const name = campaignDisplayName(camp);
            if (!name) return;
            const key = name.toLowerCase();
            if (!uniqueMap.has(key)) uniqueMap.set(key, name);
            if (typeof camp === "string") return;
            const endTs = camp.endAt ? new Date(camp.endAt).getTime() : NaN;
            const isExpired = !isNaN(endTs) && endTs <= now;
            const isActive = (camp.hasActiveDrops !== undefined) ? Boolean(camp.hasActiveDrops) : (camp.status === "ACTIVE" && !isExpired);
            if (isActive) activeDropGamesSet.add(uniqueMap.get(key));
        });
    }

    if (settings.showAllGames) {
        POPULAR_DROP_GAMES.forEach((g) => {
            const key = g.toLowerCase();
            if (!uniqueMap.has(key)) uniqueMap.set(key, g);
        });
    }

    const activeNames = Array.from(activeDropGamesSet);
    currentAllGames = Array.from(uniqueMap.values()).sort((a, b) => {
        const aActive = activeNames.some((g) => areGameNamesMatching(g, a));
        const bActive = activeNames.some((g) => areGameNamesMatching(g, b));
        if (aActive !== bActive) return aActive ? -1 : 1;
        return a.localeCompare(b);
    });

    const curVal = $("#gameSearchInput").val();
    filterDropdownItems(curVal ? curVal.toLowerCase().trim() : "");
}

function filterDropdownItems(query) {
    const list = $("#gameDropdownItems").empty();
    dropdownActiveIndex = -1;
    const q = query ? query.toLowerCase().trim() : "";
    const filtered = currentAllGames.filter((game) => game.toLowerCase().includes(q));

    if (filtered.length === 0) {
        list.append(`<li class="dropdownEmpty" role="option" aria-disabled="true">${currentAllGames.length === 0 ? "No campaigns available" : "No matching games"}</li>`);
        return;
    }

    const activeNames = Array.from(activeDropGamesSet);
    filtered.forEach((gameName) => {
        const isActive = activeNames.some((g) => areGameNamesMatching(g, gameName));
        list.append(`
            <li data-game="${escapeHtml(gameName)}" class="dropdownItemRow" role="option">
                <span>${escapeHtml(gameName)}</span>
                ${isActive ? `<span class="activeGameBadgeTag">Active drops</span>` : ""}
            </li>
        `);
    });
}

function setDropdownOpen(open) {
    gameSelectOpen = open;
    $(".selectDropdown").toggleClass("hidden", !open);
    $("#selGame").attr("aria-expanded", open ? "true" : "false");
    if (open) $("#gameSearchInput").trigger("focus");
}

function moveDropdownActive(delta) {
    const items = $("#gameDropdownItems li.dropdownItemRow");
    if (!items.length) return;
    dropdownActiveIndex = (dropdownActiveIndex + delta + items.length) % items.length;
    items.removeClass("kbdActive");
    const el = items.eq(dropdownActiveIndex).addClass("kbdActive");
    if (el[0] && el[0].scrollIntoView) el[0].scrollIntoView({ block: "nearest" });
}

async function selectGame(gameName) {
    if (!gameName) return;
    $(".selectedGame").text(gameName);
    setDropdownOpen(false);
    $("#selGame").trigger("focus");

    renderStatus({
        kind: "searching",
        pill: gameName,
        title: `Farming: ${gameName}`,
        sub: `Finding a live drops stream for <strong>${escapeHtml(gameName)}</strong>…`,
        pct: 0,
        label: "Starting…",
        toolbar: false,
        stop: true
    });

    const res = await request("p:startCampaign", { campaign: gameName, manual: true });
    if (isFailed(res)) {
        showToast(errorText(res, "Could not start that campaign"), "error");
        loadDrops();
        return;
    }
    showToast(`Target game: ${gameName}`, "success");
    setTimeout(loadDrops, 1000);
}

/* --------------------------------------------------- drop progress (Home) */
function formatDropEndDate(dateVal) {
    if (!dateVal) return "";
    try {
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return "";
        return d.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short"
        });
    } catch (e) {
        return "";
    }
}

function campaignDrops(c) {
    return c ? (c.items || c.drops || c.timeBasedDrops || []) : [];
}

function hasFarmableDrop(c, now) {
    if (!c) return false;
    const cEnd = c.endsAt || (c.endAt ? new Date(c.endAt).getTime() : NaN);
    if (!isNaN(cEnd) && cEnd <= now) return false;
    return campaignDrops(c).some((d) => {
        const dEnd = d.endsAt || (d.endAt ? new Date(d.endAt).getTime() : cEnd);
        const ended = !isNaN(dEnd) && dEnd <= now;
        const claimed = Boolean((d.self && d.self.isClaimed) || d._computedClaimed);
        return !ended && !claimed;
    });
}

function gameNameOf(camp, fallback) {
    if (camp && camp.game) return camp.game.name || camp.game.displayName || fallback;
    return typeof camp === "string" ? camp : fallback;
}

function rewardImageOf(item) {
    return item.picture || item.imageAssetURL || item.imageURL || "";
}

function setDetails(html) {
    $("#activeDropDetails").html(html || "");
}

function processCampItems(c, effectiveNow) {
    if (!c) return { items: [], allClaimed: false, hasFarmable: false };
    const rawItems = campaignDrops(c);
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return { items: [], allClaimed: false, hasFarmable: false };
    }
    const sorted = [...rawItems].sort((a, b) => (a.reqTime || a.requiredMinutesWatched || 0) - (b.reqTime || b.requiredMinutesWatched || 0));

    let cAllClaimed = true;
    let cHasFarmable = false;
    sorted.forEach((i) => {
        const req = i.reqTime || i.requiredMinutesWatched || 60;
        const itemWatched = (i.self && i.self.currentMinutesWatched !== undefined)
            ? i.self.currentMinutesWatched
            : (c.minutesWatched || 0);
        const isClaimed = Boolean(i.self && i.self.isClaimed === true);
        const isReady = Boolean(!isClaimed && req > 0 && itemWatched >= req);
        const dropEnd = i.endAt ? new Date(i.endAt).getTime() : (i.endsAt ? new Date(i.endsAt).getTime() : (c.endsAt || NaN));
        const isEnded = Boolean(!isNaN(dropEnd) && dropEnd <= effectiveNow);

        i._computedClaimed = isClaimed;
        i._computedReady = isReady;
        i._computedEnded = isEnded;
        i._computedWatched = itemWatched;
        i._computedReq = req;

        if (!isClaimed) cAllClaimed = false;
        if (!isClaimed && !isEnded) cHasFarmable = true;
    });
    return { items: sorted, allClaimed: cAllClaimed, hasFarmable: cHasFarmable };
}

function chipsHtml(label, names) {
    return `<div class="chipRow"><span class="chipLabel">${escapeHtml(label)}</span>${names.map((ch) => `<span class="channelReqBadge">${escapeHtml(ch)}</span>`).join("")}</div>`;
}

function updateDropProgressUI(data) {
    const prevEta = etaState;
    etaState = null;
    const active = data && data.activeStream;
    if (!active || active === "none" || !active.campaign || active.campaign === "none") {
        setDetails("");
        renderStatus({
            kind: "idle",
            pill: "Idle",
            title: "Ready and monitoring",
            sub: "Pick a game below or add games to the Queue.",
            pct: 0,
            label: "0%",
            toolbar: false,
            stop: false
        });
        return;
    }

    const camp = active.campaign || {};
    const gameName = gameNameOf(camp, "Twitch Drop");
    const gameEsc = escapeHtml(gameName);
    if (gameName && gameName !== "Twitch Drop" && gameName !== "none") {
        $(".selectedGame").text(gameName);
    }

    const effectiveNow = getEffectiveNow();

    /* Campaign closed, or Twitch has no active drops for it */
    const isExpired = Boolean(camp.endsAt && !isNaN(camp.endsAt) && effectiveNow >= camp.endsAt && !camp.isCompleted);
    if (camp.status === "no_active_drops" || isExpired) {
        renderStatus({
            kind: "ended",
            pill: isExpired ? "Campaign closed" : "No active drops",
            title: isExpired ? `Campaign closed: ${gameName}` : `No active drops: ${gameName}`,
            sub: `Twitch drop campaign for <strong>${gameEsc}</strong> is ${isExpired ? "closed" : "inactive"}.`,
            pct: 0,
            label: isExpired ? "Campaign ended" : "No drops available",
            toolbar: false,
            stop: false
        });
        setDetails(noticeHtml({
            tone: "",
            iconName: "gift",
            title: isExpired ? `Campaign closed for ${gameEsc}` : `No active drops for ${gameEsc}`,
            desc: isExpired
                ? "The Twitch drop campaign for this game reached its end time. Farming paused automatically."
                : "Twitch is not running a drop campaign for this game right now. Farming resumes when one goes live.",
            extra: `<span class="noticeDesc">Pick a game tagged <strong>Active drops</strong> in the picker above.</span>`
        }));
        return;
    }

    /* Required channels offline / nobody streaming */
    if (camp.status === "nostream") {
        const curCamp = (Array.isArray(active.campaigns) && active.campaigns.length > 0)
            ? (active.campaigns[camp.onCamp || 0] || active.campaigns[0])
            : null;
        const required = (camp.requiredStreamers && camp.requiredStreamers.length > 0)
            ? camp.requiredStreamers
            : (curCamp && Array.isArray(curCamp.streamers) ? curCamp.streamers : []);
        const hasSpecific = Array.isArray(required) && required.length > 0;

        let pill = "No drops live";
        let title = `No drops live: ${gameName}`;
        let sub = `No broadcasters are streaming <strong>${gameEsc}</strong> with drops enabled.`;
        let wait = "Waiting for stream…";
        let cardTitle = "No drops streams live";
        let cardDesc = `No broadcasters are streaming <strong>${gameEsc}</strong> with drops enabled on Twitch.`;

        if (hasSpecific && required.length === 1) {
            const one = required[0];
            const oneEsc = escapeHtml(one);
            pill = `${one} offline`;
            title = `${one} is offline`;
            sub = `Required channel <strong>${oneEsc}</strong> for <strong>${gameEsc}</strong> is offline.`;
            wait = `Waiting for ${one}…`;
            cardTitle = `${oneEsc} is offline`;
            cardDesc = `Drops for <strong>${gameEsc}</strong> require watching <strong>${oneEsc}</strong>, who is currently offline.`;
        } else if (hasSpecific) {
            pill = "Channels offline";
            title = `Channels offline: ${gameName}`;
            sub = `Required channels (<strong>${escapeHtml(required.join(", "))}</strong>) are offline.`;
            wait = "Waiting for a live channel…";
            cardTitle = "Required channels offline";
            cardDesc = "This campaign requires specific channels that are not broadcasting right now.";
        }

        renderStatus({ kind: "waiting", pill, title, sub, pct: 0, label: wait, toolbar: false, stop: true });
        setDetails(noticeHtml({
            tone: "warn",
            iconName: "clock",
            title: cardTitle,
            desc: cardDesc,
            extra: (hasSpecific ? chipsHtml("Required", required) : "") +
                `<span class="noticeDesc">The queue resumes farming as soon as an eligible channel goes live.</span>`
        }));
        return;
    }

    /* Resolve which campaign + reward is current */
    let currentRewardItem = null;
    let allItems = [];
    let allClaimed = false;
    let chosenCamp = null;

    if (Array.isArray(active.campaigns) && active.campaigns.length > 0) {
        const idx = (typeof camp.onCamp === "number" && camp.onCamp >= 0) ? camp.onCamp : 0;
        const candidate = active.campaigns[idx] || active.campaigns[0];
        const candRes = processCampItems(candidate, effectiveNow);
        let pick = candidate;
        let pickRes = candRes;

        if (!candRes.hasFarmable && active.campaigns.length > 1) {
            for (let i = 0; i < active.campaigns.length; i++) {
                if (i === idx) continue;
                const sibRes = processCampItems(active.campaigns[i], effectiveNow);
                if (sibRes.hasFarmable) {
                    pick = active.campaigns[i];
                    pickRes = sibRes;
                    break;
                }
            }
        }
        chosenCamp = pick;
        allItems = pickRes.items;
        allClaimed = pickRes.allClaimed;

        if (allItems.length > 0) {
            currentRewardItem = (camp.activeDropId ? allItems.find((i) => i.id === camp.activeDropId && !i._computedClaimed && !i._computedEnded) : null)
                || allItems.find((i) => !i._computedClaimed && !i._computedEnded)
                || allItems.find((i) => !i._computedClaimed)
                || allItems[allItems.length - 1];
        }
    }

    /* Every drop claimed, explicitly completed, or every remaining drop ended */
    const isExplicitCompleted = Boolean(camp.isCompleted || camp.status === "completed");
    const allEndedOrClaimed = allItems.length > 0 && allItems.every((i) => i._computedClaimed || i._computedEnded);
    const effectivelyClaimed = isExplicitCompleted || (allItems.length > 0 && allClaimed);
    if (isExplicitCompleted || (allItems.length > 0 && (allClaimed || allEndedOrClaimed))) {
        renderStatus(effectivelyClaimed
            ? {
                kind: "completed",
                pill: "Completed",
                title: `All drops for ${gameName} completed`,
                sub: `<strong>${gameEsc}</strong> &bull; all rewards claimed`,
                pct: 100,
                label: "100% (all rewards claimed)",
                toolbar: false,
                stop: true
            }
            : {
                kind: "ended",
                pill: "Ended",
                title: `All active drops for ${gameName} ended`,
                sub: `<strong>${gameEsc}</strong> &bull; campaign ended`,
                pct: 100,
                label: "Campaign closed",
                toolbar: false,
                stop: true
            });

        const tiles = allItems.map((item) => {
            const title = item.name || item.title || "Reward";
            const reqMins = item.reqTime || item.requiredMinutesWatched || 60;
            const ended = Boolean(item._computedEnded && !item._computedClaimed);
            return `
                <div class="completedRewardIconCard ${ended ? "endedIconCard" : ""}" title="${escapeHtml(title)} (${reqMins} min)${ended ? " - ended" : ""}">
                    ${thumbHtml(rewardImageOf(item), "completedThumb", "rewardGlyphBox miniGlyph", title)}
                    ${icon(ended ? "x" : "check")}
                    <span class="completedRewardLabel">${escapeHtml(title)}</span>
                </div>`;
        }).join("");

        setDetails(`
            <div class="allCompletedCardBox">
                <div>
                    <span class="completedTitle">${effectivelyClaimed ? `All running drops for ${gameEsc} completed` : `Drops for ${gameEsc} closed`}</span>
                    <span class="completedSub">${effectivelyClaimed ? "All rewards claimed and in your inventory." : "Every drop reached its scheduled end time."}</span>
                </div>
                ${allItems.length > 0 ? `<div class="completedGridRow">${tiles}</div>` : ""}
            </div>`);
        return;
    }

    /* In progress */
    const watching = Boolean(camp.curWatching);
    const curCampObj = chosenCamp || ((Array.isArray(active.campaigns) && active.campaigns.length > 0)
        ? (active.campaigns[camp.onCamp || 0] || active.campaigns[0])
        : null);
    const itemWatched = currentRewardItem ? (currentRewardItem._computedWatched || 0) : ((curCampObj && curCampObj.minutesWatched) || 0);
    const targetMins = currentRewardItem ? (currentRewardItem._computedReq || 60) : ((curCampObj && curCampObj.minutesNeeded) || 60);
    const minsLeft = Math.max(0, targetMins - itemWatched);
    const percent = Math.min(100, Math.round((itemWatched / Math.max(1, targetMins)) * 100));

    const isReadyToClaim = Boolean(currentRewardItem && currentRewardItem._computedReady);
    renderStatus({
        kind: watching ? "farming" : "searching",
        pill: watching ? `@${camp.curWatching}` : gameName,
        title: `Farming: ${gameName}`,
        sub: watching
            ? `Watching <a href="https://www.twitch.tv/${encodeURIComponent(camp.curWatching)}#atd-managed=1" id="focusFarmTab" class="streamerLink" title="Open this stream tab">@${escapeHtml(camp.curWatching)}${icon("external")}</a>`
            : `Finding a live drops stream for <strong>${gameEsc}</strong>…`,
        pct: percent,
        label: isReadyToClaim ? "Ready to claim" : `${percent}% (${itemWatched}/${targetMins} min)`,
        toolbar: watching,
        stop: true
    });
    const rewardName = currentRewardItem ? (currentRewardItem.name || currentRewardItem.title || `${gameName} drop reward`) : `${gameName} drop reward`;
    const rewardId = currentRewardItem ? (currentRewardItem.id || rewardName) : rewardName;
    const etaKey = `${gameName}|${rewardId}|${targetMins}`;
    if (watching && minsLeft > 0) {
        if (prevEta && prevEta.key === etaKey && prevEta.minsLeft === minsLeft) {
            etaState = prevEta;
        } else {
            etaState = { key: etaKey, minsLeft, at: Date.now() };
        }
    }

    const rewardImg = currentRewardItem ? rewardImageOf(currentRewardItem) : "";
    const activeEndDate = currentRewardItem
        ? (currentRewardItem.endAt || currentRewardItem.endsAt || (curCampObj && (curCampObj.endAt || curCampObj.endsAt)))
        : (curCampObj && (curCampObj.endAt || curCampObj.endsAt));
    const formattedEnd = activeEndDate ? formatDropEndDate(activeEndDate) : "";

    const curStreamers = (curCampObj && Array.isArray(curCampObj.streamers))
        ? curCampObj.streamers
        : (Array.isArray(camp.requiredStreamers) ? camp.requiredStreamers : []);
    const fallbackFrom = Array.isArray(camp.fallbackFromStreamers) ? camp.fallbackFromStreamers : [];
    let reqNote;
    if (camp.requirementType === "fallback_open" && fallbackFrom.length > 0) {
        const preview = fallbackFrom.slice(0, 2).map((s) => `@${escapeHtml(s)}`).join(", ");
        reqNote = `<span class="activeRewardNote success">Any drops stream (switched; ${preview} offline)</span>`;
    } else if (curStreamers.length > 0) {
        const preview = curStreamers.slice(0, 2).map((s) => `@${escapeHtml(s)}`).join(", ");
        const extra = curStreamers.length > 2 ? ` +${curStreamers.length - 2} more` : "";
        reqNote = `<span class="activeRewardNote accent">Specific channel (${preview}${extra})</span>`;
    } else {
        reqNote = `<span class="activeRewardNote">Any drops-enabled stream</span>`;
    }

    const etaLabel = etaState
        ? formatEtaFromState(etaState)
        : (minsLeft > 0 ? `~${minsLeft}m left` : "Ready to claim");

    setDetails(`
        <div class="activeRewardItem">
            ${thumbHtml(rewardImg, "activeRewardThumb", "rewardGlyphBox", rewardName)}
            <div class="activeRewardMeta">
                <span class="activeRewardTitle" title="${escapeHtml(rewardName)}">${escapeHtml(rewardName)}</span>
                <span class="activeRewardSub">${percent}% &bull; <span id="etaText">${etaLabel}</span></span>
                ${reqNote}
                ${formattedEnd ? `<span class="activeRewardNote">Ends ${escapeHtml(formattedEnd)}</span>` : ""}
            </div>
        </div>`);
}

/* ------------------------------------------------------- Rewards page list */
function syncNoticeActions() {
    return `<div class="noticeActions">
        <a href="https://www.twitch.tv/drops/campaigns" target="_blank" rel="noopener noreferrer" class="btn btnSm btnSecondary"><span>Twitch campaigns</span>${icon("external")}</a>
        <button type="button" class="btn btnSm syncDropsBtn">${icon("refresh")}<span>Sync</span></button>
    </div>`;
}

function renderActiveDropsList(activeStream) {
    const container = $("#allDrops").empty();

    if (!activeStream || activeStream === "none" || !activeStream.campaign || activeStream.campaign === "none") {
        container.html(`<p class="subText">No campaign selected. Choose a game on the Home tab.</p>`);
        return;
    }

    const camp = activeStream.campaign;
    const gameName = gameNameOf(camp, "Selected game");
    const gameEsc = escapeHtml(gameName);
    const effectiveNow = getEffectiveNow();
    const campaigns = Array.isArray(activeStream.campaigns) ? activeStream.campaigns : [];
    const anyFarmable = campaigns.some((c) => hasFarmableDrop(c, effectiveNow));

    const isExpired = Boolean(camp.endsAt && !isNaN(camp.endsAt) && effectiveNow >= camp.endsAt && !camp.isCompleted);
    if ((camp.status === "no_active_drops" || isExpired) && !anyFarmable) {
        container.html(noticeHtml({
            tone: "warn",
            iconName: "gift",
            center: true,
            title: isExpired ? `Campaign closed: ${gameEsc}` : `No active drops: ${gameEsc}`,
            desc: isExpired
                ? `The Twitch drop campaign for <strong>${gameEsc}</strong> reached its end time. Farming paused automatically.`
                : `Twitch has no active campaign for <strong>${gameEsc}</strong> right now. Rewards appear here automatically when one goes live.`,
            extra: syncNoticeActions()
        }));
        return;
    }

    if (camp.status === "nostream") {
        let curCamp = campaigns.length > 0 ? (campaigns[camp.onCamp || 0] || campaigns[0]) : null;
        if (campaigns.length > 1) {
            const farmable = campaigns.find((c) => hasFarmableDrop(c, effectiveNow));
            if (farmable) curCamp = farmable;
        }
        const anyOpen = campaigns.some((c) => {
            if (!c) return false;
            const cEnd = c.endsAt || (c.endAt ? new Date(c.endAt).getTime() : NaN);
            if (!isNaN(cEnd) && cEnd <= effectiveNow) return false;
            return !c.streamers || c.streamers.length === 0;
        });

        let required = [];
        if (!anyOpen) {
            if (Array.isArray(camp.requiredStreamers) && camp.requiredStreamers.length > 0) required = camp.requiredStreamers;
            else if (curCamp && Array.isArray(curCamp.streamers)) required = curCamp.streamers;
        }
        const hasSpecific = required.length > 0;
        const title = hasSpecific
            ? (required.length === 1 ? `${escapeHtml(required[0])} is offline` : "Required channels offline")
            : "No drops stream live";
        const desc = hasSpecific
            ? `This campaign requires <strong>${escapeHtml(required.join(", "))}</strong>, currently offline.`
            : `No broadcasters are streaming <strong>${gameEsc}</strong> with drops enabled right now.`;

        container.append(noticeHtml({
            tone: "warn",
            iconName: "clock",
            title,
            desc: `${desc} Farming resumes automatically when an eligible stream goes live.`,
            extra: hasSpecific ? chipsHtml("Required", required) : ""
        }));
    }

    const rewards = [];
    campaigns.forEach((campaignObj) => {
        if (!campaignObj) return;
        const dropList = campaignDrops(campaignObj);
        if (!Array.isArray(dropList)) return;
        dropList.forEach((drop, index) => {
            if (!drop) return;
            const minsNeeded = drop.reqTime || drop.minutesNeeded || drop.requiredMinutesWatched || campaignObj.minutesNeeded || 60;
            const minsWatched = (drop.self && drop.self.currentMinutesWatched !== undefined)
                ? drop.self.currentMinutesWatched
                : (campaignObj.minutesWatched || 0);
            const isClaimed = Boolean(drop.self && drop.self.isClaimed === true);
            const isReady = Boolean(!isClaimed && minsNeeded > 0 && minsWatched >= minsNeeded);
            const dropEnd = drop.endAt || drop.endsAt || campaignObj.endAt || campaignObj.endsAt || null;
            const endTs = dropEnd ? new Date(dropEnd).getTime() : null;
            const isEnded = Boolean(endTs && !isNaN(endTs) && endTs <= effectiveNow);

            let imgUrl = rewardImageOf(drop);
            if (Array.isArray(drop.benefitEdges) && drop.benefitEdges[0]) {
                const benefit = drop.benefitEdges[0].benefit || drop.benefitEdges[0].node;
                if (benefit && benefit.imageAssetURL) imgUrl = benefit.imageAssetURL;
            }

            rewards.push({
                title: drop.name || drop.title || `Reward #${index + 1}`,
                minsNeeded, minsWatched, isClaimed, isReady, isEnded, endAt: dropEnd, imgUrl
            });
        });
    });

    if (rewards.length === 0) {
        if (camp.isCompleted || camp.status === "completed") {
            container.html(noticeHtml({
                tone: "success",
                iconName: "check-circle",
                center: true,
                title: `All drops completed: ${gameEsc}`,
                desc: `All rewards for <strong>${gameEsc}</strong> have been claimed and added to your Twitch inventory.`
            }));
            return;
        }
        container.html(noticeHtml({
            tone: "warn",
            iconName: "gift",
            center: true,
            title: `No drops available: ${gameEsc}`,
            desc: `No drop rewards were found for <strong>${gameEsc}</strong>. Check Twitch campaigns or pick another game.`,
            extra: syncNoticeActions()
        }));
        return;
    }

    const priority = (r) => (r.isClaimed ? 1 : (r.isEnded ? 2 : 0));
    rewards.sort((a, b) => (priority(a) - priority(b)) || (a.minsNeeded - b.minsNeeded));

    rewards.forEach((r) => {
        let statusClass = "pendingBadge";
        let statusText;
        if (r.isClaimed) {
            statusClass = "claimedBadge";
            statusText = "Claimed";
        } else if (r.isReady) {
            statusClass = "readyBadge";
            statusText = "Ready to claim";
        } else if (r.isEnded) {
            statusClass = "endedBadge";
            statusText = "Ended";
        } else {
            const pct = Math.min(100, Math.round((r.minsWatched / Math.max(1, r.minsNeeded)) * 100));
            statusText = `${pct}% (${r.minsWatched}/${r.minsNeeded}m)`;
        }
        const endText = r.endAt ? formatDropEndDate(r.endAt) : "";
        const expired = r.isEnded && !r.isClaimed;

        container.append(`
            <div class="dropRewardCard ${r.isClaimed ? "isClaimedCard" : ""} ${expired ? "isEndedCard" : ""}">
                ${thumbHtml(r.imgUrl, "rewardImage", "rewardGlyphBox", r.title)}
                <div class="rewardInfo">
                    <span class="rewardName" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</span>
                    <span class="rewardTime">${r.minsNeeded} min required</span>
                    ${endText ? `<span class="rewardEndDate ${expired ? "rewardEndDateExpired" : ""}">Ends ${escapeHtml(endText)}</span>` : ""}
                </div>
                <span class="rewardBadge ${statusClass}">${statusText}</span>
            </div>
        `);
    });
}

function syncClaimedViewSeg() {
    $("#claimedViewSeg button").each((i, el) => {
        $(el).attr("aria-checked", $(el).data("claimed-view") === claimedViewMode ? "true" : "false");
    });
}

function claimedDropTimestamp(drop) {
    if (!drop || !drop.lastAwardedAt) return 0;
    const ts = Date.parse(drop.lastAwardedAt);
    return Number.isFinite(ts) ? ts : 0;
}

function compareClaimedDrops(a, b) {
    const diff = claimedDropTimestamp(b) - claimedDropTimestamp(a);
    if (diff !== 0) return diff;
    const nameA = (a && a.name) ? String(a.name) : "";
    const nameB = (b && b.name) ? String(b.name) : "";
    return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
}

function claimedDropRowHtml(drop, includeGame) {
    const name = drop.name || "Drop reward";
    const gameName = drop.game ? (drop.game.displayName || drop.game.name || "") : "";
    const timeAgo = drop.lastAwardedAt ? formatTimeAgo(new Date(drop.lastAwardedAt)) : "";
    const totalCount = Number(drop.totalCount) || 1;
    const countTag = totalCount > 1 ? `<span class="claimedCountTag" title="Claimed ${totalCount} times">x${totalCount}</span>` : "";
    const subParts = [];
    if (includeGame && gameName) subParts.push(escapeHtml(gameName));
    if (timeAgo) subParts.push(includeGame ? escapeHtml(timeAgo) : `Claimed ${escapeHtml(timeAgo)}`);
    const subText = subParts.join(" &bull; ") || "Claimed";

    return `
        <div class="claimedDropItem">
            ${thumbHtml(drop.imageURL, "claimedDropThumb", "claimedDropGlyph", name)}
            <div class="claimedDropMeta">
                <span class="claimedDropTitle" title="${escapeHtml(name)}">${escapeHtml(name)}${countTag}</span>
                <span class="claimedDropSub">${subText}</span>
            </div>
            <span class="claimedDropBadge">${icon("check")}Claimed</span>
        </div>
    `;
}

function renderClaimedInventory(claimedDrops) {
    loaded.claimed = true;
    const container = $("#claimedInventoryList");
    const countBadge = $("#claimedInventoryCountBadge");
    if (container.length === 0) return;

    const validDrops = Array.isArray(claimedDrops) ? claimedDrops.filter(Boolean) : [];
    if (validDrops.length === 0) {
        container.html(`<p class="subText">No claimed rewards found in your Twitch inventory yet.</p>`);
        countBadge.text("0 claimed");
        return;
    }

    const sorted = [...validDrops].sort(compareClaimedDrops);
    countBadge.text(`${sorted.length} claimed`);
    container.empty();

    if (claimedViewMode === "game") {
        const groupMap = new Map();
        sorted.forEach((drop) => {
            const rawGame = drop.game ? (drop.game.displayName || drop.game.name || "") : "";
            const displayGame = rawGame.trim() || "Other";
            const key = displayGame.toLowerCase();
            const ts = claimedDropTimestamp(drop);
            let group = groupMap.get(key);
            if (!group) {
                group = { game: displayGame, maxTs: ts, drops: [] };
                groupMap.set(key, group);
            }
            if (ts > group.maxTs) group.maxTs = ts;
            group.drops.push(drop);
        });

        const groups = Array.from(groupMap.values()).sort((a, b) => {
            if (b.maxTs !== a.maxTs) return b.maxTs - a.maxTs;
            return a.game.localeCompare(b.game, undefined, { sensitivity: "base" });
        });

        const openAll = groups.length <= 4;
        const html = groups.map((group, idx) => {
            const isOpen = openAll || idx < 3;
            const newestLabel = group.maxTs > 0 ? formatTimeAgo(new Date(group.maxTs)) : "";
            const rowsHtml = group.drops.map((d) => claimedDropRowHtml(d, false)).join("");
            return `
                <details class="claimedGameGroup"${isOpen ? " open" : ""}>
                    <summary class="claimedGameSummary">
                        ${icon("chevron-down", "claimedGroupChevron")}
                        <span class="claimedGroupName" title="${escapeHtml(group.game)}">${escapeHtml(group.game)}</span>
                        ${newestLabel ? `<span class="claimedGroupTime">${escapeHtml(newestLabel)}</span>` : ""}
                        <span class="pill claimedGroupCount">${group.drops.length}</span>
                    </summary>
                    <div class="claimedGroupItems">${rowsHtml}</div>
                </details>
            `;
        }).join("");
        container.html(html);
        return;
    }

    container.html(sorted.map((drop) => claimedDropRowHtml(drop, true)).join(""));
}

/* ------------------------------------------------------------------ queue */
function updateAutoGamesBadge(enabledCount, totalCount) {
    $("#autoGameCountBadge").text(`${Number(enabledCount) || 0} / ${Number(totalCount) || 0} queued`);
}

function queueIndexOf(list, game) {
    return list.findIndex((g) => areGameNamesMatching(g, game));
}

function populateAutoGamesGrid(data) {
    loaded.queue = true;
    const grid = $("#autoGamesList").empty();

    const allGames = (data && Array.isArray(data.activeDropGames)) ? data.activeDropGames
        : ((data && Array.isArray(data.allConnected)) ? data.allConnected
            : (Array.isArray(currentAutoGamesData.allConnected) ? currentAutoGamesData.allConnected : []));
    currentAutoGamesData.allConnected = allGames;

    const enabledList = (data && Array.isArray(data.autoDropGames)) ? data.autoDropGames
        : ((data && Array.isArray(data.enabled)) ? data.enabled
            : (Array.isArray(currentAutoGamesData.enabled) ? currentAutoGamesData.enabled : []));
    currentAutoGamesData.enabled = enabledList;

    const queued = enabledList
        .map((eg) => allGames.find((g) => areGameNamesMatching(eg, g)))
        .filter((g, i, arr) => g && arr.indexOf(g) === i);
    const rest = allGames.filter((g) => !queued.includes(g)).sort((a, b) => a.localeCompare(b));
    const ordered = [...queued, ...rest];

    updateAutoGamesBadge(queued.length, allGames.length);
    $("#startAutoQueueBtn").prop("disabled", queued.length === 0);

    if (ordered.length === 0) {
        grid.html(noticeHtml({
            tone: "",
            iconName: "gift",
            center: true,
            title: "No active drop campaigns",
            desc: "Only games with a live Twitch drop campaign appear here. New campaigns show up automatically."
        }));
        return;
    }

    ordered.forEach((gameName) => {
        const pos = queued.indexOf(gameName);
        const isQueued = pos >= 0;
        const g = escapeHtml(gameName);
        grid.append(`
            <div class="autoGameCard ${isQueued ? "activeQueueCard" : ""}" data-gamename="${escapeHtml(gameName.toLowerCase())}">
                <span class="queueOrder">${isQueued ? pos + 1 : "–"}</span>
                <div class="autoGameMeta">
                    <span class="autoGameName" title="${g}">${g}</span>
                    <span class="autoGameStatusTag">${isQueued ? (pos === 0 ? "Farming first" : `Queued #${pos + 1}`) : "Not queued"}</span>
                </div>
                ${isQueued ? `
                <div class="reorderBtns">
                    <button type="button" class="iconBtn moveUpBtn" data-game="${g}" title="Move up" aria-label="Move ${g} up"${pos === 0 ? " disabled" : ""}>${icon("arrow-up")}</button>
                    <button type="button" class="iconBtn moveDownBtn" data-game="${g}" title="Move down" aria-label="Move ${g} down"${pos === queued.length - 1 ? " disabled" : ""}>${icon("arrow-down")}</button>
                </div>` : ""}
                <label class="switch"><input type="checkbox" class="autoGameToggle" data-game="${g}" aria-label="Queue ${g}" ${isQueued ? "checked" : ""}><span class="slider"></span></label>
            </div>
        `);
    });

    filterAutoGamesGrid($("#autoGameSearchInput").val());
}

function filterAutoGamesGrid(query) {
    const q = query ? String(query).toLowerCase().trim() : "";
    $(".autoGameCard").each((i, el) => {
        const name = $(el).attr("data-gamename") || "";
        $(el).toggleClass("hidden", !name.includes(q));
    });
}

async function commitQueue(games, okMessage) {
    currentAutoGamesData.enabled = games;
    populateAutoGamesGrid(currentAutoGamesData);
    const res = await request("p:setAutoDropGames", { games });
    if (isFailed(res)) {
        showToast(errorText(res, "Could not update the queue"), "error");
        loadQueue();
        return false;
    }
    if (okMessage) showToast(okMessage, "success");
    return true;
}

async function toggleQueueGame(game, checked) {
    const cur = Array.isArray(currentAutoGamesData.enabled) ? currentAutoGamesData.enabled : [];
    currentAutoGamesData.enabled = checked
        ? (queueIndexOf(cur, game) >= 0 ? cur : [...cur, game])
        : cur.filter((g) => !areGameNamesMatching(g, game));
    populateAutoGamesGrid(currentAutoGamesData);
    const res = await request("toggleAutoDropGame", [game, checked]);
    if (isFailed(res)) {
        showToast(errorText(res, "Could not update the queue"), "error");
        loadQueue();
        return;
    }
    showToast(checked ? `Added ${game} to the queue` : `Removed ${game} from the queue`, "success");
}

function moveQueueGame(game, delta) {
    const all = currentAutoGamesData.allConnected || [];
    const queued = (currentAutoGamesData.enabled || [])
        .map((eg) => all.find((g) => areGameNamesMatching(eg, g)) || eg)
        .filter((g, i, arr) => arr.indexOf(g) === i);
    const i = queued.findIndex((g) => areGameNamesMatching(g, game));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= queued.length) return;
    [queued[i], queued[j]] = [queued[j], queued[i]];
    commitQueue(queued);
}

/* ------------------------------------------------------------ actions */
async function syncRewards() {
    const btn = $("#refreshRewardsBtn").prop("disabled", true);
    const ok = await loadDrops();
    btn.prop("disabled", false);
    showToast(ok ? "Rewards synced with Twitch" : "Sync failed", ok ? "success" : "error");
}

async function startAutoQueue() {
    const queuedCount = Array.isArray(currentAutoGamesData.enabled) ? currentAutoGamesData.enabled.length : 0;
    if (queuedCount === 0) {
        showToast("Queue at least one game first", "info");
        return;
    }
    const btn = $("#startAutoQueueBtn").prop("disabled", true);
    const res = await request("p:startAutoQueue");
    btn.prop("disabled", false);
    if (isFailed(res) || (res && res.success === false)) {
        showToast(errorText(res, "Could not start the queue"), "error");
        return;
    }
    showToast("Queue started. Finding live streams…", "success");
    activatePage("mainPage");
    setTimeout(loadDrops, 800);
}

async function manualClaim() {
    if (!extEnabled) return;
    const btn = $("#manualClaimBtn").prop("disabled", true);
    btn.find("span").text("Checking…");
    const res = await request("p:claimDrop");
    btn.find("span").text("Claim now");
    btn.prop("disabled", false);
    if (isFailed(res)) {
        showToast(errorText(res, "Claim check failed"), "error");
        return;
    }
    markChecked();
    showToast("Checked for claimable drops", "success");
    setTimeout(loadDrops, 800);
}

async function checkForUpdates() {
    const btn = $("#checkUpdateBtn").prop("disabled", true);
    const label = $("#checkUpdateBtnText").text("Checking…");
    const res = await request("p:checkUpdate");
    btn.prop("disabled", false);
    label.text("Check for updates");
    if (!res || isFailed(res) || res.ok === false) {
        showToast(errorText(res, "Unable to reach GitHub"), "error");
        return;
    }
    const p = payloadOf(res);
    updateBannerDismissed = false;
    renderUpdateInfo(p);
    if (p.updateAvailable) showToast(`Update available: v${p.latestVersion}`, "info");
    else showToast(`You are up to date (v${p.currentVersion || maniData.version})`, "success");
}

function historyAsText() {
    return lastHistory.map((i) => {
        const when = i.timestamp ? new Date(i.timestamp).toLocaleString() : "";
        return `${when}\t${i.game || "Twitch"}\t${i.title || "Reward claimed"}`;
    }).join("\n");
}

async function clearHistory() {
    const btn = $("#clearHistoryBtn");
    if (!btn.hasClass("confirming")) {
        btn.addClass("confirming btnDanger").find("span").text("Sure?");
        clearTimeout(clearConfirmTimer);
        clearConfirmTimer = setTimeout(resetClearButton, 3000);
        return;
    }
    resetClearButton();
    const res = await request("clearActivityHistory");
    if (isFailed(res)) {
        showToast(errorText(res, "Could not clear history"), "error");
        return;
    }
    renderActivityHistory([]);
    showToast("Claim history cleared", "success");
}

function resetClearButton() {
    clearTimeout(clearConfirmTimer);
    $("#clearHistoryBtn").removeClass("confirming btnDanger").find("span").text("Clear");
}

/* ---------------------------------------------------------------- init */
$(() => {
    $("#extVersion").text(`v${maniData.version || "2.0.0"}`);
    $("#currentVerDisplay").text(`v${maniData.version || "2.0.0"}`);
    if (lsGet("atd.queueHintDismissed") === "1") $("#queueHint").prop("hidden", true);
    claimedViewMode = lsGet("atd-claimed-view") === "game" ? "game" : "recent";
    syncClaimedViewSeg();
    syncSettingsToDom();
    renderStatus({ kind: "idle", pill: "Idle", title: "Ready and monitoring", sub: "Pick a game below or add games to the Queue.", pct: 0, label: "0%", toolbar: false, stop: false });
    showPage("mainPage");

    if (HAS_STORAGE) {
        chrome.storage.local.get([
            "exEnabled", "settings", "extStats", "activityHistory", "autoDropGames", "activeDropGames",
            "listOfConnected", "activeStream", "authState", "claimedInventory", "githubUpdate", "twitchServerTimeOffset"
        ]).then((val) => {
            val = val || {};
            if (typeof val.twitchServerTimeOffset === "number" && !Number.isNaN(val.twitchServerTimeOffset)) {
                twitchServerTimeOffset = val.twitchServerTimeOffset;
            }
            if (val.settings && typeof val.settings === "object") {
                settings = { ...DEFAULT_SETTINGS, ...val.settings };
            }
            syncSettingsToDom();

            if (val.extStats) updateStatsUI(val.extStats);
            if (Array.isArray(val.activityHistory)) renderActivityHistory(val.activityHistory);
            if (Array.isArray(val.claimedInventory)) {
                currentClaimedInventory = val.claimedInventory;
                renderClaimedInventory(currentClaimedInventory);
            }
            if (settings.showAllGames !== false && Array.isArray(val.listOfConnected) && val.listOfConnected.length > 0) {
                populateGameDropdown(val.listOfConnected.map((g) => ({ game: { displayName: g } })));
            } else {
                populateGameDropdown([]);
            }
            if (Array.isArray(val.activeDropGames) && val.activeDropGames.length > 0) {
                currentAutoGamesData.allConnected = val.activeDropGames;
            }
            if (Array.isArray(val.autoDropGames)) {
                currentAutoGamesData.enabled = val.autoDropGames;
                populateAutoGamesGrid(currentAutoGamesData);
            }
            currentActiveStream = normalizeStream(val.activeStream);
            if (currentActiveStream) renderActiveDropsList(currentActiveStream);
            if (val.githubUpdate) renderUpdateInfo(val.githubUpdate);
            if (val.authState && typeof val.authState === "object") lastAuthState = val.authState;

            applyEnabledState(val.exEnabled !== undefined ? Boolean(val.exEnabled) : true, { restore: true });
            if (extEnabled) {
                renderAuth(lastAuthState);
                refreshAll();
                startTicker();
            } else {
                loadActivity();
                loadUpdateState();
            }
        }).catch(() => {
            showToast("Could not read saved state", "error");
        });
    } else {
        populateGameDropdown([]);
    }

    /* Tickers pause while the popup is hidden */
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopTicker();
        else if (extEnabled) { startTicker(); loadDrops(); }
    });
    window.addEventListener("pagehide", stopTicker);

    /* ------------------------------------------- reactive storage sync */
    if (HAS_STORAGE && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName && areaName !== "local") return;
            if (!changes || typeof changes !== "object") return;

            if (changes.twitchServerTimeOffset && typeof changes.twitchServerTimeOffset.newValue === "number" && !Number.isNaN(changes.twitchServerTimeOffset.newValue)) {
                twitchServerTimeOffset = changes.twitchServerTimeOffset.newValue;
            }
            if (changes.exEnabled !== undefined) {
                const next = changes.exEnabled.newValue !== undefined ? Boolean(changes.exEnabled.newValue) : true;
                if (next !== extEnabled) {
                    applyEnabledState(next);
                    if (next) startTicker(); else stopTicker();
                }
            }
            if (changes.settings && changes.settings.newValue && typeof changes.settings.newValue === "object") {
                const prevShowAll = settings.showAllGames;
                settings = { ...DEFAULT_SETTINGS, ...settings, ...changes.settings.newValue };
                syncSettingsToDom();
                if (prevShowAll !== settings.showAllGames) rebuildGameDropdown();
            }
            if (changes.extStats && changes.extStats.newValue) updateStatsUI(changes.extStats.newValue);
            if (changes.activityHistory && Array.isArray(changes.activityHistory.newValue)) renderActivityHistory(changes.activityHistory.newValue);
            if (changes.activeDropGames && Array.isArray(changes.activeDropGames.newValue)) {
                currentAutoGamesData.allConnected = changes.activeDropGames.newValue;
                populateAutoGamesGrid(currentAutoGamesData);
            }
            if (changes.autoDropGames && Array.isArray(changes.autoDropGames.newValue)) {
                currentAutoGamesData.enabled = changes.autoDropGames.newValue;
                populateAutoGamesGrid(currentAutoGamesData);
            }
            if (changes.activeStream) {
                currentActiveStream = normalizeStream(changes.activeStream.newValue);
                updateDropProgressUI({ activeStream: currentActiveStream });
                renderActiveDropsList(currentActiveStream);
                markChecked();
            }
            if (changes.claimedInventory && Array.isArray(changes.claimedInventory.newValue)) {
                currentClaimedInventory = changes.claimedInventory.newValue;
                renderClaimedInventory(currentClaimedInventory);
            }
            if (changes.authState) {
                if (changes.authState.newValue) renderAuth(changes.authState.newValue);
            }
            if (changes.githubUpdate && changes.githubUpdate.newValue) renderUpdateInfo(changes.githubUpdate.newValue);
        });
    }

    /* ------------------------------------------ background broadcasts */
    if (HAS_RUNTIME && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((message) => {
            if (!message || typeof message !== "object") return;
            switch (message.type) {
                case "p:connectedGames":
                    if (Array.isArray(message.data)) populateGameDropdown(message.data);
                    break;
                case "p:sendCurrentDrops":
                    if (message.data && typeof message.data === "object") applyDrops({ activeStream: message.data.activeStream, claimedInventory: message.data.claimedInventory });
                    markChecked();
                    break;
                case "setAutoDropGames":
                    if (message.data) {
                        currentAutoGamesData = { allConnected: message.data.allConnected || message.data.activeDropGames || currentAutoGamesData.allConnected, enabled: message.data.enabled || message.data.autoDropGames || currentAutoGamesData.enabled };
                        populateAutoGamesGrid(currentAutoGamesData);
                    }
                    break;
                case "p:statsUpdated":
                    updateStatsUI(message.data);
                    markChecked();
                    break;
                case "p:activityUpdated":
                    renderActivityHistory(message.data);
                    break;
                case "p:rewardClaimedSound":
                    if (settings.soundOnClaim) playClaimChime();
                    break;
                case "p:authStateChanged":
                    if (message.data && typeof message.data === "object") renderAuth(message.data);
                    else checkAuthStatus();
                    break;
                default:
                    break;
            }
        });
    }

    /* ------------------------------------------------------------ tabs */
    $("#topNav").on("click", ".navItem", (e) => activatePage($(e.currentTarget).data("page")));
    $("#topNav").on("keydown", ".navItem", (e) => {
        const tabs = $("#topNav .navItem");
        const i = tabs.index(e.currentTarget);
        let next = -1;
        if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabs.length - 1;
        if (next >= 0) {
            e.preventDefault();
            tabs.eq(next).trigger("focus").trigger("click");
        }
    });

    /* --------------------------------------------------- master switch */
    $(".enableEx").on("change", async (e) => {
        const enabled = $(e.target).prop("checked");
        applyEnabledState(enabled);
        if (HAS_STORAGE) chrome.storage.local.set({ exEnabled: enabled }).catch(() => {});
        const res = await request("toggleExt", enabled);
        if (isFailed(res)) showToast(errorText(res, "Background did not respond"), "error");
        if (enabled) {
            refreshAll();
            startTicker();
            showToast("Extension enabled", "success");
        } else {
            stopTicker();
            showToast("Extension paused", "info");
        }
    });

    /* ---------------------------------------------------------- settings */
    Object.keys(SETTINGS_BINDINGS).forEach((key) => {
        $(SETTINGS_BINDINGS[key]).on("change", (e) => {
            settings[key] = e.target.checked;
            persistSettings(key);
            showToast("Setting saved", "success");
        });
    });
    $("#themeSeg").on("click", "button", (e) => {
        settings.theme = $(e.currentTarget).data("theme-val");
        applyTheme(settings.theme);
        persistSettings("theme");
    });

    /* ----------------------------------------------------- game picker */
    $("#selGame").on("click", () => {
        if (!extEnabled) return;
        setDropdownOpen(!gameSelectOpen);
    });
    $("#selGame").on("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!gameSelectOpen) setDropdownOpen(true);
        }
    });
    $("#gameSearchInput").on("input", (e) => filterDropdownItems($(e.target).val().toLowerCase().trim()));
    $("#gameSearchInput").on("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); moveDropdownActive(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); moveDropdownActive(-1); }
        else if (e.key === "Enter") {
            e.preventDefault();
            const items = $("#gameDropdownItems li.dropdownItemRow");
            const target = dropdownActiveIndex >= 0 ? items.eq(dropdownActiveIndex) : (items.length === 1 ? items.eq(0) : $());
            if (target.length) selectGame(target.attr("data-game"));
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDropdownOpen(false);
            $("#selGame").trigger("focus");
        }
    });
    $("#clearSearchBtn").on("click", (e) => {
        e.stopPropagation();
        $("#gameSearchInput").val("").trigger("focus");
        filterDropdownItems("");
    });
    $(document).on("click", "#gameDropdownItems li.dropdownItemRow", (e) => selectGame($(e.currentTarget).attr("data-game")));
    $(document).on("click", (e) => {
        if (gameSelectOpen && !$(e.target).closest(".customSelectWrapper").length) setDropdownOpen(false);
    });

    /* --------------------------------------------------- home controls */
    $("#skipStreamerBtn").on("click", async () => {
        const btn = $("#skipStreamerBtn").prop("disabled", true);
        const res = await request("p:skipStreamer");
        if (isFailed(res)) showToast(errorText(res, "Could not switch channel"), "error");
        else showToast("Switching to the next live channel", "info");
        setTimeout(() => { btn.prop("disabled", false); loadDrops(); }, 2000);
    });
    $("#reloadStreamBtn").on("click", async () => {
        const res = await request("p:reloadStream");
        const failed = isFailed(res) || (res && res.pulsed === false);
        showToast(failed ? errorText(res, "Heartbeat failed") : "Watch heartbeat sent", failed ? "error" : "success");
    });
    $("#focusStreamTabBtn").on("click", () => request("p:focusStreamTab"));
    $(document).on("click", "#focusFarmTab", (e) => {
        e.preventDefault();
        request("p:focusStreamTab");
    });
    $("#stopCampaignBtn").on("click", async () => {
        if (!extEnabled) return;
        const btn = $("#stopCampaignBtn").prop("disabled", true);
        const res = await request("p:startCampaign", { campaign: "none" });
        btn.prop("disabled", false);
        if (isFailed(res)) {
            showToast(errorText(res, "Could not stop farming"), "error");
            return;
        }
        currentActiveStream = null;
        updateDropProgressUI({ activeStream: null });
        renderActiveDropsList(null);
        showToast("Farming stopped", "info");
    });
    $("#manualClaimBtn").on("click", manualClaim);

    /* -------------------------------------------------------- rewards */
    $("#openTwitchInventoryBtn").on("click", () => {
        const url = "https://www.twitch.tv/drops/inventory";
        if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url, active: true });
        else window.open(url, "_blank", "noopener");
    });
    $(document).on("click", "#refreshRewardsBtn, .syncDropsBtn", syncRewards);
    $("#claimedViewSeg").on("click", "button", (e) => {
        const mode = $(e.currentTarget).data("claimed-view");
        if (mode !== "recent" && mode !== "game") return;
        claimedViewMode = mode;
        lsSet("atd-claimed-view", claimedViewMode);
        syncClaimedViewSeg();
        renderClaimedInventory(currentClaimedInventory);
    });
    $(document).on("click", ".retryBtn", (e) => {
        const key = $(e.currentTarget).data("retry");
        if (key === "queue") loadQueue();
        else if (key === "activity") loadActivity();
        else loadDrops();
    });

    /* ---------------------------------------------------------- queue */
    $("#queueHintDismiss").on("click", () => {
        $("#queueHint").prop("hidden", true);
        lsSet("atd.queueHintDismissed", "1");
    });
    $("#autoGameSearchInput").on("input", (e) => filterAutoGamesGrid($(e.target).val()));
    $("#startAutoQueueBtn").on("click", startAutoQueue);
    $("#autoGameSelectAllBtn").on("click", () => {
        const all = currentAutoGamesData.allConnected || [];
        if (all.length === 0) return;
        const cur = (currentAutoGamesData.enabled || []).filter((eg) => all.some((g) => areGameNamesMatching(eg, g)));
        const extra = all.filter((g) => queueIndexOf(cur, g) < 0);
        commitQueue([...cur, ...extra], "All active games queued");
    });
    $("#autoGameDeselectAllBtn").on("click", () => commitQueue([], "Queue cleared"));
    $(document).on("change", ".autoGameToggle", (e) => toggleQueueGame($(e.target).attr("data-game"), e.target.checked));
    $(document).on("click", ".moveUpBtn", (e) => moveQueueGame($(e.currentTarget).attr("data-game"), -1));
    $(document).on("click", ".moveDownBtn", (e) => moveQueueGame($(e.currentTarget).attr("data-game"), 1));

    /* ------------------------------------------------------- activity */
    $("#clearHistoryBtn").on("click", clearHistory);
    $("#copyHistoryBtn").on("click", () => {
        if (lastHistory.length === 0) return;
        copyText(historyAsText(), "History copied");
    });

    /* ------------------------------------------------ banners / update */
    $("#authDismissBtn").on("click", () => {
        authDismissedFor = $("#authStatusBanner").data("key") || "dismissed";
        $("#authStatusBanner").prop("hidden", true);
    });
    $("#dismissUpdateBannerBtn").on("click", () => {
        updateBannerDismissed = true;
        $("#githubUpdateBanner").prop("hidden", true);
    });
    $("#checkUpdateBtn").on("click", checkForUpdates);
    $("#copyGitPullBtn").on("click", () => copyText("git pull origin main", "Copied: git pull origin main"));
});
