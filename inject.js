// Forward in-page events from onPage.js to background service worker
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || typeof event.data !== "object") return;

    const atd = event.data.autoTwitchDrops;
    if (atd && typeof atd === "object" && atd.type) {
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
