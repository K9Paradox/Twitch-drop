let extEnabledState = true;
let autoClaimPointsState = true;

function broadcastConfigToPage() {
    try {
        window.postMessage({
            autoTwitchDropsConfig: {
                enabled: extEnabledState,
                autoClaimPoints: autoClaimPointsState
            }
        }, "*");
    } catch (e) {}
}

try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["exEnabled", "settings"]).then((val) => {
            if (val && typeof val.exEnabled === "boolean") {
                extEnabledState = val.exEnabled;
            }
            if (val && val.settings && typeof val.settings.autoClaimPoints === "boolean") {
                autoClaimPointsState = val.settings.autoClaimPoints;
            }
            broadcastConfigToPage();
        }).catch(() => {});
    }
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local" || !changes) return;
            if (changes.exEnabled && typeof changes.exEnabled.newValue === "boolean") {
                extEnabledState = changes.exEnabled.newValue;
            }
            if (changes.settings && changes.settings.newValue && typeof changes.settings.newValue.autoClaimPoints === "boolean") {
                autoClaimPointsState = changes.settings.newValue.autoClaimPoints;
            }
            broadcastConfigToPage();
        });
    }
} catch (e) {}

// Forward in-page events from onPage.js to background service worker
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || typeof event.data !== "object") return;

    const atd = event.data.autoTwitchDrops;
    if (atd && typeof atd === "object" && atd.type) {
        if (!extEnabledState && atd.type !== "sendInteg" && atd.type !== "user") {
            return;
        }
        try {
            chrome.runtime.sendMessage({
                type: atd.type,
                data: atd.data !== undefined ? atd.data : atd,
                operation: atd.operation
            }).catch(() => {});
        } catch (e) {}
    }
}, false);

function injectScript(file_path) {
    try {
        const script = document.createElement('script');
        script.setAttribute('type', 'text/javascript');
        script.setAttribute('src', chrome.runtime.getURL(file_path));
        script.onload = () => {
            broadcastConfigToPage();
        };
        const target = document.head || document.documentElement;
        if (target) {
            target.appendChild(script);
        }
    } catch (e) {}
}

injectScript("onPage.js");

function syncClientAuth() {
    try {
        if (!document.body) return;
        const scripts = Array.from(document.body.querySelectorAll("script"));
        const targetScript = scripts.find(a => a.innerHTML && a.innerHTML.includes("clientId="));
        if (!targetScript) return;

        const clientId = targetScript.innerHTML.split('clientId="')[1]?.split('"')[0];
        const uniqueId = document.cookie.split("unique_id=")[1]?.split(";")[0];
        const authToken = document.cookie.split("auth-token=")[1]?.split(";")[0];

        if (clientId && (uniqueId || authToken)) {
            chrome.runtime.sendMessage({
                type: "user",
                id: clientId,
                uniq: uniqueId,
                auth: authToken
            }).catch(() => {});
        }
    } catch (e) {}
}

if (document.readyState === "loading") {
    window.addEventListener('DOMContentLoaded', syncClientAuth);
} else {
    syncClientAuth();
}
