let dropPool = {};
let onPageInjected = false;

// Registered synchronously at document_start so freshly opened farming tabs
// can always receive commands from the background worker, even before storage
// resolves. This bridge relays background commands into the page context.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;
    if (message.type === "farmMode") {
        window.postMessage({ autoTwitchDrops: { type: "farmMode", enabled: !!message.enabled } }, "*");
    } else if (message.type === "setFavicon") {
        const fav1 = document.querySelector("link[rel~='icon'][sizes~='32x32']");
        if (fav1) fav1.href = chrome.runtime.getURL("/assets/img/twitch-logo-yellow-32.png");
        const fav2 = document.querySelector("link[rel~='icon'][sizes~='16x16']");
        if (fav2) fav2.href = chrome.runtime.getURL("/assets/img/twitch-logo-yellow-16.png");
        const btn = document.querySelector(".startDropsBtn");
        if (btn) btn.remove();
    }
});

chrome.storage.local.get(["exEnabled"]).then((val) => {
    // Default to true if not set
    const isEnabled = val.exEnabled !== undefined ? val.exEnabled : true;
    if (isEnabled) {
        attachPageChannel();
        injectOnPage();
    }
}).catch(() => {});

// If the extension gets enabled after this page already loaded, inject the
// page script on the fly instead of requiring a manual refresh.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.exEnabled) return;
    if (changes.exEnabled.newValue === true) {
        attachPageChannel();
        injectOnPage();
    } else if (changes.exEnabled.newValue === false) {
        window.postMessage({ autoTwitchDrops: { type: "farmMode", enabled: false } }, "*");
    }
});

function attachPageChannel() {
    if (attachPageChannel._done) return;
    attachPageChannel._done = true;

    window.addEventListener("message", (e) => {
        if (!e.data) return;
        if (e.data.autoTwitchDrops) {
            const dropData = e.data.autoTwitchDrops;
            if (dropData.type === "integ") {
                chrome.runtime.sendMessage(chrome.runtime.id, { type: "sendInteg", data: dropData.integrity }).catch(() => {});
            }
            if (dropData.type === "claim-points") {
                chrome.runtime.sendMessage(chrome.runtime.id, { type: "claim-points", data: dropData }).catch(() => {});
            }
            if (dropData.type === "checkDrop") {
                chrome.runtime.sendMessage(chrome.runtime.id, { type: "claim-drop", data: dropData }).catch(() => {});
            }
            if (dropData.type === "points-earned") {
                chrome.runtime.sendMessage(chrome.runtime.id, { type: "points-earned", data: dropData }).catch(() => {});
            }
        } else if (e.data.autoTwitchBrowserExtension && e.data.autoTwitchBrowserExtension.integrity) {
            chrome.runtime.sendMessage(chrome.runtime.id, { type: "sendInteg", data: e.data.autoTwitchBrowserExtension.integrity }).catch(() => {});
        }
    });
}

function injectOnPage() {
    if (onPageInjected) return;
    onPageInjected = true;
    injectScript("onPage.js");
}

setTimeout(() => {
    try {
        const authToken = getCookieValue("auth-token");
        const deviceId = getCookieValue("unique_id");

        let userId = "";
        try {
            const history = localStorage.getItem("searchSuggestionHistory");
            if (history) {
                const parsed = JSON.parse(history);
                if (parsed && parsed.id) userId = parsed.id;
            }
        } catch (err) {
            console.warn("Could not read searchSuggestionHistory from localStorage", err);
        }

        let uuid = "";
        try {
            const rawUuid = localStorage.getItem("local_storage_app_session_id");
            if (rawUuid) {
                uuid = rawUuid.replace(/"/g, '');
            }
        } catch (err) {
            console.warn("Could not read local_storage_app_session_id from localStorage", err);
        }

        if (authToken || deviceId) {
            chrome.runtime.sendMessage(chrome.runtime.id, {
                type: "clientInfo",
                data: {
                    oauthToken: authToken,
                    userId: userId,
                    deviceId: deviceId,
                    uuid: uuid
                }
            }).catch(() => {});
        }
    } catch (e) {
        console.error("Error sending clientInfo in inject.js:", e);
    }
}, 1000);

function getCookieValue(name) {
    const regex = new RegExp(`(^| )${name}=([^;]+)`);
    const match = document.cookie.match(regex);
    return match ? match[2] : null;
}

function injectScript(src) {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL(src);
    s.type = "module";
    s.onload = () => s.remove();
    (document.head || document.documentElement).append(s);
}
