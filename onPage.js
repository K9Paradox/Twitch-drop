// Auto Twitch Drops Pro - Page-level Interceptor & Stream Automation Engine

if (!window._originalFetch) {
    // 1. Force Twitch player volume & Low-bandwidth 160p preset in localStorage
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
     * Auto Unmute & Autoplay Watchdog
     */
    function autoBypassUnmuteOverlay() {
        try {
            // 1. Twitch "Click to Unmute" overlays
            const unmuteSelectors = [
                '[data-a-target="player-overlay-click-to-unmute"]',
                '[data-a-target="player-unmute-button"]',
                'button[data-a-target="player-mute-unmute-button"][aria-label*="Unmute"]',
                'button[data-a-target="player-mute-unmute-button"][data-a-label*="Unmute"]',
                '.player-overlay-background button',
                '[data-test-selector="unmute-button"]'
            ];

            for (const selector of unmuteSelectors) {
                const btn = document.querySelector(selector);
                if (btn && btn.offsetParent !== null) {
                    triggerSyntheticClick(btn);
                }
            }

            // 2. Direct HTML5 Video Player Unmuting & Playback Watchdog
            const videos = document.querySelectorAll('video');
            videos.forEach(v => {
                if (v) {
                    if (v.muted) {
                        v.muted = false;
                    }
                    if (v.volume < 0.1) {
                        v.volume = 0.5;
                    }
                    if (v.paused) {
                        v.play().catch(() => {
                            // If browser blocks unmuted play, briefly start muted then unmute
                            v.muted = true;
                            v.play().then(() => {
                                setTimeout(() => { v.muted = false; }, 500);
                            }).catch(() => {});
                        });
                    }
                }
            });
        } catch (e) {}
    }

    /**
     * Auto Claim Channel Points Bonus Chests in DOM
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

    // Run active watchdogs continuously
    setInterval(() => {
        autoBypassUnmuteOverlay();
        autoClaimPointsChests();
    }, 1500);

    // Watch DOM mutations for instant overlay / chest detection
    const pageObserver = new MutationObserver(() => {
        autoBypassUnmuteOverlay();
        autoClaimPointsChests();
    });

    try {
        pageObserver.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });
    } catch (e) {}

    // Network Interceptors
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
                            if (Array.isArray(data)) {
                                data.forEach(dat => {
                                    if (dat && dat.extensions && dat.extensions.operationName === "DropCurrentSessionContext") {
                                        if (dat.data && dat.data.currentUser && dat.data.currentUser.dropCurrentSession && dat.data.currentUser.dropCurrentSession.game) {
                                            window.postMessage({
                                                autoTwitchDrops: {
                                                    type: "checkDrop",
                                                    game: dat.data.currentUser.dropCurrentSession.game.displayName
                                                }
                                            }, "*");
                                        }
                                    }
                                });
                            }
                        } catch (err) {
                            console.warn("onPage fetch proxy error:", err);
                        }
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