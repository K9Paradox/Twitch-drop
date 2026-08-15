/**
 * Twitch GQL & Internal API Client
 */
export class Client {
    constructor(options = {}) {
        this.clientId = options?.clientId ?? "kimne78kx3ncx6brgo4mv6wki5h1ko";
        this.oauthToken = options?.oauthToken ?? null;
        this.deviceId = options?.deviceId ?? null;
        this.integrity = options?.integrity ?? null;
        this.userId = options?.userId ?? null;
        this.uuid = options?.uuid ?? null;
    }

    async post(data) {
        try {
            const headers = {
                "Client-Id": this.clientId,
                "Content-Type": "application/json"
            };
            if (this.deviceId) headers["X-Device-Id"] = this.deviceId;
            if (this.integrity?.token) headers["Client-Integrity"] = this.integrity.token;
            if (this.uuid) headers["Client-Session-Id"] = this.uuid;

            const res = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: headers,
                body: JSON.stringify(data)
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    async postAuthorized(data) {
        if (!this.oauthToken) return null;
        try {
            const headers = {
                "Client-Id": this.clientId,
                "Authorization": `OAuth ${this.oauthToken}`,
                "Content-Type": "application/json"
            };
            if (this.deviceId) headers["X-Device-Id"] = this.deviceId;
            if (this.integrity?.token) headers["Client-Integrity"] = this.integrity.token;
            if (this.uuid) headers["Client-Session-Id"] = this.uuid;

            const res = await fetch("https://gql.twitch.tv/gql", {
                method: "POST",
                headers: headers,
                body: JSON.stringify(data)
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    async getInteg() {
        if (!this.integrity || this.integrity.expiration - 960000 < Date.now()) {
            return false;
        }
        return this.integrity;
    }

    async setInteg(integ) {
        this.integrity = integ;
        await chrome.storage.local.set({ twitchInteg: integ }).catch(() => {});
    }

    async updateUserInfo(options) {
        this.clientId = options?.clientId ?? this.clientId;
        this.oauthToken = options?.oauthToken ?? this.oauthToken;
        this.deviceId = options?.deviceId ?? this.deviceId;
        this.userId = options?.userId ?? this.userId;
        this.uuid = options?.uuid ?? this.uuid;
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
                await chrome.storage.local.set({ userId: data.currentUser.id }).catch(() => {});
            }
        } catch (e) {}
        return this.userId;
    }

    async getGameIdFromName(name) {
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
            if (game) {
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
                return data && data.user ? data.user.dropCampaign : null;
            } else if (Array.isArray(dropId)) {
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
                return data || [];
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
            return data && data.currentUser ? data.currentUser.inventory : null;
        } catch (e) {
            return null;
        }
    }

    async getActiveStreams(gameName, slug) {
        try {
            const gameSlug = slug || gameName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
            const data = await this.post({
                "operationName": "DirectoryPage_Game",
                "variables": {
                    "name": gameSlug,
                    "options": {
                        "includeRestricted": [
                            "SUB_ONLY_LIVE"
                        ],
                        "sort": "VIEWER_COUNT",
                        "tags": ["c2542d6d-cd10-4532-919b-3d19f30a768b"]
                    },
                    "sortTypeIsRecency": false,
                    "limit": 50
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "76cb069d835b8a02914c08dc42c421d0dafda8af5b113a3f19141824b901402f"
                    }
                }
            });

            const edges = data?.game?.streams?.edges || data?.data?.game?.streams?.edges || [];
            const result = [];
            for (const edge of edges) {
                const broadcaster = edge?.node?.broadcaster;
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
        try {
            return await this.postAuthorized({
                "operationName": "DropsPage_ClaimDropRewards",
                "variables": {
                    "input": {
                        "dropInstanceID": dropInstanceId
                    }
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930"
                    }
                }
            });
        } catch (e) {
            return null;
        }
    }

    async claimChannelPoints(claimId, channelId) {
        try {
            const data = await this.postAuthorized({
                "operationName": "ClaimCommunityPoints",
                "variables": {
                    "input": {
                        "channelID": channelId,
                        "claimID": claimId
                    }
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0"
                    }
                }
            });
            if (data && data.claimCommunityPoints && data.claimCommunityPoints.error == null) {
                return {
                    success: true,
                    points: data.claimCommunityPoints.claim?.pointsEarnedTotal ?? 50
                };
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    async getStream(username) {
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