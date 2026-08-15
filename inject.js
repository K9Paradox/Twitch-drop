// Auto Twitch Drops Pro - Content Script (inject.js)

chrome.storage.local.get(["exEnabled"]).then((val) => {
    const isEnabled = val.exEnabled !== undefined ? val.exEnabled : true;
    if (isEnabled) {
        window.addEventListener("message", (e) => {
            if (!e.data || !chrome.runtime?.id) return;
            if (e.data.autoTwitchDrops) {
                const dropData = e.data.autoTwitchDrops;
                if (dropData.type === "integ") {
                    chrome.runtime.sendMessage({ type: "sendInteg", data: dropData.integrity }).catch(() => {});
                }
                if (dropData.type === "claim-points") {
                    chrome.runtime.sendMessage({ type: "claim-points", data: dropData }).catch(() => {});
                }
                if (dropData.type === "checkDrop") {
                    chrome.runtime.sendMessage({ type: "claim-drop", data: dropData }).catch(() => {});
                }
                if (dropData.type === "points-earned") {
                    chrome.runtime.sendMessage({ type: "points-earned", data: dropData }).catch(() => {});
                }
            } else if (e.data.autoTwitchBrowserExtension && e.data.autoTwitchBrowserExtension.integrity) {
                chrome.runtime.sendMessage({ type: "sendInteg", data: e.data.autoTwitchBrowserExtension.integrity }).catch(() => {});
            }
        });

        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message && message.type === "setFavicon") {
                const fav1 = document.querySelector("link[rel~='icon'][sizes~='32x32']");
                if (fav1) fav1.href = chrome.runtime.getURL("/assets/img/atd-32.png");
                const fav2 = document.querySelector("link[rel~='icon'][sizes~='16x16']");
                if (fav2) fav2.href = chrome.runtime.getURL("/assets/img/atd-16.png");
            }
        });

        injectScript("onPage.js");
    }
}).catch(() => {});

setTimeout(() => {
    try {
        if (!chrome.runtime?.id) return;
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
            chrome.runtime.sendMessage({
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