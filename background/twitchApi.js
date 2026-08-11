let tempVar = [];

export class Client {

    constructor(options) {
        this.clientId = options?.clientId ?? "kimne78kx3ncx6brgo4mv6wki5h1ko";
        this.oauthToken = options?.oauthToken;
        this.userId = options?.userId;
        this.deviceId = options?.deviceId;
        this.uuid = options?.uuid;

        this.integrity = {
            token: "",
            expiration: 0,
            request_id: ""
        };

        this.getIntegFromStorage();

        if (!this.userId) {
            this.getUserId();
        }
    }

    async postWraper(data, headers) {
        try {
            let post = await fetch("https://gql.twitch.tv/gql", {
                headers: headers,
                method: "POST",
                body: JSON.stringify(data)
            }).then((res) => res.json());

            if (!Array.isArray(post)) {
                if (post && "error" in post) {
                    console.warn(`API Error: ${post.message || post.error}`);
                    return null;
                }
                if (post && "errors" in post) {
                    console.warn(`API errors: ${JSON.stringify(post.errors)}`);
                    return null;
                }
            }
            return Array.isArray(post) ? post : (post ? post.data : null);
        } catch (e) {
            console.warn("postWraper network error:", e);
            return null;
        }
    }

    async post(data) {
        return this.postWraper(data, {
            "Content-Type": "text/plain;charset=UTF-8",
            "Client-Id": this.clientId
        });
    }

    async postAuthorized(data, headers) {
        if (!headers) headers = {};
        headers["Content-Type"] = "text/plain;charset=UTF-8";
        headers["Client-Id"] = this.clientId;
        if (this.oauthToken) {
            headers["Authorization"] = `OAuth ${this.oauthToken}`;
        }
        if (this.integrity && this.integrity.token) {
            headers["Client-Integrity"] = this.integrity.token;
            if (this.deviceId) {
                headers["X-Device-Id"] = this.deviceId;
            }
        }
        return await this.postWraper(data, headers);
    }

    async postIntegrity() {
        if (!this.deviceId) return null;
        try {
            let headers = {
                "Client-Id": "ue6666qo983tsx6so1t0vnawi233wa",
                "Authorization": `OAuth ${this.oauthToken}`,
                "X-Device-Id": this.deviceId,
                "Client-Session-Id": this.uuid,
                "Client-Version": "da69d5f2-ac48-4169-9574-48fee4a96513",
                "User-Agent": "Mozilla/5.0 (Linux; Android 7.1; Smart Box C1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
            };
            let post = await fetch("https://gql.twitch.tv/integrity", {
                headers,
                method: "POST"
            }).then((res) => res.json());
            return post;
        } catch (e) {
            console.warn("postIntegrity error:", e);
            return null;
        }
    }

    async ensureIntegrity() {
        if (this.integrity && this.integrity.expiration > new Date().getTime()) {
            return true;
        } else {
            return false;
        }
    }

    async getIntegFromStorage() {
        try {
            const data = await chrome.storage.sync.get(["twitchInteg"]);
            if (data && data.twitchInteg && data.twitchInteg.token !== undefined)
                this.integrity = data.twitchInteg;
        } catch (e) {}
        return this.integrity;
    }

    async setInteg(integ) {
        this.integrity = integ;
        chrome.storage.sync.set({ twitchInteg: integ });
    }

    async updateUserInfo(options) {
        this.clientId = options?.clientId ?? this.clientId;
        this.oauthToken = options?.oauthToken ?? this.oauthToken;
        this.deviceId = options?.deviceId ?? this.deviceId;
        this.userId = options?.userId ?? this.userId;
        this.uuid = options?.uuid ?? this.uuid;
    }

    async getUserId() {
        await this.autoDetectUserId();
    }

    async autoDetectUserId() {
        if (!this.oauthToken) return null;
        try {
            let data = await this.postAuthorized({
                "operationName": "CoreActionsCurrentUser",
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "6b5b63a013cf66a995d61f71a508ab5c8e4473350c5d4136f846ba65e8101e95"
                    }
                }
            });
            if (data && data.currentUser) {
                this.userId = data.currentUser.id;
                chrome.storage.sync.set({ userId: data.currentUser.id });
            }
        } catch (e) {}
        return this.userId;
    }

    async getGameIdFromName(name) {
        try {
            const data = await this.post({
                "operationName": "DirectoryRoot_Directory",
                "variables": {
                    "name": name
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
        let games = [];
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
            if (typeof dropId == "string") {
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
                        "channelLogin": this.userId
                    }
                });
                return data && data.user ? data.user.dropCampaign : null;
            } else {
                let dataAry = [];
                for (const camp of dropId) {
                    dataAry.push({
                        "operationName": "DropCampaignDetails",
                        "extensions": {
                            "persistedQuery": {
                                "version": 1,
                                "sha256Hash": "039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1"
                            }
                        },
                        "variables": {
                            "dropID": camp,
                            "channelLogin": this.userId
                        }
                    });
                }
                let data = await this.postAuthorized(dataAry);
                return data || [];
            }
        } catch (e) {
            return null;
        }
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
            const data = await this.post({
                "operationName": "DirectoryPage_Game",
                "variables": {
                    "game": gameName.toLowerCase(),
                    "slug": slug == null ? gameName.toLowerCase().replaceAll(" ", "-") : slug,
                    "options": {
                        "includeRestricted": [
                            "SUB_ONLY_LIVE"
                        ],
                        "sort": "VIEWER_COUNT",
                        "recommendationsContext": {
                            "platform": "web"
                        },
                        "requestID": "JIRA-VXP-2397",
                        "tags": ["c2542d6d-cd10-4532-919b-3d19f30a768b"]
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

            const streams = data && data.game ? data.game.streams : null;
            if (streams == null) return [];
            const result = [];
            for (const stream of streams.edges) {
                result.push(stream.node);
            }
            return result;
        } catch (e) {
            return [];
        }
    }

    async claimDropReward(dropId) {
        try {
            return await this.postAuthorized({
                "operationName": "DropsPage_ClaimDropRewards",
                "variables": {
                    "input": {
                        "dropInstanceID": dropId
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
            if (data && data.claimCommunityPoints && data.claimCommunityPoints.error == null)
                return { success: true, points: data.claimCommunityPoints.claim.pointsEarnedTotal };
            else
                return false;
        } catch (e) {
            return false;
        }
    }

    async getStream(username) {
        try {
            if (typeof username == "string") {
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
            } else {
                let dataAry = [];
                for (const user of username) {
                    dataAry.push({
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
                    });
                }
                return await this.post(dataAry);
            }
        } catch (e) {
            return null;
        }
    }

    async getAllLiveForGame(gameName) {
        try {
            const gameId = await this.getGameIdFromName(gameName);
            if (!gameId) return [];

            const data = await this.post({
                "operationName": "DirectoryPage_Game",
                "variables": {
                    "game": gameName,
                    "options": {
                        "sort": "VIEWER_COUNT",
                        "tags": ["c2542d6d-cd10-4532-919b-3d19f30a768b"]
                    },
                    "sortTypeIsRecency": false,
                    "limit": 30
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "76cb069d835b8a02914c08dc42c421d0dafda8af5b113a3f19141824b901402f"
                    }
                }
            });

            if (data && data.game && data.game.streams) {
                let userAry = [];
                for (const edge of data.game.streams.edges) {
                    if (edge && edge.node && edge.node.broadcaster) {
                        userAry.push(edge.node.broadcaster.login);
                    }
                }
                if (userAry.length > 0) {
                    return await this.getStream(userAry);
                }
            }
        } catch (e) {}
        return [];
    }

    async getChannelWithDrops(gameName, campaignId, slug) {
        let streams = await this.getActiveStreams(gameName, slug);
        if (Array.isArray(streams) && streams.length > 0) {
            for (const stream of streams) {
                if (stream && stream.broadcaster) {
                    return stream;
                }
            }
        }

        // Fallback: Query live streams by game name directly
        let liveUsers = await this.getAllLiveForGame(gameName);
        if (Array.isArray(liveUsers) && liveUsers.length > 0) {
            let first = liveUsers[0];
            if (first && first.data && first.data.userOrError && first.data.userOrError.login) {
                return {
                    broadcaster: {
                        login: first.data.userOrError.login
                    }
                };
            }
        }

        return "nostream";
    }

    async getStreamMetadata(username) {
        try {
            const data = await this.post({
                "operationName": "StreamMetadata",
                "variables": {
                    "channelLogin": username
                },
                "extensions": {
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "05e61087e584f2249e088a531cf02a358c27cfc5040e32b0e6e88e22830f81d1"
                    }
                }
            });

            if (data && data.user) {
                return data.user;
            }
        } catch (e) {}
        return null;
    }
}