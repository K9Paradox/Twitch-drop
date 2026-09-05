// Auto Twitch Drops Pro - Content Script (inject.js)

const injectIntervals = [];

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
                if (dropData.type === "streamPlaybackStarted") {
                    chrome.runtime.sendMessage({ type: "streamPlaybackStarted" }).catch(() => {});
                }
                if (dropData.type === "gqlOperation" || dropData.type === "sessionContext") {
                    chrome.runtime.sendMessage({
                        type: "gqlOperation",
                        operation: dropData.operation,
                        data: dropData.data || dropData.session
                    }).catch(() => {});
                }
            } else if (e.data.autoTwitchBrowserExtension && e.data.autoTwitchBrowserExtension.integrity) {
                chrome.runtime.sendMessage({ type: "sendInteg", data: e.data.autoTwitchBrowserExtension.integrity }).catch(() => {});
            }
        });

        // Listen for runtime messages from background/popup
        if (chrome.runtime?.onMessage) {
            chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
                if (msg && msg.type === "setTabAudio") {
                    window.postMessage({
                        autoTwitchDrops: {
                            type: "setTabAudio",
                            muted: msg.muted
                        }
                    }, "*");
                }
            });
        }

        // Listen for storage changes and forward settings to in-page scripts
        if (chrome.storage?.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === "local" && changes.settings && changes.settings.newValue) {
                    window.postMessage({
                        autoTwitchDrops: {
                            type: "settingsChanged",
                            settings: changes.settings.newValue
                        }
                    }, "*");
                }
            });
        }

        let isFarmMode = window.location.hash.includes("atd-managed=1");

        if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
            chrome.runtime.onMessage.addListener((message) => {
                if (message && message.type === "farmMode") {
                    isFarmMode = Boolean(message.enabled);
                    window.postMessage({
                        autoTwitchDrops: {
                            type: "farmMode",
                            enabled: isFarmMode
                        }
                    }, "*");
                    if (isFarmMode) {
                        updateTabTitleIndicator();
                        injectFloatingBadge();
                    } else {
                        const badge = document.getElementById("atd-pro-indicator");
                        if (badge) badge.remove();
                    }
                }
            });
        }

        // Add Tab Title Prefix indicator only for managed farm tabs
        function updateTabTitleIndicator() {
            if (!isFarmMode) return;
            if (document.title && !document.title.startsWith("[⚡ ATD Pro]")) {
                document.title = `[⚡ ATD Pro] ${document.title}`;
            }
        }
        const titleInterval = setInterval(updateTabTitleIndicator, 3000);
        injectIntervals.push(titleInterval);
        if (isFarmMode) {
            setTimeout(updateTabTitleIndicator, 1000);
        }

        // Inject in-page floating glassmorphic badge only for managed farm tabs
        function injectFloatingBadge() {
            if (!isFarmMode) return;
            if (document.getElementById("atd-pro-indicator")) return;
            const badge = document.createElement("div");
            badge.id = "atd-pro-indicator";
            badge.innerHTML = `
                <div style="
                    position: fixed;
                    bottom: 18px;
                    right: 18px;
                    z-index: 999999;
                    background: rgba(24, 24, 27, 0.92);
                    backdrop-filter: blur(8px);
                    border: 1px solid #9146FF;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.6), 0 0 10px rgba(145, 70, 255, 0.35);
                    border-radius: 20px;
                    padding: 6px 12px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 11px;
                    font-weight: 700;
                    color: #efeff1;
                    user-select: none;
                    cursor: default;
                    transition: transform 0.2s ease, opacity 0.2s ease;
                ">
                    <span style="
                        width: 7px;
                        height: 7px;
                        border-radius: 50%;
                        background-color: #00F59B;
                        box-shadow: 0 0 6px #00F59B;
                        display: inline-block;
                    "></span>
                    <span>⚡ Auto Drops Pro Active</span>
                </div>
            `;
            document.body.appendChild(badge);
        }

        if (isFarmMode) {
            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", injectFloatingBadge);
            } else {
                injectFloatingBadge();
            }
        }

        injectScript("onPage.js");

        window.addEventListener("beforeunload", () => {
            injectIntervals.forEach(id => clearInterval(id));
            injectIntervals.length = 0;
        });
    }
}).catch(() => {});

function syncClientAuth() {
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
        } catch (err) {}

        let uuid = "";
        try {
            const rawUuid = localStorage.getItem("local_storage_app_session_id");
            if (rawUuid) {
                const parsed = JSON.parse(rawUuid);
                if (parsed && parsed.session_id) uuid = parsed.session_id;
            }
        } catch (err) {}

        if (authToken || deviceId) {
            chrome.runtime.sendMessage({
                type: "clientInfo",
                data: {
                    oauthToken: authToken,
                    deviceId: deviceId,
                    userId: userId,
                    uuid: uuid
                }
            }).catch(() => {});
        }
    } catch (e) {}
}

syncClientAuth();
setTimeout(syncClientAuth, 1000);
setTimeout(syncClientAuth, 3000);

function getCookieValue(cookieName) {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (let c of cookies) {
        const [name, val] = c.split("=");
        if (name === cookieName) return val;
    }
    return "";
}

function injectScript(src) {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(src);
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
}