/**
 * Twitch GQL & Internal API Client
 */

let twitchServerTimeOffset = 0;
let hasCalibratedServerTime = false;

export function getTwitchNow() {
    return Date.now() + twitchServerTimeOffset;
}

export function setTwitchServerTimeOffset(offsetMs, calibrated = true) {
    const num = Number(offsetMs);
    twitchServerTimeOffset = Number.isFinite(num) ? num : 0;
    hasCalibratedServerTime = Boolean(calibrated);
    try {
        if (typeof chrome !== "undefined" && chrome?.storage?.local) {
            chrome.storage.local.set({ twitchServerTimeOffset }).catch(() => {});
        }
    } catch (e) {}
}

export function updateServerTimeFromResponse(res) {
    try {
        const dateHeader = res?.headers?.get?.("date") || res?.headers?.get?.("Date");
        if (dateHeader) {
            const serverMs = Date.parse(dateHeader);
            if (!isNaN(serverMs) && serverMs > 0) {
                setTwitchServerTimeOffset(serverMs - Date.now(), true);
            }
        }
    } catch (e) {}
}

export function calibrateOffsetFromCampaignsList(campaigns) {
    if (hasCalibratedServerTime || !Array.isArray(campaigns) || campaigns.length < 3) return;
    const activeWithDates = campaigns.filter(c => c && c.status === "ACTIVE" && (c.endAt || c.endsAt));
    if (activeWithDates.length < 3) return;
    const localNow = Date.now();
    const anyFutureEnd = activeWithDates.some(c => {
        const endTs = new Date(c.endAt || c.endsAt).getTime();
        return !isNaN(endTs) && endTs > localNow;
    });
    if (anyFutureEnd) return;

    // Every ACTIVE campaign on Twitch's dashboard has an endAt <= local Date.now(),
    // which indicates the user's PC clock is set ahead of real-world Twitch time.
    let latestStartMs = 0;
    let latestEndMs = 0;
    for (const c of activeWithDates) {
        const sMs = c.startAt ? new Date(c.startAt).getTime() : NaN;
        const eMs = new Date(c.endAt || c.endsAt).getTime();
        if (!isNaN(sMs) && sMs > latestStartMs) latestStartMs = sMs;
        if (!isNaN(eMs) && eMs > latestEndMs) latestEndMs = eMs;
    }
    const estimatedNow = latestStartMs > 0
        ? (latestStartMs + 3600000)
        : (latestEndMs > 0 ? (latestEndMs - 86400000) : 0);
    if (estimatedNow > 0 && estimatedNow < localNow) {
        setTwitchServerTimeOffset(estimatedNow - localNow, true);
    }
}

export class TwitchApiError extends Error {
    constructor(message, { status = null, errors = null, operationName = null } = {}) {
        super(message);
        this.name = "TwitchApiError";
        this.status = status;
        this.errors = errors;
        this.operationName = operationName;
    }
}

export class Client {
    constructor(options = {}) {
        this.clientId = options?.clientId ?? "kimne78kx3ncx6brgo4mv6wki5h1ko";
        this.oauthToken = options?.oauthToken ?? null;
        this.deviceId = options?.deviceId ?? null;
        this.integrity = options?.integrity ?? null;
        this.userId = options?.userId ?? null;
        this.uuid = options?.uuid ?? null;
        this.onIntegrityError = options?.onIntegrityError ?? null;
        this._streamUrlCache = new Map();
        this._spadeUrlCache = new Map();
    }

    hasIntegrityError(json) {
        if (!json) return false;
        const items = Array.isArray(json) ? json : [json];
        return items.some(item =>
            Array.isArray(item?.errors) &&
            item.errors.some(err =>
                err?.extensions?.code === "IntegrityCheckFailed" ||
                (typeof err?.message === "string" && err.message.toLowerCase().includes("integrity"))
            )
        );
    }

    hasTransientGqlError(json) {
        if (!json) return false;
        const transientMessages = [
            "service error",
            "service timeout",
            "service unavailable",
            "request cancelled",
            "context deadline exceeded"
        ];
        const items = Array.isArray(json) ? json : [json];
        return items.some(item =>
            Array.isArray(item?.errors) &&
            item.errors.some(err => {
                const msg = typeof err?.message === "string" ? err.message.toLowerCase() : "";
                return transientMessages.some(t => msg.includes(t));
            })
        );
    }

    extractOperationName(data) {
        if (!data) return null;
        if (Array.isArray(data)) {
            return data.map(d => d?.operationName).filter(Boolean).join(",");
        }
        return data?.operationName || null;
    }

    buildHeaders(authorized = false) {
        const headers = {
            "Client-Id": this.clientId,
            "Content-Type": "application/json"
        };
        if (authorized && this.oauthToken) {
            headers["Authorization"] = `OAuth ${this.oauthToken}`;
        }
        if (this.deviceId) {
            headers["X-Device-Id"] = this.deviceId;
        }
        if (this.integrity) {
            const integToken = typeof this.integrity === "string" ? this.integrity : this.integrity?.token;
            if (integToken) headers["Client-Integrity"] = integToken;
        }
        if (this.uuid) {
            headers["Client-Session-Id"] = this.uuid;
        }
        return headers;
    }

    async post(data, _transientRetryCount = 0) {
        const opName = this.extractOperationName(data);
        const headers = this.buildHeaders(false);

        const res = await fetch("https://gql.twitch.tv/gql", {
            method: "POST",
            headers: headers,
            body: JSON.stringify(data)
        });

        updateServerTimeFromResponse(res);

        if (!res.ok) {
            throw new TwitchApiError(`Twitch GQL HTTP error ${res.status}: ${res.statusText}`, {
                status: res.status,
                operationName: opName
            });
        }

        const json = await res.json();
        if (_transientRetryCount < 1 && this.hasTransientGqlError(json)) {
            await new Promise(r => setTimeout(r, 150));
            return await this.post(data, _transientRetryCount + 1);
        }

        if (Array.isArray(json)) {
            return json;
        }

        if (json && json.errors && json.errors.length > 0) {
            if (!json.data || Object.keys(json.data).length === 0) {
                const errMsg = json.errors.map(e => e?.message || JSON.stringify(e)).join("; ") || "GraphQL query error";
                throw new TwitchApiError(errMsg, {
                    status: res.status,
                    errors: json.errors,
                    operationName: opName
                });
            } else {
                console.warn(`Twitch GQL warning in ${opName}:`, json.errors[0]?.message);
            }
        }

        return (json && json.data !== undefined) ? json.data : json;
    }

    async postAuthorized(data, _retried = false, _transientRetryCount = 0) {
        const opName = this.extractOperationName(data);
        if (!this.oauthToken) {
            throw new TwitchApiError("Unauthorized: Missing OAuth token", {
                status: 401,
                operationName: opName
            });
        }

        const headers = this.buildHeaders(true);

        const res = await fetch("https://gql.twitch.tv/gql", {
            method: "POST",
            headers: headers,
            body: JSON.stringify(data)
        });

        updateServerTimeFromResponse(res);

        if (!res.ok) {
            throw new TwitchApiError(`Twitch GQL HTTP error ${res.status}: ${res.statusText}`, {
                status: res.status,
                operationName: opName
            });
        }

        const json = await res.json();

        if (!_retried && this.hasIntegrityError(json) && typeof this.onIntegrityError === "function") {
            try {
                const refreshed = await this.onIntegrityError();
                if (refreshed) {
                    return await this.postAuthorized(data, true, _transientRetryCount);
                }
            } catch (e) {}
        }

        if (_transientRetryCount < 1 && this.hasTransientGqlError(json)) {
            await new Promise(r => setTimeout(r, 150));
            return await this.postAuthorized(data, _retried, _transientRetryCount + 1);
        }

        if (Array.isArray(json)) {
            return json;
        }

        if (json && json.errors && json.errors.length > 0) {
            if (!json.data || Object.keys(json.data).length === 0) {
                const errMsg = json.errors.map(e => e?.message || JSON.stringify(e)).join("; ") || "GraphQL query error";
                throw new TwitchApiError(errMsg, {
                    status: res.status,
                    errors: json.errors,
                    operationName: opName
                });
            } else {
                console.warn(`Twitch GQL warning in ${opName}:`, json.errors[0]?.message);
            }
        }

        return (json && json.data !== undefined) ? json.data : json;
    }

    async getInteg() {
        if (!this.integrity) return false;
        const expiration = typeof this.integrity === "object" ? this.integrity.expiration : null;
        if (expiration && expiration - 960000 < Date.now()) {
            return false;
        }
        return this.integrity;
    }

    async setInteg(integ) {
        this.integrity = integ;
        try {
            if (typeof chrome !== "undefined" && chrome?.storage?.local) {
                await chrome.storage.local.set({ twitchInteg: integ });
            }
        } catch (e) {}
    }

    async updateUserInfo(options) {
        if (!options) return;
        if (options.clientId !== undefined) this.clientId = options.clientId;
        if (options.oauthToken !== undefined) this.oauthToken = options.oauthToken;
        if (options.deviceId !== undefined) this.deviceId = options.deviceId;
        if (options.userId !== undefined) this.userId = options.userId;
        if (options.uuid !== undefined) this.uuid = options.uuid;
        if (options.integrity !== undefined) this.integrity = options.integrity;
        if (options.onIntegrityError !== undefined) this.onIntegrityError = options.onIntegrityError;
    }

    async getUserId() {
        return await this.autoDetectUserId();
    }

    async autoDetectUserId() {
        if (!this.oauthToken) return null;
        try {
            const data = await this.postAuthorized({
                "operationName": "CoreActionsCurrentUser",
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "6b5b63a013cf66a995d61f71a508ab5c8e4473350c5d4136f846ba65e8101e95"
                    }
                }
            });
            if (data && data.currentUser && data.currentUser.id) {
                this.userId = data.currentUser.id;
                try {
                    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
                        await chrome.storage.local.set({ userId: data.currentUser.id });
                    }
                } catch (err) {}
                return this.userId;
            }
        } catch (e) {}

        if (!this.userId && this.oauthToken) {
            try {
                const res = await fetch("https://id.twitch.tv/oauth2/validate", {
                    method: "GET",
                    headers: {
                        "Authorization": `OAuth ${this.oauthToken}`
                    }
                });
                if (res && res.ok) {
                    const valJson = await res.json();
                    if (valJson && valJson.user_id) {
                        this.userId = String(valJson.user_id);
                        try {
                            if (typeof chrome !== "undefined" && chrome?.storage?.local) {
                                await chrome.storage.local.set({ userId: this.userId });
                            }
                        } catch (err) {}
                    }
                }
            } catch (e) {}
        }
        return this.userId;
    }

    async getGameIdFromName(name) {
        if (!name) return null;
        try {
            const queryGame = async (n) => {
                const data = await this.post({
                    "operationName": "DirectoryRoot_Directory",
                    "variables": {
                        "name": n.toLowerCase()
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": "99d3c9b5ceaadb36f77c8bc2d576a737c83d2e9f06c4d6190cf2c6b4f214cccb"
                        }
                    }
                });
                const game = data ? data.game : null;
                if (game && game.id) {
                    return game.id;
                }
                return null;
            };

            let gameId = await queryGame(name);
            if (!gameId && isOverwatchGame(name)) {
                const alt = name.toLowerCase().includes("2") ? "overwatch" : "overwatch 2";
                gameId = await queryGame(alt);
            }
            return gameId;
        } catch (e) {}
        return null;
    }

    async getDropCampaigns(includeAll = false) {
        const finishList = (list) => {
            if (Array.isArray(list) && list.length > 0) {
                calibrateOffsetFromCampaignsList(list);
            }
            return list;
        };
        const DASHBOARD_HASH = "c16bb890cc8ce7647a96ee69cd313d423a378a3dedadf630a1017cde18975feb";
        const LEGACY_DASHBOARD_HASH = "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619";
        if (this.oauthToken) {
            try {
                let data = await this.postAuthorized({
                    "operationName": "ViewerDropsDashboard",
                    "variables": {
                        "fetchRewardCampaigns": true
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": DASHBOARD_HASH
                        }
                    }
                }).catch(() => null);
                if (!data) {
                    data = await this.postAuthorized({
                        "operationName": "ViewerDropsDashboard",
                        "variables": {
                            "fetchRewardCampaigns": true
                        },
                        "extensions": {
                            "persistedQuery": {
                                "version": 1,
                                "sha256Hash": LEGACY_DASHBOARD_HASH
                            }
                        }
                    });
                }
                if (data && data.currentUser && Array.isArray(data.currentUser.dropCampaigns) && data.currentUser.dropCampaigns.length > 0) {
                    if (includeAll && Array.isArray(data.rewardCampaignsAvailableToUser)) {
                        const merged = [...data.currentUser.dropCampaigns];
                        const seen = new Set(merged.map(c => c.id));
                        for (const rc of data.rewardCampaignsAvailableToUser) {
                            if (rc && rc.id && !seen.has(rc.id)) {
                                seen.add(rc.id);
                                merged.push(rc);
                            }
                        }
                        return finishList(merged);
                    }
                    return finishList(data.currentUser.dropCampaigns);
                }
                if (data && Array.isArray(data.dropCampaigns) && data.dropCampaigns.length > 0) {
                    return finishList(data.dropCampaigns);
                }
                if (includeAll && data && Array.isArray(data.rewardCampaignsAvailableToUser)) {
                    return finishList(data.rewardCampaignsAvailableToUser);
                }
                if (data && data.currentUser && Array.isArray(data.currentUser.dropCampaigns)) {
                    return finishList(data.currentUser.dropCampaigns);
                }
            } catch (e) {}
        }

        try {
            let data = await this.post({
                "operationName": "ViewerDropsDashboard",
                "variables": {
                    "fetchRewardCampaigns": true
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": DASHBOARD_HASH
                    }
                }
            }).catch(() => null);
            if (!data) {
                data = await this.post({
                    "operationName": "ViewerDropsDashboard",
                    "variables": {
                        "fetchRewardCampaigns": true
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": LEGACY_DASHBOARD_HASH
                        }
                    }
                });
            }
            if (includeAll) {
                const merged = [];
                const seen = new Set();
                const list1 = (data && Array.isArray(data.dropCampaigns)) ? data.dropCampaigns : [];
                const list2 = (data && Array.isArray(data.rewardCampaignsAvailableToUser)) ? data.rewardCampaignsAvailableToUser : [];
                const list3 = (data && data.currentUser && Array.isArray(data.currentUser.dropCampaigns)) ? data.currentUser.dropCampaigns : [];
                for (const c of [...list1, ...list2, ...list3]) {
                    if (c && c.id && !seen.has(c.id)) {
                        seen.add(c.id);
                        merged.push(c);
                    }
                }
                if (merged.length > 0) return finishList(merged);
            }
            if (data && Array.isArray(data.dropCampaigns) && data.dropCampaigns.length > 0) return finishList(data.dropCampaigns);
            if (data && Array.isArray(data.rewardCampaignsAvailableToUser) && data.rewardCampaignsAvailableToUser.length > 0) return finishList(data.rewardCampaignsAvailableToUser);
            if (data && data.currentUser && Array.isArray(data.currentUser.dropCampaigns)) return finishList(data.currentUser.dropCampaigns);
        } catch (e) {}

        return [];
    }

    async getAllDropCampaigns(includeRewardCampaigns = false) {
        return this.getDropCampaigns(includeRewardCampaigns);
    }

    async getConnectedGames() {
        const campaigns = await this.getDropCampaigns();
        const games = [];
        const now = getTwitchNow();
        if (Array.isArray(campaigns)) {
            for (const campaign of campaigns) {
                if (campaign && campaign.game && campaign.status !== "EXPIRED") {
                    const endTs = campaign.endAt ? new Date(campaign.endAt).getTime() : (campaign.endsAt ? new Date(campaign.endsAt).getTime() : NaN);
                    if (!isNaN(endTs) && endTs <= now) {
                        continue;
                    }
                    if (Array.isArray(campaign.timeBasedDrops) && campaign.timeBasedDrops.length > 0) {
                        const dropsWithEnd = campaign.timeBasedDrops.filter(d => d && (d.endAt || d.endsAt));
                        if (dropsWithEnd.length > 0 && dropsWithEnd.length === campaign.timeBasedDrops.length) {
                            const allDropsEnded = dropsWithEnd.every(d => {
                                const dEnd = d.endAt ? new Date(d.endAt).getTime() : (d.endsAt ? new Date(d.endsAt).getTime() : NaN);
                                return !isNaN(dEnd) && dEnd <= now;
                            });
                            if (allDropsEnded) continue;
                        }
                    }
                    games.push(campaign);
                }
            }
        }
        return games;
    }

    async getDropCampaignDetails(dropId) {
        if (!dropId) return null;
        if (!this.userId && this.oauthToken) {
            await this.autoDetectUserId().catch(() => {});
        }
        try {
            if (typeof dropId === "string") {
                const payload = {
                    "operationName": "DropCampaignDetails",
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1"
                        }
                    },
                    "variables": {
                        "dropID": dropId,
                        "channelLogin": this.userId || ""
                    }
                };
                const data = this.oauthToken
                    ? await this.postAuthorized(payload).catch(() => this.post(payload))
                    : await this.post(payload);
                return data && data.user ? data.user.dropCampaign : (data?.dropCampaign || null);
            } else if (Array.isArray(dropId)) {
                if (dropId.length === 0) return [];
                const dataAry = dropId.map(camp => ({
                    "operationName": "DropCampaignDetails",
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1"
                        }
                    },
                    "variables": {
                        "dropID": camp,
                        "channelLogin": this.userId || ""
                    }
                }));
                const data = this.oauthToken
                    ? await this.postAuthorized(dataAry).catch(() => this.post(dataAry))
                    : await this.post(dataAry);
                return Array.isArray(data) ? data : [];
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    async getInventory() {
        const INVENTORY_HASH = "8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404";
        const LEGACY_INVENTORY_HASH = "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b";
        try {
            let data = await this.postAuthorized({
                "operationName": "Inventory",
                "variables": {
                    "fetchRewardCampaigns": false
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": INVENTORY_HASH
                    }
                }
            });
            let inv = data && data.currentUser ? data.currentUser.inventory : null;
            if (!inv && data && data.currentUser && data.currentUser.id) {
                const fallbackData = await this.postAuthorized({
                    "operationName": "Inventory",
                    "variables": {
                        "fetchRewardCampaigns": false
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": LEGACY_INVENTORY_HASH
                        }
                    }
                }).catch(() => null);
                if (fallbackData && fallbackData.currentUser && fallbackData.currentUser.inventory) {
                    inv = fallbackData.currentUser.inventory;
                }
            }
            if (inv) {
                if (!inv.gameEventDrops && inv.gameEventDropsConnection?.edges) {
                    inv.gameEventDrops = inv.gameEventDropsConnection.edges
                        .map(e => e?.node)
                        .filter(Boolean);
                }
                if (!Array.isArray(inv.gameEventDrops)) {
                    inv.gameEventDrops = [];
                }
                if (!Array.isArray(inv.dropCampaignsInProgress)) {
                    inv.dropCampaignsInProgress = [];
                }
            }
            return inv;
        } catch (e) {
            return null;
        }
    }

    async getActiveStreams(gameName, slug) {
        try {
            let gameSlug = slug;
            if (!gameSlug && gameName) {
                gameSlug = gameName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
                if (gameSlug.startsWith("-")) gameSlug = gameSlug.slice(1);
                if (gameSlug.endsWith("-")) gameSlug = gameSlug.slice(0, -1);
            }
            if (!gameSlug) return [];

            const queryDirectory = async (name, s) => {
                const data = await this.post({
                    "operationName": "DirectoryPage_Game",
                    "variables": {
                        "game": (name || "").toLowerCase(),
                        "slug": s,
                        "options": {
                            "includeRestricted": ["SUB_ONLY_LIVE"],
                            "sort": "VIEWER_COUNT",
                            "tags": ["c2542d6d-cd10-4532-919b-3d19f30a768b"],
                            "recommendationsContext": {
                                "platform": "web"
                            },
                            "requestID": "JIRA-VXP-2397"
                        },
                        "sortTypeIsRecency": false,
                        "includeCostreaming": true,
                        "limit": 30
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": "76cb069d835b8a02914c08dc42c421d0dafda8af5b113a3f19141824b901402f"
                        }
                    }
                });

                const edges = data?.game?.streams?.edges || (Array.isArray(data) ? data?.[0]?.data?.game?.streams?.edges : []) || [];
                const result = [];
                for (const edge of edges) {
                    const node = edge?.node || edge;
                    const broadcaster = node?.broadcaster;
                    if (broadcaster && broadcaster.login) {
                        result.push({
                            broadcaster: {
                                login: broadcaster.login,
                                displayName: broadcaster.displayName || broadcaster.login
                            }
                        });
                    }
                }
                return result;
            };

            let result = await queryDirectory(gameName, gameSlug);

            // If no streams found and this is Overwatch / Overwatch 2, fallback to alternate slug/name
            if (result.length === 0 && isOverwatchGame(gameName || gameSlug)) {
                const altSlug = (gameSlug === "overwatch" || gameSlug === "overwatch-1") ? "overwatch-2" : "overwatch";
                const altName = altSlug === "overwatch-2" ? "Overwatch 2" : "Overwatch";
                try {
                    const altResult = await queryDirectory(altName, altSlug);
                    if (Array.isArray(altResult) && altResult.length > 0) {
                        result = altResult;
                    }
                } catch (err) {}
            }

            return result;
        } catch (e) {
            return [];
        }
    }

    async claimDropReward(dropInstanceId) {
        if (!dropInstanceId) {
            throw new TwitchApiError("dropInstanceID is required", {
                operationName: "DropsPage_ClaimDropRewards"
            });
        }
        const data = await this.postAuthorized({
            "operationName": "DropsPage_ClaimDropRewards",
            "variables": {
                "input": {
                    "dropInstanceID": String(dropInstanceId)
                }
            },
            "extensions": {
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930"
                }
            }
        });

        const status = data?.claimDropReward?.status || (data?.claimDropReward ? "SUCCESS" : null);
        if (status) {
            const isSuccess = status === "SUCCESS" || status === "ELIGIBLE_FOR_CLAIM" || status === "DROP_INSTANCE_ALREADY_CLAIMED";
            return {
                status: status,
                dropInstanceID: String(dropInstanceId),
                success: isSuccess
            };
        }

        throw new TwitchApiError("Failed to claim drop reward: empty or invalid response", {
            operationName: "DropsPage_ClaimDropRewards"
        });
    }

    async claimChannelPoints(channelIdOrClaimId, claimIdOrChannelId) {
        let channelID = channelIdOrClaimId;
        let claimID = claimIdOrChannelId;

        if (typeof channelIdOrClaimId === "object" && channelIdOrClaimId !== null) {
            channelID = channelIdOrClaimId.channelID || channelIdOrClaimId.channelId;
            claimID = channelIdOrClaimId.claimID || channelIdOrClaimId.claimId;
        } else if (typeof channelIdOrClaimId === "string" && channelIdOrClaimId.includes("-") && typeof claimIdOrChannelId === "string" && !claimIdOrChannelId.includes("-")) {
            claimID = channelIdOrClaimId;
            channelID = claimIdOrChannelId;
        }

        if (!channelID || !claimID) {
            throw new TwitchApiError("Both channelID and claimID are required to claim community points", {
                operationName: "ClaimCommunityPoints"
            });
        }

        const data = await this.postAuthorized({
            "operationName": "ClaimCommunityPoints",
            "variables": {
                "input": {
                    "channelID": String(channelID),
                    "claimID": String(claimID)
                }
            },
            "extensions": {
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0"
                }
            }
        });

        if (data && data.claimCommunityPoints) {
            if (data.claimCommunityPoints.error) {
                throw new TwitchApiError(`Claim community points error: ${data.claimCommunityPoints.error.code || 'UNKNOWN'}`, {
                    operationName: "ClaimCommunityPoints",
                    errors: [data.claimCommunityPoints.error]
                });
            }
            const claim = data.claimCommunityPoints.claim;
            const status = claim?.status || "SUCCESS";
            const points = claim?.pointsEarnedTotal ?? (claim?.pointsEarned ?? 50);
            return {
                claimID: String(claimID),
                status: status,
                points: points,
                success: status === "SUCCESS" || status === "CLAIMED"
            };
        }

        throw new TwitchApiError("Invalid claim community points response", {
            operationName: "ClaimCommunityPoints"
        });
    }

    async getStream(username) {
        if (!username) return null;
        try {
            if (typeof username === "string") {
                const data = await this.post({
                    "operationName": "ChannelShell",
                    "variables": {
                        "login": username
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": "580ab410bcd0c1ad194224957ae2241e5d252b2c5173d8e0cce9d32d5bb14efe"
                        }
                    }
                });
                return data && data.userOrError ? data.userOrError.stream : null;
            } else if (Array.isArray(username)) {
                if (username.length === 0) return [];
                const dataAry = username.map(user => ({
                    "operationName": "ChannelShell",
                    "variables": {
                        "login": user
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": "580ab410bcd0c1ad194224957ae2241e5d252b2c5173d8e0cce9d32d5bb14efe"
                        }
                    }
                }));
                return await this.post(dataAry);
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    async getAllLiveForGame(gameName) {
        try {
            const streams = await this.getActiveStreams(gameName, null);
            return streams.map(s => ({
                data: {
                    userOrError: {
                        login: s.broadcaster.login,
                        stream: {}
                    }
                }
            }));
        } catch (e) {
            return [];
        }
    }

    async getChannelWithDrops(gameName, campaignId, slug, skippedLogins = []) {
        const streams = await this.getActiveStreams(gameName, slug);
        if (Array.isArray(streams) && streams.length > 0) {
            const available = streams.filter(s => !skippedLogins.includes(s.broadcaster.login));
            if (available.length > 0) {
                return available[0];
            }
            return streams[0];
        }
        return null;
    }

    async getLiveBroadcasterForCampaign(gameName, campaignId, slug, allowedStreamers = [], skippedLogins = []) {
        const skippedLower = (Array.isArray(skippedLogins) ? skippedLogins : []).map(s => String(s).toLowerCase());

        // 1. If campaign specifies allowed channels, ONLY those channels are eligible for drops
        if (Array.isArray(allowedStreamers) && allowedStreamers.length > 0) {
            const available = allowedStreamers.filter(s => s && typeof s === "string" && !skippedLower.includes(s.toLowerCase()));
            const listToCheck = available.length > 0 ? available : allowedStreamers.filter(s => s && typeof s === "string");

            if (listToCheck.length === 0) return null;

            const isStreamPlayingTargetGame = (streamObj) => {
                if (!streamObj) return false;
                const streamGame = streamObj.game?.displayName || streamObj.game?.name;
                // If ChannelShell includes the game name, verify it matches target game (or Special Events for official broadcasts)
                if (streamGame && gameName) {
                    if (streamGame.toLowerCase() === "special events") return true;
                    return areGameNamesMatching(streamGame, gameName);
                }
                return true;
            };

            if (listToCheck.length === 1) {
                const stream = await this.getStream(listToCheck[0]);
                if (stream && isStreamPlayingTargetGame(stream)) {
                    return listToCheck[0];
                }
                return null;
            } else {
                const batch = listToCheck.slice(0, 30);
                const res = await this.getStream(batch);
                if (Array.isArray(res)) {
                    for (let i = 0; i < res.length; i++) {
                        const item = res[i];
                        const streamObj = item?.data?.userOrError?.stream;
                        if (streamObj && isStreamPlayingTargetGame(streamObj)) {
                            return batch[i];
                        }
                    }
                }
                return null;
            }
        }

        // 2. Open campaign (no channel restrictions) -> query category streams with drops tag
        const channel = await this.getChannelWithDrops(gameName, campaignId, slug, skippedLogins);
        if (channel && channel.broadcaster && channel.broadcaster.login) {
            return channel.broadcaster.login;
        }

        return null;
    }


    async getStreamMetadata(channelLogin) {
        if (!channelLogin) return { login: "" };
        const login = String(channelLogin).toLowerCase();

        const queryOverlayMeta = async () => {
            const overlayData = await this.post({
                "operationName": "VideoPlayerStreamInfoOverlayChannel",
                "variables": {
                    "channel": login
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d"
                    }
                }
            });
            return overlayData?.user || null;
        };

        try {
            const data = await this.post({
                "operationName": "ChannelShell",
                "variables": {
                    "login": channelLogin
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "580ab410bcd0c1ad194224957ae2241e5d252b2c5173d8e0cce9d32d5bb14efe"
                    }
                }
            });
            const userObj = data?.userOrError;
            const stream = userObj?.stream;
            if (stream) {
                let channelId = userObj?.id ? String(userObj.id) : undefined;
                let broadcastId = stream.id ? String(stream.id) : undefined;
                let game = stream.game?.displayName || stream.game?.name;
                let gameId = stream.game?.id ? String(stream.game.id) : undefined;
                let title = stream.title || "";
                let viewers = stream.viewersCount || 0;

                // ChannelShell in production Twitch GQL only returns stream ID & viewersCount without game.
                // Fetch stream game details via PersistedQuery VideoPlayerStreamInfoOverlayChannel (with GetChannelStream fallback).
                if (!game) {
                    try {
                        const overlayUser = await queryOverlayMeta();
                        if (overlayUser) {
                            if (overlayUser.id && !channelId) channelId = String(overlayUser.id);
                            if (overlayUser.stream?.id && !broadcastId) broadcastId = String(overlayUser.stream.id);
                            if (overlayUser.stream?.viewersCount) viewers = overlayUser.stream.viewersCount;
                            const bs = overlayUser.broadcastSettings;
                            if (bs) {
                                if (bs.title) title = bs.title;
                                if (bs.game) {
                                    game = bs.game.displayName || bs.game.name;
                                    if (bs.game.id) gameId = String(bs.game.id);
                                }
                            }
                        }
                    } catch (err) {}
                }

                if (!game) {
                    try {
                        const directData = await this.post({
                            "operationName": "GetChannelStream",
                            "query": "query GetChannelStream($login: String!) { user(login: $login) { id login stream { id game { id name displayName } title viewersCount type } } }",
                            "variables": { "login": channelLogin }
                        });
                        const directUser = directData?.user;
                        const directStream = directUser?.stream;
                        if (directUser?.id && !channelId) channelId = String(directUser.id);
                        if (directStream) {
                            if (directStream.id && !broadcastId) broadcastId = String(directStream.id);
                            if (directStream.game) {
                                game = directStream.game.displayName || directStream.game.name;
                                if (directStream.game.id) gameId = String(directStream.game.id);
                                title = directStream.title || title;
                                viewers = directStream.viewersCount || viewers;
                            }
                        }
                    } catch (err) {}
                }

                return {
                    login: channelLogin,
                    channelId: channelId,
                    broadcastId: broadcastId,
                    game: game || undefined,
                    gameId: gameId,
                    title: title,
                    viewers: viewers
                };
            }
        } catch (e) {}

        // Fallback 1: PersistedQuery VideoPlayerStreamInfoOverlayChannel if ChannelShell failed
        try {
            const overlayUser = await queryOverlayMeta();
            if (overlayUser && overlayUser.stream) {
                const bs = overlayUser.broadcastSettings;
                return {
                    login: channelLogin,
                    channelId: overlayUser.id ? String(overlayUser.id) : undefined,
                    broadcastId: overlayUser.stream.id ? String(overlayUser.stream.id) : undefined,
                    game: bs?.game?.displayName || bs?.game?.name || undefined,
                    gameId: bs?.game?.id ? String(bs.game.id) : undefined,
                    title: bs?.title || "",
                    viewers: overlayUser.stream.viewersCount || 0
                };
            }
        } catch (err) {}

        // Fallback 2: direct GraphQL query if persisted queries failed or returned null
        try {
            const directData = await this.post({
                "operationName": "GetChannelStream",
                "query": "query GetChannelStream($login: String!) { user(login: $login) { id login stream { id game { id name displayName } title viewersCount type } } }",
                "variables": { "login": channelLogin }
            });
            const directUser = directData?.user;
            const directStream = directUser?.stream;
            if (directStream) {
                return {
                    login: channelLogin,
                    channelId: directUser?.id ? String(directUser.id) : undefined,
                    broadcastId: directStream.id ? String(directStream.id) : undefined,
                    game: directStream.game?.displayName || directStream.game?.name || undefined,
                    gameId: directStream.game?.id ? String(directStream.game.id) : undefined,
                    title: directStream.title || "",
                    viewers: directStream.viewersCount || 0
                };
            }
        } catch (err) {}

        return { login: channelLogin };
    }

    /**
     * Headless Watch Engine (TwitchDropsMiner method):
     * 1. Fetch stream PlaybackAccessToken via GQL (with platform: "web" & playerType: "site")
     * 2. Fetch master HLS playlist from usher.ttvnw.net and pick lowest-quality variant URL
     * 3. Fetch variant .m3u8 playlist and send HEAD request to latest .ts transport segment
     * 4. Fallback/secondary: POST Base64-encoded "minute-watched" payload to Spade beacon URL
     * 5. Query DropCurrentSessionContext to bind/read real-time currentMinutesWatched for the channel
     */
    async getPlaybackAccessToken(channelLogin) {
        if (!channelLogin) return null;
        const login = String(channelLogin).toLowerCase();
        try {
            const data = await this.postAuthorized({
                "operationName": "PlaybackAccessToken",
                "variables": {
                    "isLive": true,
                    "login": login,
                    "isVod": false,
                    "vodID": "",
                    "platform": "web",
                    "playerType": "site"
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                    }
                }
            });
            const token = data?.streamPlaybackAccessToken;
            if (token && token.value && token.signature) {
                return { value: token.value, signature: token.signature };
            }
        } catch (e) {}

        // Fallback to raw GQL query if persistedQuery hash is rejected or unavailable
        try {
            const fallbackData = await this.postAuthorized({
                "operationName": "PlaybackAccessToken_Template",
                "query": "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename } }",
                "variables": {
                    "isLive": true,
                    "login": login,
                    "isVod": false,
                    "vodID": "",
                    "platform": "web",
                    "playerType": "site"
                }
            });
            const token = fallbackData?.streamPlaybackAccessToken;
            if (token && token.value && token.signature) {
                return { value: token.value, signature: token.signature };
            }
        } catch (e) {}

        return null;
    }

    async getStreamUrl(channelLogin) {
        if (!channelLogin) return null;
        const login = String(channelLogin).toLowerCase();
        const token = await this.getPlaybackAccessToken(login);
        if (!token) return null;

        // Match TwitchDropsMiner Usher request: omit fast_bread and allow_audio_only so Twitch
        // returns standard 2s video segments (lowest: 160p30) that reliably advance Drop progress.
        const params = new URLSearchParams({
            sig: token.signature,
            token: token.value
        });

        const usherUrl = `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(login)}.m3u8?${params.toString()}`;
        try {
            const res = await fetch(usherUrl, { method: "GET" });
            if (!res || !res.ok) return null;
            const playlistText = await res.text();
            if (!playlistText) return null;

            const trimmed = playlistText.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                return null;
            }

            const rawLines = trimmed
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(l => l.length > 0);

            const videoUrls = [];
            const allUrls = [];
            let pendingAudioOnly = false;

            for (const line of rawLines) {
                if (line.startsWith("#")) {
                    if (line.startsWith("#EXT-X-STREAM-INF") || line.startsWith("#EXT-X-MEDIA")) {
                        if (/audio_only/i.test(line)) {
                            pendingAudioOnly = true;
                        }
                    }
                } else {
                    allUrls.push(line);
                    if (!pendingAudioOnly && !/audio_only/i.test(line)) {
                        videoUrls.push(line);
                    }
                    pendingAudioOnly = false;
                }
            }

            const candidates = videoUrls.length > 0 ? videoUrls : allUrls;
            if (candidates.length === 0) return null;
            // Twitch lists lowest-resolution video variant (e.g. 160p30) last among video variants
            return candidates[candidates.length - 1];
        } catch (e) {
            return null;
        }
    }

    async sendWatchPlaylist(channelLogin) {
        if (!channelLogin) return false;
        const login = String(channelLogin).toLowerCase();
        if (!this._streamUrlCache) this._streamUrlCache = new Map();

        let variantUrl = this._streamUrlCache.get(login);
        let variantText = null;

        if (variantUrl) {
            try {
                const res = await fetch(variantUrl, { method: "GET" });
                if (res && res.ok) {
                    variantText = await res.text();
                    const trimmed = (variantText || "").trim();
                    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) {
                        this._streamUrlCache.delete(login);
                        variantUrl = null;
                        variantText = null;
                    }
                } else {
                    this._streamUrlCache.delete(login);
                    variantUrl = null;
                }
            } catch (e) {
                this._streamUrlCache.delete(login);
                variantUrl = null;
            }
        }

        if (!variantUrl) {
            variantUrl = await this.getStreamUrl(login);
            if (!variantUrl) return false;
            try {
                const res = await fetch(variantUrl, { method: "GET" });
                if (!res || !res.ok) return false;
                variantText = await res.text();
                const trimmed = (variantText || "").trim();
                if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) {
                    return false;
                }
                this._streamUrlCache.set(login, variantUrl);
            } catch (e) {
                return false;
            }
        }

        if (!variantText) return false;
        // Strip any inline JSON "url": "...", fragments inside Twitch DATERANGE tags (matches TwitchDropsMiner channel.py)
        const cleanedVariantText = variantText.replace(/"url"\s*:\s*"[^"]*",?/g, "");
        const lines = cleanedVariantText
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith("#"));

        if (lines.length === 0) {
            this._streamUrlCache.delete(login);
            return false;
        }

        const segmentUrls = [];
        for (const rawSeg of lines) {
            if (/^https?:\/\//i.test(rawSeg)) {
                segmentUrls.push(rawSeg);
            } else {
                try {
                    segmentUrls.push(new URL(rawSeg, variantUrl).toString());
                } catch (e) {}
            }
        }

        if (segmentUrls.length === 0) {
            this._streamUrlCache.delete(login);
            return false;
        }

        try {
            // Send HEAD requests to all segment chunks in the variant playlist (matches TwitchDropsMiner f693b0c)
            const headResults = await Promise.allSettled(
                segmentUrls.map(segUrl => fetch(segUrl, { method: "HEAD" }))
            );
            const anyHeadOk = headResults.some(
                r => r.status === "fulfilled" && r.value && (r.value.ok || r.value.status === 200 || r.value.status === 206)
            );
            if (anyHeadOk) {
                return true;
            }
            // Fallback to GET on the latest segment if HEAD is disallowed by edge node
            const lastSegUrl = segmentUrls[segmentUrls.length - 1];
            const getRes = await fetch(lastSegUrl, { method: "GET" });
            return Boolean(getRes && getRes.ok);
        } catch (e) {
            this._streamUrlCache.delete(login);
            return false;
        }
    }

    async getSpadeUrl(channelLogin) {
        const DEFAULT_SPADE_URL = "https://spade.twitch.tv/track";
        if (!channelLogin) return DEFAULT_SPADE_URL;
        const login = String(channelLogin).toLowerCase();
        if (!this._spadeUrlCache) this._spadeUrlCache = new Map();

        if (this._spadeUrlCache.has(login)) {
            return this._spadeUrlCache.get(login);
        }

        const spadeRegex = /"(?:spade|beacon)_?url"\s*:\s*"(https:\/\/[^"]+)"/i;
        const settingsJsRegex = /https:\/\/[\w./-]+\/config\/settings\.[0-9a-f]+\.js/i;

        for (const pageUrl of [
            `https://www.twitch.tv/${encodeURIComponent(login)}`,
            `https://m.twitch.tv/${encodeURIComponent(login)}`
        ]) {
            try {
                const pageRes = await fetch(pageUrl, { method: "GET" });
                if (pageRes && pageRes.ok) {
                    const html = await pageRes.text();
                    const directMatch = html.match(spadeRegex);
                    if (directMatch && directMatch[1]) {
                        this._spadeUrlCache.set(login, directMatch[1]);
                        return directMatch[1];
                    }
                    const settingsMatch = html.match(settingsJsRegex);
                    const settingsUrl = settingsMatch ? (settingsMatch[1] || settingsMatch[0]) : null;
                    if (settingsUrl) {
                        const jsRes = await fetch(settingsUrl, { method: "GET" });
                        if (jsRes && jsRes.ok) {
                            const jsText = await jsRes.text();
                            const jsSpadeMatch = jsText.match(spadeRegex);
                            if (jsSpadeMatch && jsSpadeMatch[1]) {
                                this._spadeUrlCache.set(login, jsSpadeMatch[1]);
                                return jsSpadeMatch[1];
                            }
                        }
                    }
                }
            } catch (e) {}
        }

        this._spadeUrlCache.set(login, DEFAULT_SPADE_URL);
        return DEFAULT_SPADE_URL;
    }

    async sendWatchSpade(channelLogin, streamMeta = {}) {
        if (!channelLogin) return false;
        const login = String(channelLogin).toLowerCase();

        let broadcastId = streamMeta?.broadcastId;
        let channelId = streamMeta?.channelId;
        let gameName = streamMeta?.game;
        let gameId = streamMeta?.gameId;

        if (!broadcastId || !channelId) {
            try {
                const meta = await this.getStreamMetadata(login);
                broadcastId = broadcastId || meta?.broadcastId;
                channelId = channelId || meta?.channelId;
                gameName = gameName || meta?.game;
                gameId = gameId || meta?.gameId;
            } catch (e) {}
        }

        if (!broadcastId || !channelId) return false;

        if (!this.userId && this.oauthToken) {
            try {
                await this.autoDetectUserId();
            } catch (e) {}
        }

        const spadeUrl = await this.getSpadeUrl(login);
        const payload = [
            {
                event: "minute-watched",
                properties: {
                    broadcast_id: String(broadcastId),
                    channel_id: String(channelId),
                    channel: login,
                    client_time: new Date().toISOString(),
                    ...(gameName ? { game: String(gameName) } : {}),
                    ...(gameId ? { game_id: String(gameId) } : {}),
                    hidden: false,
                    is_live: true,
                    live: true,
                    location: "channel",
                    logged_in: true,
                    minutes_logged: 1,
                    muted: false,
                    player: "site",
                    ...(this.userId ? { user_id: Number(this.userId) || String(this.userId) } : {})
                }
            }
        ];

        const jsonStr = JSON.stringify(payload);
        let base64Data;
        if (typeof btoa === "function") {
            base64Data = btoa(jsonStr);
        } else {
            base64Data = Buffer.from(jsonStr, "utf8").toString("base64");
        }

        try {
            const res = await fetch(spadeUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: `data=${encodeURIComponent(base64Data)}`
            });
            return Boolean(res && (res.status === 204 || res.ok));
        } catch (e) {
            return false;
        }
    }

    async getCurrentDropSession(channelId = "", channelLogin = "") {
        if (!this.oauthToken) return null;
        try {
            const data = await this.postAuthorized({
                "operationName": "DropCurrentSessionContext",
                "variables": {
                    "channelID": channelId ? String(channelId) : "",
                    "channelLogin": channelId ? "" : String(channelLogin || "").toLowerCase()
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b"
                    }
                }
            });
            return data?.currentUser?.dropCurrentSession || null;
        } catch (e) {
            return null;
        }
    }

    async sendWatch(channelLogin, streamMeta = {}) {
        if (!channelLogin) return { success: false, method: "none" };
        // Primary method: playlist HEAD requests to all chunks (matches TwitchDropsMiner commit f693b0c)
        const hlsOk = await this.sendWatchPlaylist(channelLogin);
        if (hlsOk) {
            return { success: true, method: "hls", spade: false };
        }
        // Fallback: Spade minute-watched beacon only if HLS playlist pulse failed
        const spadeOk = await this.sendWatchSpade(channelLogin, streamMeta);
        if (spadeOk) {
            return { success: true, method: "spade", spade: true };
        }
        return { success: false, method: "none" };
    }

    isCampaignActiveWithDrops(campaign, now = getTwitchNow(), inventory = null) {
        return isCampaignActiveWithDrops(campaign, now, inventory);
    }

    isCampaignFarmable(campaign, now = getTwitchNow()) {
        return isCampaignFarmable(campaign, now);
    }
}

export function isCampaignActiveWithDrops(c, now = getTwitchNow(), inventory = null) {
    if (!c) return false;
    if (c.status !== "ACTIVE") return false;

    // Check time window if dates exist
    if (c.startAt) {
        const startTs = new Date(c.startAt).getTime();
        if (!isNaN(startTs) && startTs > now) return false;
    }
    const campEnd = c.endAt ? new Date(c.endAt).getTime() : (c.endsAt ? new Date(c.endsAt).getTime() : NaN);
    if (!isNaN(campEnd) && campEnd <= now) return false;

    // If timeBasedDrops is an array:
    // Empty array means NO drops are available (e.g. external promo campaigns with 0 drops)
    if (Array.isArray(c.timeBasedDrops)) {
        if (c.timeBasedDrops.length === 0) return false;

        // If all drops with specified end dates have ended, campaign is not active
        const dropsWithEnd = c.timeBasedDrops.filter(drop => drop && (drop.endAt || drop.endsAt));
        if (dropsWithEnd.length > 0 && dropsWithEnd.length === c.timeBasedDrops.length) {
            const allEnded = dropsWithEnd.every(drop => {
                const dropEnd = drop.endAt ? new Date(drop.endAt).getTime() : (drop.endsAt ? new Date(drop.endsAt).getTime() : NaN);
                return !isNaN(dropEnd) && dropEnd <= now;
            });
            if (allEnded) return false;
        }

        const hasUnclaimed = c.timeBasedDrops.some(drop => {
            if (!drop) return false;
            // Check if this specific drop has ended
            const dropEnd = drop.endAt ? new Date(drop.endAt).getTime() : (drop.endsAt ? new Date(drop.endsAt).getTime() : NaN);
            if (!isNaN(dropEnd) && dropEnd <= now) return false;

            const isClaimed = Boolean(drop.self && drop.self.isClaimed);
            const watched = drop.self?.currentMinutesWatched || 0;
            const req = drop.requiredMinutesWatched || 60;
            return !isClaimed && (req <= 0 || watched < req);
        });
        if (!hasUnclaimed) return false;
    }

    // Check inventory for completion if inventory is provided
    if (inventory && typeof inventory === "object") {
        const inProgressList = Array.isArray(inventory.dropCampaignsInProgress) ? inventory.dropCampaignsInProgress : [];
        let inProg = c.id ? inProgressList.find(p => p && p.id === c.id) : null;
        if (!inProg) {
            const cDropIds = new Set((Array.isArray(c.timeBasedDrops) ? c.timeBasedDrops : []).map(d => d?.id).filter(Boolean));
            inProg = inProgressList.find(p => {
                if (!p) return false;
                if (c.id && p.id && p.id !== c.id) {
                    if (cDropIds.size > 0 && Array.isArray(p.timeBasedDrops)) {
                        return p.timeBasedDrops.some(d => d?.id && cDropIds.has(d.id));
                    }
                    return false;
                }
                return Boolean(p.game && areGameNamesMatching(p.game.displayName || p.game.name, c.game?.displayName || c.game?.name));
            });
        }

        if (inProg) {
            // Check if in-progress campaign is expired by endAt, endsAt or status
            const inProgEnd = inProg.endAt ? new Date(inProg.endAt).getTime() : (inProg.endsAt ? new Date(inProg.endsAt).getTime() : NaN);
            if (!isNaN(inProgEnd) && inProgEnd <= now) return false;
            if (inProg.status && inProg.status !== "ACTIVE") return false;

            if (Array.isArray(inProg.timeBasedDrops) && inProg.timeBasedDrops.length > 0) {
                // If all in-progress drops with end dates have ended, campaign is closed
                const inProgDropsWithEnd = inProg.timeBasedDrops.filter(drop => drop && (drop.endAt || drop.endsAt));
                if (inProgDropsWithEnd.length > 0 && inProgDropsWithEnd.length === inProg.timeBasedDrops.length) {
                    const allInProgEnded = inProgDropsWithEnd.every(drop => {
                        const dropEnd = drop.endAt ? new Date(drop.endAt).getTime() : (drop.endsAt ? new Date(drop.endsAt).getTime() : NaN);
                        return !isNaN(dropEnd) && dropEnd <= now;
                    });
                    if (allInProgEnded) return false;
                }

                const eventDropsList = Array.isArray(inventory.gameEventDrops) ? inventory.gameEventDrops : [];
                const hasUnclaimedInProg = inProg.timeBasedDrops.some(drop => {
                    if (!drop) return false;
                    const dropEnd = drop.endAt ? new Date(drop.endAt).getTime() : (drop.endsAt ? new Date(drop.endsAt).getTime() : NaN);
                    if (!isNaN(dropEnd) && dropEnd <= now) return false;

                    const isSelfClaimed = Boolean(drop.self && drop.self.isClaimed);
                    const watched = drop.self?.currentMinutesWatched || 0;
                    const req = drop.requiredMinutesWatched || 60;

                    // Also verify against claimed gameEventDrops
                    let isEventClaimed = false;
                    if (eventDropsList.length > 0) {
                        const dropId = (drop.id || "").toLowerCase();
                        const benId = (drop.benefitEdges && drop.benefitEdges[0] ? (drop.benefitEdges[0].benefit?.id || drop.benefitEdges[0].node?.id) : "")?.toLowerCase();
                        isEventClaimed = eventDropsList.some(evt => {
                            if (!evt) return false;
                            const eId = (evt.id || "").toLowerCase();
                            const ebId = (evt.benefitId || "").toLowerCase();
                            return (dropId && (eId === dropId || ebId === dropId)) || (benId && (eId === benId || ebId === benId));
                        });
                    }

                    const isClaimed = isSelfClaimed || isEventClaimed;
                    return !isClaimed && (req <= 0 || watched < req);
                });
                if (!hasUnclaimedInProg) return false;
            }
        }
    }

    return true;
}

export function isOverwatchGame(name) {
    if (!name || typeof name !== "string") return false;
    const clean = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return clean === "overwatch" || clean === "overwatch2";
}

export function areGameNamesMatching(gameA, gameB) {
    if (!gameA || !gameB) return false;
    if (typeof gameA !== "string" || typeof gameB !== "string") return false;

    const a = gameA.trim();
    const b = gameB.trim();
    if (!a || !b) return false;
    if (a.toLowerCase() === b.toLowerCase()) return true;

    if (isOverwatchGame(a) && isOverwatchGame(b)) {
        return true;
    }

    const normA = a.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normB = b.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!normA || !normB) return false;
    if (normA === normB) return true;

    if (normA.length >= 6 && normB.length >= 6) {
        if (normA.includes(normB) || normB.includes(normA)) {
            return true;
        }
    }

    return false;
}

export function isCampaignFarmable(camp, now = getTwitchNow()) {
    if (!camp || typeof camp !== "object") return false;

    // Check campaign overall end time
    const endMs = camp.endsAt ? new Date(camp.endsAt).getTime() : (camp.endAt ? new Date(camp.endAt).getTime() : NaN);
    if (!isNaN(endMs) && endMs <= now) return false;

    // Check status if present
    if (camp.status && camp.status !== "ACTIVE") return false;

    // Check items or timeBasedDrops
    const drops = Array.isArray(camp.items) ? camp.items : (Array.isArray(camp.drops) ? camp.drops : (Array.isArray(camp.timeBasedDrops) ? camp.timeBasedDrops : null));

    if (Array.isArray(drops)) {
        if (drops.length === 0) {
            if (typeof camp.minutesNeeded === "number" && camp.minutesNeeded > 0) {
                return (camp.minutesWatched || 0) < camp.minutesNeeded;
            }
            return false;
        }

        // Check if all drops with specified end dates have ended
        const dropsWithEnd = drops.filter(d => d && (d.endAt || d.endsAt));
        if (dropsWithEnd.length > 0 && dropsWithEnd.length === drops.length) {
            const allEnded = dropsWithEnd.every(d => {
                if (d.isEnded) return true;
                const dEnd = d.endsAt ? new Date(d.endsAt).getTime() : (d.endAt ? new Date(d.endAt).getTime() : NaN);
                return !isNaN(dEnd) && dEnd <= now;
            });
            if (allEnded) return false;
        }

        // Check if there is at least one drop that is unclaimed, unended, and watch time not satisfied
        const hasFarmableDrop = drops.some(drop => {
            if (!drop) return false;
            if (drop.isEnded) return false;

            const dEnd = drop.endsAt ? new Date(drop.endsAt).getTime() : (drop.endAt ? new Date(drop.endAt).getTime() : NaN);
            if (!isNaN(dEnd) && dEnd <= now) return false;

            const isClaimed = Boolean(drop.self && drop.self.isClaimed);
            if (isClaimed) return false;

            const watched = drop.self?.currentMinutesWatched || 0;
            const req = drop.reqTime || drop.requiredMinutesWatched || 60;
            return req <= 0 || watched < req;
        });

        return hasFarmableDrop;
    }

    if (typeof camp.minutesNeeded === "number" && camp.minutesNeeded > 0) {
        return (camp.minutesWatched || 0) < camp.minutesNeeded;
    }

    return true;
}