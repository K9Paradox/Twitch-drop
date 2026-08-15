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
        }
    } catch (e) {}

    try {
        const protoVis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        if (protoVis && protoVis.configurable) {
            Object.defineProperty(Document.prototype, 'visibilityState', {
                get: function () { return 'visible'; },
                configurable: true
            });
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
     * Safe Playback Watchdog (No aggressive unmuting loop)
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

    // Run throttled watchdog every 5 seconds (no heavy MutationObserver hammer)
    setInterval(() => {
        safePlaybackWatchdog();
        autoClaimPointsChests();
    }, 5000);

    // Initial check after load
    setTimeout(() => {
        safePlaybackWatchdog();
        autoClaimPointsChests();
    }, 2000);

    // Network Interceptor (GraphQL & Hermes WebSocket)
    window._originalFetch = window._originalFetch || fetch;
    window.fetch = new Proxy(fetch, {
        apply: (f, s, r) => {
            const req = f.apply(s, r);
            return req.then(res => {
                if (res && res.url === "https://gql.twitch.tv/integrity") {
                    res.clone().json().then(data => {
                        window.postMessage({
                            autoTwitchDrops: {
                                type: "integ",
                                integrity: data
                            }
                        }, "*");
                    }).catch(() => {});
                }
                if (res && res.url === "https://gql.twitch.tv/gql") {
                    res.clone().json().then(data => {
                        try {
                            const operations = Array.isArray(data) ? data : [data];
                            operations.forEach(dat => {
                                const opName = dat?.extensions?.operationName;
                                if (opName === "DropCurrentSessionContext" || opName === "DropChannelCampaignsProgress" || opName === "Inventory" || opName === "ViewerDropsDashboard") {
                                    window.postMessage({
                                        autoTwitchDrops: {
                                            type: "sessionContext",
                                            operation: opName,
                                            data: dat.data
                                        }
                                    }, "*");
                                }
                            });
                        } catch (err) {}
                    }).catch(() => {});
                }
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