let extEnabledState = true;
let autoClaimPointsState = true;
let configHydrated = false;

function getSafeTargetOrigin() {
    try {
        if (typeof window !== "undefined" && window.location && window.location.origin && window.location.origin !== "null") {
            return window.location.origin;
        }
    } catch (e) {}
    return "*";
}

function broadcastConfigToPage() {
    try {
        window.postMessage({
            autoTwitchDropsConfig: {
                enabled: extEnabledState,
                autoClaimPoints: autoClaimPointsState
            }
        }, getSafeTargetOrigin());
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
            configHydrated = true;
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

const ALLOWED_PAGE_MESSAGES = new Set([
    "sendInteg",
    "claim-points",
    "points-earned",
    "claim-drop",
    "gqlOperation"
]);

const pendingIntegrityRequests = new Map();

// Forward in-page events from onPage.js to background service worker
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || typeof event.data !== "object") return;

    const atd = event.data.autoTwitchDrops;
    if (!atd || typeof atd !== "object" || typeof atd.type !== "string") return;

    // Handle integrityResponse directly and never forward to chrome.runtime.sendMessage
    if (atd.type === "integrityResponse") {
        if (atd.requestId && pendingIntegrityRequests.has(atd.requestId)) {
            const pending = pendingIntegrityRequests.get(atd.requestId);
            pendingIntegrityRequests.delete(atd.requestId);
            clearTimeout(pending.timer);
            pending.resolve({
                ok: Boolean(atd.ok),
                token: atd.token || null,
                expiration: typeof atd.expiration === "number" ? atd.expiration : undefined,
                clientSessionId: atd.clientSessionId || undefined,
                clientVersion: atd.clientVersion || undefined,
                status: atd.status || 0
            });
        }
        return;
    }

    if (ALLOWED_PAGE_MESSAGES.has(atd.type)) {
        if (!extEnabledState && atd.type !== "sendInteg") {
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

// Relay integrity mint requests from background service worker to onPage.js (never send secrets over window.postMessage)
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.type !== "atd:requestIntegrity" || !message.requestId) return;
        const requestId = String(message.requestId);
        let settled = false;
        const finish = (payload) => {
            if (settled) return;
            settled = true;
            try { sendResponse(payload); } catch (e) {}
        };
        const timer = setTimeout(() => {
            if (pendingIntegrityRequests.has(requestId)) {
                pendingIntegrityRequests.delete(requestId);
            }
            finish({ ok: false, timeout: true });
        }, 5000);
        pendingIntegrityRequests.set(requestId, { resolve: finish, timer });
        try {
            window.postMessage({
                source: "atd-extension",
                type: "atd:requestIntegrity",
                requestId
            }, getSafeTargetOrigin());
        } catch (e) {
            clearTimeout(timer);
            pendingIntegrityRequests.delete(requestId);
            finish({ ok: false, error: "postMessage failed" });
        }
        return true;
    });
}

function injectScript(file_path) {
    try {
        const script = document.createElement('script');
        script.setAttribute('type', 'text/javascript');
        script.setAttribute('src', chrome.runtime.getURL(file_path));
        script.onload = () => {
            if (configHydrated) {
                broadcastConfigToPage();
            }
        };
        const target = document.head || document.documentElement;
        if (target) {
            target.appendChild(script);
        }
    } catch (e) {}
}

injectScript("onPage.js");

function readCookieValue(name) {
    try {
        const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]+)`));
        return match ? decodeURIComponent(match[1]) : undefined;
    } catch (e) {
        return undefined;
    }
}

function syncClientAuth() {
    try {
        if (!document.body) return;
        const scripts = Array.from(document.body.querySelectorAll("script"));
        const targetScript = scripts.find(a => a.innerHTML && a.innerHTML.includes("clientId="));
        if (!targetScript) return;

        const clientIdMatch = targetScript.innerHTML.match(/clientId="([^"]+)"/);
        const clientId = clientIdMatch ? clientIdMatch[1] : undefined;
        const uniqueId = readCookieValue("unique_id");
        const authToken = readCookieValue("auth-token");

        if (clientId && (uniqueId || authToken)) {
            chrome.runtime.sendMessage({
                type: "clientInfo",
                id: clientId,
                uniq: uniqueId,
                auth: authToken,
                data: {
                    clientId,
                    deviceId: uniqueId || undefined,
                    oauthToken: authToken || undefined
                }
            }).catch(() => {});
        }
    } catch (e) {}
}

if (document.readyState === "loading") {
    window.addEventListener('DOMContentLoaded', syncClientAuth);
} else {
    syncClientAuth();
}
