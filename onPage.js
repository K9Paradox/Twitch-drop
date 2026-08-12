if (!window._originalFetch) {
    /**
     * Farming mode: only TRUE on the tab the extension itself opened for
     * watching a drop stream. The background worker broadcasts it through
     * inject.js ("farmMode" messages). Previously this script force-unmuted,
     * force-played and overwrote the saved volume on *every* Twitch tab every
     * 2 seconds — even on the user's own tabs while they were just browsing.
     */
    window.__atdFarming = window.__atdFarming === true || !!window.__atdFarming;

    window.addEventListener("message", (e) => {
        if (!e.data || !e.data.autoTwitchDrops) return;
        const d = e.data.autoTwitchDrops;
        if (d.type === "farmMode") {
            window.__atdFarming = !!d.enabled;
            if (window.__atdFarming) applyFarmingMediaState();
        }
    });

    /**
     * Set Twitch player volume to unmuted in localStorage so Twitch's internal
     * tracking JS counts 100% of watch time toward drops — and keep the HTML5
     * video playing & unmuted internally (Chrome tab-muting still provides
     * complete silence). ONLY runs in farming mode now.
     */
    function applyFarmingMediaState() {
        try {
            localStorage.setItem("player-volume", JSON.stringify({ "default": 0.5, "volume": 0.5, "muted": false }));
        } catch (e) {}
        try {
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
                        v.play().catch(() => {});
                    }
                }
            });
        } catch (e) {}
    }

    setInterval(() => {
        if (window.__atdFarming) applyFarmingMediaState();
    }, 2000);

    // Safely override Page Visibility API without throwing "Cannot redefine property" errors
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
                        let data = JSON.parse(res.data);
                        if (data && data.type === "notification" && data.notification && data.notification.type === "pubsub") {
                            let mes = JSON.parse(data.notification.pubsub);
                            if (mes && mes.type === "points-earned" && mes.data && mes.data.point_gain) {
                                window.postMessage({
                                    autoTwitchDrops: {
                                        type: "points-earned",
                                        points: mes.data.point_gain.total_points || 50
                                    }
                                }, "*");
                            }
                            if (mes && mes.type === "claim-available" && mes.data && mes.data.claim) {
                                window.postMessage({
                                    autoTwitchDrops: {
                                        type: "claim-points",
                                        claimID: mes.data.claim.id,
                                        channelID: mes.data.claim.channel_id
                                    }
                                }, "*");
                            }
                            if (mes && mes.type === "drop-claim") {
                                window.postMessage({
                                    autoTwitchDrops: {
                                        type: "claim-drop"
                                    }
                                }, "*");
                            }
                            if (mes && mes.type === "drop-progress" && mes.data) {
                                if (mes.data.current_progress_min === mes.data.required_progress_min) {
                                    window.postMessage({
                                        autoTwitchDrops: {
                                            type: "checkDrop"
                                        }
                                    }, "*");
                                }
                            }
                        }
                    } else if (res && res.target && res.target.url === "wss://pubsub-edge.twitch.tv/v1") {
                        let data = JSON.parse(res.data);
                        if (data && data.type === "MESSAGE" && data.data && data.data.topic && data.data.topic.match(/^user-drop-events/)) {
                            let mes = JSON.parse(data.data.message);
                            if (mes && mes.type === "drop-claim") {
                                window.postMessage({
                                    autoTwitchDrops: {
                                        type: "claim-drop"
                                    }
                                }, "*");
                            }
                            if (mes && mes.type === "drop-progress" && mes.data) {
                                if (mes.data.current_progress_min === mes.data.required_progress_min) {
                                    window.postMessage({
                                        autoTwitchDrops: {
                                            type: "checkDrop"
                                        }
                                    }, "*");
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.warn("WebSocket proxy error:", err);
                }
            });
            return socket;
        }
    });
}
