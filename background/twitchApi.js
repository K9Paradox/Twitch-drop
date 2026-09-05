/**
 * Twitch GQL & Internal API Client
 */

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

    async post(data) {
        const opName = this.extractOperationName(data);
        const headers = this.buildHeaders(false);

        const res = await fetch("https://gql.twitch.tv/gql", {
            method: "POST",
            headers: headers,
            body: JSON.stringify(data)
        });

        if (!res.ok) {
            throw new TwitchApiError(`Twitch GQL HTTP error ${res.status}: ${res.statusText}`, {
                status: res.status,
                operationName: opName
            });
        }

        const json = await res.json();
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

    async postAuthorized(data) {
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

        if (!res.ok) {
            throw new TwitchApiError(`Twitch GQL HTTP error ${res.status}: ${res.statusText}`, {
                status: res.status,
                operationName: opName
            });
        }

        const json = await res.json();
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
            }
        } catch (e) {}
        return this.userId;
    }

    async getGameIdFromName(name) {
        if (!name) return null;
        try {
            const data = await this.post({
                "operationName": "DirectoryRoot_Directory",
                "variables": {
                    "name": name.toLowerCase()
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
        } catch (e) {}
        return null;
    }

    async getDropCampaigns() {
        if (this.oauthToken) {
            try {
                const data = await this.postAuthorized({
                    "operationName": "ViewerDropsDashboard",
                    "variables": {
                        "fetchRewardCampaigns": true
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619"
                        }
                    }
                });
                if (data && data.currentUser && data.currentUser.dropCampaigns) {
                    return data.currentUser.dropCampaigns;
                }
                if (data && data.rewardCampaignsAvailableToUser) {
                    return data.rewardCampaignsAvailableToUser;
                }
                if (data && data.dropCampaigns) {
                    return data.dropCampaigns;
                }
            } catch (e) {}
        }

        try {
            const data = await this.post({
                "operationName": "ViewerDropsDashboard",
                "variables": {
                    "fetchRewardCampaigns": true
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619"
                    }
                }
            });
            if (data && data.dropCampaigns) return data.dropCampaigns;
            if (data && data.rewardCampaignsAvailableToUser) return data.rewardCampaignsAvailableToUser;
            if (data && data.currentUser && data.currentUser.dropCampaigns) return data.currentUser.dropCampaigns;
        } catch (e) {}

        return [];
    }

    async getConnectedGames() {
        const campaigns = await this.getDropCampaigns();
        const games = [];
        if (Array.isArray(campaigns)) {
            for (const campaign of campaigns) {
                if (campaign && campaign.game && campaign.status !== "EXPIRED") {
                    games.push(campaign);
                }
            }
        }
        return games;
    }

    async getDropCampaignDetails(dropId) {
        if (!dropId) return null;
        try {
            if (typeof dropId === "string") {
                const data = await this.postAuthorized({
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
                });
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
                const data = await this.postAuthorized(dataAry);
                return Array.isArray(data) ? data : [];
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    async getInventory() {
        try {
            const data = await this.postAuthorized({
                "operationName": "Inventory",
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b"
                    }
                }
            });
            const inv = data && data.currentUser ? data.currentUser.inventory : null;
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

            const data = await this.post({
                "operationName": "DirectoryPage_Game",
                "variables": {
                    "game": (gameName || "").toLowerCase(),
                    "slug": gameSlug,
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

    async getStreamMetadata(channelLogin) {
        if (!channelLogin) return { login: "" };
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
            const stream = data?.userOrError?.stream;
            if (stream) {
                return {
                    login: channelLogin,
                    game: stream.game?.displayName || stream.game?.name || "Twitch",
                    title: stream.title || "",
                    viewers: stream.viewersCount || 0
                };
            }
        } catch (e) {}
        return { login: channelLogin };
    }
}