/**
 * Auto Twitch Drops Pro v2.0 — In-Page Helper
 * Headless HLS & Spade watch pulses run in the background service worker.
 * This script remains solely to:
 *   1. Auto-click Channel Points bonus chests when the user is browsing Twitch
 *   2. Capture Client-Integrity tokens from page fetch calls
 *   3. Intercept Hermes / PubSub WebSocket drop & community-points events
 */

// ============================================================================
// 1. CHANNEL POINTS CHEST AUTO-CLAIMER (DOM + DEDUPLICATION)
// ============================================================================
const recentClaims = new Map();
let atdEnabled = true;
let atdAutoClaimPoints = true;
let cachedSessionId = null;
let cachedClientVersion = null;
let cachedAuthHeader = null;
let cachedDeviceId = null;
let internalIntegrityFetchesInFlight = 0;

function readPageCookie(name) {
    try {
        if (typeof document === "undefined" || typeof document.cookie !== "string") return null;
        const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]+)`));
        return match ? decodeURIComponent(match[1]) : null;
    } catch (e) {
        return null;
    }
}

function getSafeTargetOrigin() {
    try {
        if (typeof window !== "undefined" && window.location && window.location.origin && window.location.origin !== "null") {
            return window.location.origin;
        }
    } catch (e) {}
    return "*";
}

function postToExtension(payload) {
    try {
        window.postMessage({ autoTwitchDrops: payload }, getSafeTargetOrigin());
    } catch (e) {}
}

async function handleIntegrityRequest(req) {
    const requestId = req.requestId;
    const cookieAuth = readPageCookie("auth-token");
    const cookieDevice = readPageCookie("unique_id");
    const authHeader = cachedAuthHeader || (cookieAuth ? `OAuth ${cookieAuth}` : null);
    const deviceId = cachedDeviceId || cookieDevice || null;

    internalIntegrityFetchesInFlight++;
    try {
        const headers = {
            "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko"
        };
        if (authHeader) headers["Authorization"] = authHeader;
        if (deviceId) headers["X-Device-Id"] = deviceId;
        if (cachedSessionId) headers["Client-Session-Id"] = cachedSessionId;
        if (cachedClientVersion) headers["Client-Version"] = cachedClientVersion;

        // Call live window.fetch (NOT _origFetch) so Twitch's Kasada SDK attaches x-kpsdk-* headers natively
        const res = await window.fetch("https://gql.twitch.tv/integrity", {
            method: "POST",
            credentials: "include",
            headers
        });
        if (res && res.ok) {
            const json = await res.json().catch(() => null);
            if (json && typeof json.token === "string" && json.token) {
                const expiration = (typeof json.expiration === "number" && Number.isFinite(json.expiration))
                    ? json.expiration
                    : undefined;
                postToExtension({
                    type: "integrityResponse",
                    requestId,
                    ok: true,
                    token: json.token,
                    ...(expiration !== undefined ? { expiration } : {}),
                    ...(cachedSessionId ? { clientSessionId: cachedSessionId } : {}),
                    ...(cachedClientVersion ? { clientVersion: cachedClientVersion } : {})
                });
                return;
            }
        }
        postToExtension({
            type: "integrityResponse",
            requestId,
            ok: false,
            status: res?.status || 0
        });
    } catch (e) {
        postToExtension({
            type: "integrityResponse",
            requestId,
            ok: false,
            status: 0
        });
    } finally {
        internalIntegrityFetchesInFlight = Math.max(0, internalIntegrityFetchesInFlight - 1);
    }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("message", (event) => {
        try {
            if (!event || event.source !== window || !event.data || typeof event.data !== "object") return;
            const cfg = event.data.autoTwitchDropsConfig;
            if (cfg && typeof cfg === "object") {
                if (typeof cfg.enabled === "boolean") atdEnabled = cfg.enabled;
                if (typeof cfg.autoClaimPoints === "boolean") atdAutoClaimPoints = cfg.autoClaimPoints;
            }
            if (event.data.source === "atd-extension" && event.data.type === "atd:requestIntegrity" && event.data.requestId) {
                handleIntegrityRequest(event.data);
            }
        } catch (e) {}
    });
}

function isDuplicateClaim(key, ttlMs = 10000) {
    if (!key) return false;
    const now = Date.now();
    for (const [k, ts] of recentClaims.entries()) {
        if (now - ts > 60000) {
            recentClaims.delete(k);
        }
    }
    if (recentClaims.has(key) && (now - recentClaims.get(key) < ttlMs)) {
        return true;
    }
    recentClaims.set(key, now);
    return false;
}

function hasRecentClaim(key, ttlMs = 15000) {
    if (!key || !recentClaims.has(key)) return false;
    return (Date.now() - recentClaims.get(key)) < ttlMs;
}

function triggerSyntheticClick(el) {
    if (!el) return;
    try {
        if (typeof MouseEvent === "function" && typeof el.dispatchEvent === "function") {
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        } else if (typeof el.click === "function") {
            el.click();
        }
    } catch (err) {
        try {
            if (typeof el.click === "function") el.click();
        } catch (e) {}
    }
}

function autoClaimPointsChests() {
    if (!atdEnabled || !atdAutoClaimPoints) return;
    try {
        // Skip DOM click if a WebSocket claim-available already claimed a chest in the last 10s
        if (hasRecentClaim("ws-chest-claim", 10000)) return;

        // NOTE: Never include '[data-test-selector="community-points-summary"] button' here —
        // the first button inside community-points-summary is the Channel Points balance/menu toggle!
        const selectors = [
            '[data-a-target="claim-channel-points-button"]',
            '[aria-label="Claim Bonus"]',
            'button[aria-label="Claim Bonus"]',
            'button[aria-label*="Claim Bonus"]',
            '.claimable-bonus__icon'
        ];

        for (const selector of selectors) {
            const found = document.querySelector(selector);
            if (!found || found.offsetParent === null) continue;

            const btn = (typeof found.closest === "function" && found.tagName !== "BUTTON")
                ? (found.closest("button") || found)
                : found;

            // Guard against accidentally clicking the main Channel Points balance menu button
            const ariaLabel = typeof btn.getAttribute === "function" ? (btn.getAttribute("aria-label") || "") : "";
            if (/balance|bits|rewards/i.test(ariaLabel) && !/claim|bonus/i.test(ariaLabel)) {
                continue;
            }

            triggerSyntheticClick(btn);
            if (!isDuplicateClaim("dom-chest-click", 15000)) {
                recentClaims.set("any-chest-claim", Date.now());
                postToExtension({
                    type: "points-earned",
                    points: 50,
                    source: "dom",
                    reasonCode: "CLAIM"
                });
            }
            break;
        }
    } catch (e) {}
}

setInterval(autoClaimPointsChests, 1500);

// ============================================================================
// 2. FETCH INTERCEPTOR (CLIENT-INTEGRITY & GQL OPERATIONS)
// ============================================================================
const PASSIVE_GQL_OPS = new Set([
    "DropCurrentSessionContext",
    "Inventory",
    "DropChannelCampaignsProgress"
]);

function extractHeaderValue(headers, name) {
    if (!headers) return null;
    try {
        if (typeof headers.get === "function") {
            return headers.get(name) || headers.get(name.toLowerCase()) || null;
        }
        if (typeof headers === "object") {
            const lower = name.toLowerCase();
            for (const key of Object.keys(headers)) {
                if (key.toLowerCase() === lower) return headers[key];
            }
        }
    } catch (e) {}
    return null;
}

const _origFetch = window._originalFetch || window.fetch;
if (typeof _origFetch === "function") {
    window._originalFetch = _origFetch;
    window.fetch = async function (...args) {
        let isTwitchGql = false;
        let isTwitchIntegrity = false;
        const isInternalIntegrity = internalIntegrityFetchesInFlight > 0;
        let reqOps = [];
        try {
            const reqInput = args[0];
            const reqUrl = typeof reqInput === "string" ? reqInput : (reqInput && reqInput.url ? reqInput.url : "");
            const options = args[1];
            const isGqlOrigin = reqUrl.includes("gql.twitch.tv/");
            if (isGqlOrigin) {
                const sessionId = extractHeaderValue(options?.headers, "Client-Session-Id")
                    || extractHeaderValue(reqInput?.headers, "Client-Session-Id");
                const clientVer = extractHeaderValue(options?.headers, "Client-Version")
                    || extractHeaderValue(reqInput?.headers, "Client-Version");
                const authHdr = extractHeaderValue(options?.headers, "Authorization")
                    || extractHeaderValue(reqInput?.headers, "Authorization");
                const devId = extractHeaderValue(options?.headers, "X-Device-Id")
                    || extractHeaderValue(reqInput?.headers, "X-Device-Id");
                if (sessionId) cachedSessionId = sessionId;
                if (clientVer) cachedClientVersion = clientVer;
                if (authHdr) cachedAuthHeader = authHdr;
                if (devId) cachedDeviceId = devId;
            }
            if (reqUrl.includes("gql.twitch.tv/integrity")) {
                isTwitchIntegrity = true;
            } else if (reqUrl.includes("gql.twitch.tv/gql")) {
                isTwitchGql = true;
                const integ = extractHeaderValue(options?.headers, "Client-Integrity")
                    || extractHeaderValue(reqInput?.headers, "Client-Integrity");
                if (integ) {
                    postToExtension({
                        type: "sendInteg",
                        data: {
                            token: integ,
                            ...(cachedSessionId ? { clientSessionId: cachedSessionId } : {}),
                            ...(cachedClientVersion ? { clientVersion: cachedClientVersion } : {})
                        }
                    });
                }
                const bodyStr = typeof options?.body === "string" ? options.body : null;
                if (bodyStr && (
                    bodyStr.includes("DropCurrentSessionContext") ||
                    bodyStr.includes("Inventory") ||
                    bodyStr.includes("DropChannelCampaignsProgress")
                )) {
                    try {
                        const parsedReq = JSON.parse(bodyStr);
                        const reqList = Array.isArray(parsedReq) ? parsedReq : [parsedReq];
                        reqOps = reqList.map(r => r && r.operationName ? r.operationName : null);
                    } catch (e) {}
                }
            }
        } catch (e) {}

        const response = await _origFetch.apply(this, args);

        if (isTwitchIntegrity && !isInternalIntegrity && response && response.ok && typeof response.clone === "function") {
            try {
                response.clone().json().then((json) => {
                    if (json && typeof json.token === "string" && json.token) {
                        postToExtension({
                            type: "sendInteg",
                            data: {
                                token: json.token,
                                ...(typeof json.expiration === "number" && Number.isFinite(json.expiration) ? { expiration: json.expiration } : {}),
                                ...(cachedSessionId ? { clientSessionId: cachedSessionId } : {}),
                                ...(cachedClientVersion ? { clientVersion: cachedClientVersion } : {})
                            }
                        });
                    }
                }).catch(() => {});
            } catch (e) {}
        }

        if (atdEnabled && isTwitchGql && reqOps.some(op => PASSIVE_GQL_OPS.has(op)) && response && typeof response.clone === "function") {
            try {
                response.clone().json().then((json) => {
                    const resList = Array.isArray(json) ? json : [json];
                    resList.forEach((item, idx) => {
                        const opName = item?.extensions?.operationName || reqOps[idx];
                        if (opName && PASSIVE_GQL_OPS.has(opName) && item && item.data) {
                            postToExtension({
                                type: "gqlOperation",
                                operation: opName,
                                data: item.data
                            });
                        }
                    });
                }).catch(() => {});
            } catch (e) {}
        }

        return response;
    };
}

// ============================================================================
// 3. WEBSOCKET INTERCEPTOR (HERMES & PUBSUB-EDGE)
// ============================================================================
const _origWS = window._originalWebSocket || window.WebSocket;
if (typeof _origWS === "function") {
    window._originalWebSocket = _origWS;
    window.WebSocket = new Proxy(_origWS, {
        construct(target, args) {
            const ws = new target(...args);
            const wsUrl = String(args[0] || "");

            if (wsUrl.includes("hermes.twitch.tv") || wsUrl.includes("pubsub-edge.twitch.tv")) {
                const wsSource = wsUrl.includes("hermes.twitch.tv") ? "hermes" : "pubsub";
                ws.addEventListener("message", (res) => {
                    try {
                        if (!res || typeof res.data !== "string") return;
                        const outer = JSON.parse(res.data);
                        if (!outer || typeof outer !== "object") return;

                        let topic = "";
                        let innerPayload = null;

                        if (outer.type === "notification" && outer.notification) {
                            topic = outer.notification.subscription?.pubsubTopic || outer.notification.topic || "";
                            const rawPubsub = outer.notification.pubsub;
                            if (typeof rawPubsub === "string") {
                                innerPayload = JSON.parse(rawPubsub);
                            } else if (rawPubsub && typeof rawPubsub === "object") {
                                innerPayload = rawPubsub;
                            }
                        } else if (outer.type === "MESSAGE" && outer.data && typeof outer.data === "object") {
                            topic = outer.data.topic || "";
                            const rawMsg = outer.data.message;
                            if (typeof rawMsg === "string") {
                                innerPayload = JSON.parse(rawMsg);
                            } else if (rawMsg && typeof rawMsg === "object") {
                                innerPayload = rawMsg;
                            }
                        }

                        if (!innerPayload || typeof innerPayload !== "object" || Array.isArray(innerPayload)) return;

                        const msgType = innerPayload.type || "";
                        const msgData = (innerPayload.data && typeof innerPayload.data === "object") ? innerPayload.data : {};

                        // A. Community Points Bonus Chest Available
                        if (msgType === "claim-available") {
                            if (!atdEnabled || !atdAutoClaimPoints) return;
                            const claim = msgData.claim || innerPayload.claim;
                            if (claim && typeof claim.id === "string" && claim.id && claim.channel_id) {
                                if (!isDuplicateClaim("claim-" + claim.id, 15000)) {
                                    recentClaims.set("ws-chest-claim", Date.now());
                                    recentClaims.set("any-chest-claim", Date.now());
                                    postToExtension({
                                        type: "claim-points",
                                        claimID: claim.id,
                                        channelID: claim.channel_id
                                    });
                                }
                            }
                        }
                        // B. Community Points Earned
                        else if (msgType === "points-earned") {
                            if (!atdEnabled || !atdAutoClaimPoints) return;
                            const gain = msgData.point_gain || innerPayload.point_gain;
                            if (gain && typeof gain === "object") {
                                const reasonCode = gain.reason_code || null;
                                const pts = Number(gain.total_points || gain.baseline_points) || 50;
                                // Skip duplicate CLAIM notification if we already counted a chest claim within 15s
                                if (reasonCode === "CLAIM" && hasRecentClaim("any-chest-claim", 15000)) {
                                    return;
                                }
                                if (!isDuplicateClaim(`points-earned-${pts}-${reasonCode || wsSource}`, 3000)) {
                                    postToExtension({
                                        type: "points-earned",
                                        points: pts,
                                        source: wsSource,
                                        reasonCode: reasonCode,
                                        channelID: msgData.channel_id || innerPayload.channel_id || null
                                    });
                                }
                            }
                        }
                        // C. Drop Progress / Drop Claim
                        else if (
                            topic.startsWith("user-drop-events") ||
                            msgType === "drop-progress" ||
                            msgType === "drop-claim"
                        ) {
                            if (!atdEnabled) return;
                            postToExtension({
                                type: "claim-drop",
                                eventType: msgType,
                                dropID: msgData.drop_id || null,
                                dropInstanceID: msgData.drop_instance_id || null,
                                currentProgressMin: msgData.current_progress_min ?? null,
                                requiredProgressMin: msgData.required_progress_min ?? null
                            });
                        }
                    } catch (e) {
                        // Never throw on malformed or non-JSON frames
                    }
                });
            }

            return ws;
        }
    });
}

