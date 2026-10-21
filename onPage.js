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
    try {
        const selectors = [
            '[data-a-target="claim-channel-points-button"]',
            '[aria-label="Claim Bonus"]',
            'button[aria-label="Claim Bonus"]',
            'button[aria-label*="Claim Bonus"]',
            '[data-test-selector="community-points-summary"] button',
            '.claimable-bonus__icon'
        ];

        for (const selector of selectors) {
            const btn = document.querySelector(selector);
            if (btn && btn.offsetParent !== null) {
                triggerSyntheticClick(btn);
                if (!isDuplicateClaim("dom-chest-click", 5000)) {
                    window.postMessage({
                        autoTwitchDrops: {
                            type: "points-earned",
                            points: 50,
                            source: "dom"
                        }
                    }, "*");
                }
                break;
            }
        }
    } catch (e) {}
}

setInterval(autoClaimPointsChests, 1500);

// ============================================================================
// 2. FETCH INTERCEPTOR (CLIENT-INTEGRITY & GQL OPERATIONS)
// ============================================================================
const _origFetch = window._originalFetch || window.fetch;
if (typeof _origFetch === "function") {
    window._originalFetch = _origFetch;
    window.fetch = async function (...args) {
        try {
            const reqUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url ? args[0].url : "");
            const options = args[1];
            if (reqUrl.includes("gql.twitch.tv/gql") && options && options.headers) {
                let integ = null;
                if (typeof options.headers.get === "function") {
                    integ = options.headers.get("Client-Integrity") || options.headers.get("client-integrity");
                } else if (typeof options.headers === "object") {
                    integ = options.headers["Client-Integrity"] || options.headers["client-integrity"];
                }
                if (integ) {
                    window.postMessage({
                        autoTwitchDrops: {
                            type: "sendInteg",
                            data: integ
                        }
                    }, "*");
                }
            }
        } catch (e) {}
        return _origFetch.apply(this, args);
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
                            const claim = msgData.claim || innerPayload.claim;
                            if (claim && typeof claim.id === "string" && claim.id && claim.channel_id) {
                                if (!isDuplicateClaim("claim-" + claim.id, 15000)) {
                                    window.postMessage({
                                        autoTwitchDrops: {
                                            type: "claim-points",
                                            claimID: claim.id,
                                            channelID: claim.channel_id
                                        }
                                    }, "*");
                                }
                            }
                        }
                        // B. Community Points Earned
                        else if (msgType === "points-earned") {
                            const gain = msgData.point_gain || innerPayload.point_gain;
                            if (gain && typeof gain === "object") {
                                const pts = Number(gain.total_points || gain.baseline_points) || 50;
                                if (!isDuplicateClaim(`points-earned-${pts}-${wsSource}`, 3000)) {
                                    window.postMessage({
                                        autoTwitchDrops: {
                                            type: "points-earned",
                                            points: pts,
                                            source: wsSource
                                        }
                                    }, "*");
                                }
                            }
                        }
                        // C. Drop Progress / Drop Claim
                        else if (
                            topic.startsWith("user-drop-events") ||
                            msgType === "drop-progress" ||
                            msgType === "drop-claim"
                        ) {
                            window.postMessage({
                                autoTwitchDrops: {
                                    type: "claim-drop",
                                    eventType: msgType,
                                    dropInstanceID: msgData.drop_instance_id || msgData.drop_id || null,
                                    currentProgressMin: msgData.current_progress_min ?? null,
                                    requiredProgressMin: msgData.required_progress_min ?? null
                                }
                            }, "*");
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

