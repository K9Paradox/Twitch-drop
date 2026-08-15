// Auto Twitch Drops Pro - Page-level Interceptor & Stream Automation Engine

if (!window._originalFetch) {
    // 1. Set Low-bandwidth 160p preset and safe player volume in localStorage
    try {
        localStorage.setItem("player-volume", JSON.stringify({ "default": 0.5, "volume": 0.5, "muted": false }));
        localStorage.setItem("video-quality", JSON.stringify({ "default": "160p30" }));
        localStorage.setItem("low-latency", JSON.stringify({ "default": false }));
    } catch (e) {}

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
     * Safe Playback Watchdog
     */
    function safePlaybackWatchdog() {
        try {
            // Dismiss static Twitch prompt overlays if present
            const promptBtns = document.querySelectorAll('[data-a-target="player-overlay-click-to-unmute"], [data-test-selector="unmute-button"]');
            promptBtns.forEach(btn => {
                if (btn && btn.offsetParent !== null) triggerSyntheticClick(btn);
            });

            // Ensure video element is playing (never force unmuted playback without interaction)
            const videos = document.querySelectorAll('video');
            videos.forEach(v => {
                if (v && v.paused) {
                    v.play().catch(() => {});
                }
            });
        } catch (e) {}
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
                    window.postMessage({
                        autoTwitchDrops: {
                            type: "points-earned",
                            points: 50
                        }
                    }, "*");
                }
            }
        } catch (e) {}
    }

    // Run throttled watchdog every 5 seconds
    setInterval(() => {
        safePlaybackWatchdog();
        autoClaimPointsChests();
    }, 5000);

    setTimeout(() => {
        safePlaybackWatchdog();
        autoClaimPointsChests();
    }, 1500);

    // Network Interceptor (GraphQL & Hermes WebSocket)
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
        construct: (sock, sockurl) => {
            const socket = new sock(...sockurl);
            socket.addEventListener("message", res => {
                try {
                    if (res && res.origin === "wss://hermes.twitch.tv") {
                        const data = JSON.parse(res.data);
                        if (data.type === "MESSAGE") {
                            const parsed = JSON.parse(data.data.message);
                            if (parsed.type === "points-earned") {
                                window.postMessage({
                                    autoTwitchDrops: {
                                        type: "points-earned",
                                        points: parsed.data.point_gain.total_points
                                    }
                                }, "*");
                            } else if (parsed.type === "claim-available") {
                                window.postMessage({
                                    autoTwitchDrops: {
                                        type: "claim-points",
                                        claimID: parsed.data.claim.id,
                                        channelID: parsed.data.claim.channel_id
                                    }
                                }, "*");
                            } else if (parsed.type === "drop-progress") {
                                window.postMessage({
                                    autoTwitchDrops: {
                                        type: "checkDrop"
                                    }
                                }, "*");
                            }
                        }
                    }
                } catch (e) {}
            });
            return socket;
        }
    });
}