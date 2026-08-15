// Auto Twitch Drops Pro - Page-level Interceptor & Stream Automation Engine

if (!window._originalFetch) {
    const activeIntervals = [];

    // 1. Set Low-bandwidth 160p preset and muted player volume in localStorage (guarantees Chrome Autoplay)
    function applyLowBandwidthPresets(lowQuality = true) {
        try {
            if (lowQuality) {
                localStorage.setItem("video-quality", JSON.stringify({ "default": "160p30" }));
            }
            localStorage.setItem("player-volume", JSON.stringify({ "default": 0.5, "volume": 0.5, "muted": true }));
            localStorage.setItem("low-latency", JSON.stringify({ "default": false }));
        } catch (e) {}
    }
    applyLowBandwidthPresets(true);

    // Listen for settings and audio state changes relayed from content script
    window.addEventListener("message", (e) => {
        if (!e.data || !e.data.autoTwitchDrops) return;
        const dropData = e.data.autoTwitchDrops;
        if (dropData.type === "settingsChanged" && dropData.settings) {
            if (dropData.settings.lowQualityMode !== undefined) {
                applyLowBandwidthPresets(dropData.settings.lowQualityMode);
            }
        } else if (dropData.type === "setTabAudio") {
            const shouldMute = Boolean(dropData.muted);
            try {
                const videos = document.querySelectorAll('video');
                videos.forEach(v => {
                    if (v) v.muted = shouldMute;
                });
            } catch (err) {}
        }
    });

    // 2. Safely override Page Visibility API so Twitch never pauses background/minimized streams
    try {
        const protoHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
        if (protoHidden && protoHidden.configurable) {
            Object.defineProperty(Document.prototype, 'hidden', {
                get: function () { return false; },
                configurable: true
            });
        } else {
            const docHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
            if (docHidden && docHidden.configurable) {
                Object.defineProperty(document, 'hidden', {
                    get: function () { return false; },
                    configurable: true
                });
            }
        }
    } catch (e) {}

    try {
        const protoVis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        if (protoVis && protoVis.configurable) {
            Object.defineProperty(Document.prototype, 'visibilityState', {
                get: function () { return 'visible'; },
                configurable: true
            });
        } else {
            const docVis = Object.getOwnPropertyDescriptor(document, 'visibilityState');
            if (docVis && docVis.configurable) {
                Object.defineProperty(document, 'visibilityState', {
                    get: function () { return 'visible'; },
                    configurable: true
                });
            }
        }
    } catch (e) {}

    try {
        document.addEventListener('visibilitychange', function (e) {
            e.stopImmediatePropagation();
        }, true);
    } catch (e) {}

    /**
     * Deduplication Cache to prevent double-dispatching and race conditions
     */
    const recentClaims = new Map();
    function isDuplicateClaim(key, ttlMs = 10000) {
        const now = Date.now();
        for (const [k, time] of recentClaims.entries()) {
            if (now - time > 60000) recentClaims.delete(k);
        }
        if (recentClaims.has(key) && (now - recentClaims.get(key) < ttlMs)) {
            return true;
        }
        recentClaims.set(key, now);
        return false;
    }

    /**
     * Synthetic Click Trigger
     */
    function triggerSyntheticClick(element) {
        if (!element) return;
        try {
            const mouseOpts = { bubbles: true, cancelable: true, view: window };
            element.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
            element.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
            element.dispatchEvent(new MouseEvent('click', mouseOpts));
            if (typeof element.click === 'function') element.click();
        } catch (err) {}
    }

    /**
     * Auto Claim Channel Points Bonus Chests in Chat
     */
    function autoClaimPointsChests() {
        try {
            const chestButtons = [
                '[aria-label="Claim Bonus"]',
                '[aria-label="Claim bonus"]',
                '[data-a-target="claim-channel-points-button"]',
                '.community-points-summary button',
                '[data-test-selector="community-points-summary"] button'
            ];

            for (const selector of chestButtons) {
                const btn = document.querySelector(selector);
                if (btn && btn.offsetParent !== null) {
                    triggerSyntheticClick(btn);
                    if (!isDuplicateClaim("dom-chest-claim", 15000)) {
                        window.postMessage({
                            autoTwitchDrops: {
                                type: "points-earned",
                                points: 50,
                                source: "dom"
                            }
                        }, "*");
                    }
                }
            }
        } catch (e) {}
    }

    // Run bonus chest claim check every 15 seconds
    const chestInterval = setInterval(autoClaimPointsChests, 15000);
    activeIntervals.push(chestInterval);

    setTimeout(autoClaimPointsChests, 3000);

    // Garbage collection on unload
    window.addEventListener('beforeunload', () => {
        activeIntervals.forEach(id => clearInterval(id));
        activeIntervals.length = 0;
        recentClaims.clear();
    });

    // Network Interceptor (GraphQL & Hermes/PubSub WebSocket)
    window._originalFetch = window._originalFetch || fetch;
    window.fetch = new Proxy(fetch, {
        apply: (f, s, r) => {
            try {
                // Intercept Client-Integrity header if present in request headers
                const headers = r[1]?.headers;
                if (headers) {
                    let integToken = null;
                    if (headers instanceof Headers) {
                        integToken = headers.get('Client-Integrity') || headers.get('client-integrity');
                    } else if (typeof headers === 'object') {
                        integToken = headers['Client-Integrity'] || headers['client-integrity'];
                    }
                    if (integToken) {
                        window.postMessage({
                            autoTwitchDrops: {
                                type: "integ",
                                integrity: { token: integToken, expiration: Date.now() + 3600000 }
                            }
                        }, "*");
                    }
                }
            } catch (e) {}

            const req = f.apply(s, r);
            return req.then(res => {
                try {
                    const url = (res && res.url) ? res.url : (r[0] ? (typeof r[0] === 'string' ? r[0] : r[0].url) : '');
                    if (url && (url.includes('gql.twitch.tv') || url.includes('/gql') || url.includes('/integrity'))) {
                        res.clone().json().then(data => {
                            if (url.includes('/integrity') && data && data.token) {
                                window.postMessage({
                                    autoTwitchDrops: {
                                        type: "integ",
                                        integrity: data
                                    }
                                }, "*");
                            } else if (data) {
                                const operations = Array.isArray(data) ? data : [data];
                                operations.forEach(dat => {
                                    const opName = dat?.extensions?.operationName;
                                    if (opName) {
                                        window.postMessage({
                                            autoTwitchDrops: {
                                                type: "gqlOperation",
                                                operation: opName,
                                                data: dat.data
                                            }
                                        }, "*");
                                    }
                                });
                            }
                        }).catch(() => {});
                    }
                } catch (err) {}
                return res;
            });
        }
    });

    window._originalWebSocket = window._originalWebSocket || WebSocket;
    window.WebSocket = new Proxy(_originalWebSocket, {
        construct: (target, args) => {
            const socket = new target(...args);
            let targetUrl = "";
            try {
                if (typeof args[0] === "string") {
                    targetUrl = args[0];
                } else if (args[0] && typeof args[0].url === "string") {
                    targetUrl = args[0].url;
                } else if (args[0] && typeof args[0].toString === "function") {
                    targetUrl = args[0].toString();
                }
            } catch (err) {}

            const isHermes = targetUrl.includes("hermes.twitch.tv");
            const isPubSub = targetUrl.includes("pubsub-edge.twitch.tv");

            if (isHermes || isPubSub) {
                socket.addEventListener("message", res => {
                    try {
                        if (!res || !res.data) return;
                        const rawData = res.data;
                        if (typeof rawData !== "string") return;

                        let data;
                        try {
                            data = JSON.parse(rawData);
                        } catch (err) {
                            return;
                        }

                        if (data && data.type === "MESSAGE" && data.data) {
                            let parsed = null;
                            if (data.data.message) {
                                try {
                                    parsed = typeof data.data.message === "string" ? JSON.parse(data.data.message) : data.data.message;
                                } catch (err) {}
                            }

                            if (parsed) {
                                if (parsed.type === "points-earned") {
                                    const pts = parsed.data?.point_gain?.total_points || parsed.data?.points || 50;
                                    if (!isDuplicateClaim("ws-points-earned-" + pts, 5000)) {
                                        window.postMessage({
                                            autoTwitchDrops: {
                                                type: "points-earned",
                                                points: pts,
                                                source: isHermes ? "hermes" : "pubsub"
                                            }
                                        }, "*");
                                    }
                                } else if (parsed.type === "claim-available") {
                                    const claimId = parsed.data?.claim?.id;
                                    const channelId = parsed.data?.claim?.channel_id;
                                    if (claimId && !isDuplicateClaim("claim-" + claimId, 15000)) {
                                        window.postMessage({
                                            autoTwitchDrops: {
                                                type: "claim-points",
                                                claimID: claimId,
                                                channelID: channelId,
                                                source: isHermes ? "hermes" : "pubsub"
                                            }
                                        }, "*");
                                    }
                                } else if (parsed.type === "drop-progress" || parsed.type === "drop-claim") {
                                    if (!isDuplicateClaim("drop-progress", 5000)) {
                                        window.postMessage({
                                            autoTwitchDrops: {
                                                type: "checkDrop",
                                                source: isHermes ? "hermes" : "pubsub"
                                            }
                                        }, "*");
                                    }
                                }
                            }

                            const topic = data.data.topic;
                            if (topic && parsed) {
                                if (topic.includes("community-points-user-v1")) {
                                    if (parsed.type === "points-earned") {
                                        const pts = parsed.data?.point_gain?.total_points || parsed.data?.points || 50;
                                        if (!isDuplicateClaim("ws-points-earned-" + pts, 5000)) {
                                            window.postMessage({
                                                autoTwitchDrops: {
                                                    type: "points-earned",
                                                    points: pts,
                                                    source: "pubsub"
                                                }
                                            }, "*");
                                        }
                                    } else if (parsed.type === "claim-available") {
                                        const claimId = parsed.data?.claim?.id;
                                        const channelId = parsed.data?.claim?.channel_id;
                                        if (claimId && !isDuplicateClaim("claim-" + claimId, 15000)) {
                                            window.postMessage({
                                                autoTwitchDrops: {
                                                    type: "claim-points",
                                                    claimID: claimId,
                                                    channelID: channelId,
                                                    source: "pubsub"
                                                }
                                            }, "*");
                                        }
                                    }
                                } else if (topic.includes("user-drop-events") || topic.includes("drop-progress")) {
                                    if (!isDuplicateClaim("drop-progress", 5000)) {
                                        window.postMessage({
                                            autoTwitchDrops: {
                                                type: "checkDrop",
                                                source: "pubsub"
                                            }
                                        }, "*");
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                });
            }
            return socket;
        }
    });
}