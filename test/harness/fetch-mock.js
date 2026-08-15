/**
 * Mock Fetch Engine for Twitch GraphQL and REST Endpoints
 */

import {
    currentUserFixture,
    directoryRootFixture,
    viewerDropsDashboardFixture,
    dropCampaignDetailsFixture,
    inventoryFixture,
    directoryPageGameFixture,
    claimDropRewardSuccessFixture,
    claimCommunityPointsSuccessFixture,
    channelShellLiveFixture
} from "../fixtures/graphql-fixtures.js";

class MockResponse {
    constructor(body, init = {}) {
        this.status = init.status !== undefined ? init.status : 200;
        this.ok = this.status >= 200 && this.status < 300;
        this.statusText = init.statusText || (this.ok ? "OK" : "Error");
        this._body = body;
        this.url = init.url || "https://gql.twitch.tv/gql";
        this.headers = new Map(Object.entries(init.headers || {}));
    }

    async json() {
        if (typeof this._body === "string") {
            return JSON.parse(this._body);
        }
        return JSON.parse(JSON.stringify(this._body));
    }

    async text() {
        if (typeof this._body === "string") {
            return this._body;
        }
        return JSON.stringify(this._body);
    }

    clone() {
        return new MockResponse(this._body, {
            status: this.status,
            statusText: this.statusText,
            url: this.url,
            headers: Object.fromEntries(this.headers.entries())
        });
    }
}

export class FetchMock {
    constructor() {
        this.reset();
    }

    reset() {
        this.routes = [];
        this.history = [];
        this.defaultResponses = new Map();
        this._setupDefaultFixtures();
    }

    _setupDefaultFixtures() {
        this.defaultResponses.set("CoreActionsCurrentUser", currentUserFixture);
        this.defaultResponses.set("DirectoryRoot_Directory", directoryRootFixture);
        this.defaultResponses.set("ViewerDropsDashboard", viewerDropsDashboardFixture);
        this.defaultResponses.set("DropCampaignDetails", dropCampaignDetailsFixture);
        this.defaultResponses.set("Inventory", inventoryFixture);
        this.defaultResponses.set("DirectoryPage_Game", [directoryPageGameFixture]);
        this.defaultResponses.set("DropsPage_ClaimDropRewards", claimDropRewardSuccessFixture);
        this.defaultResponses.set("ClaimCommunityPoints", claimCommunityPointsSuccessFixture);
        this.defaultResponses.set("ChannelShell", channelShellLiveFixture);
    }

    on(predicate, handler) {
        this.routes.push({ predicate, handler });
        return this;
    }

    onGql(operationName, responseOrHandler, status = 200) {
        this.routes.unshift({
            predicate: (url, opts, body) => {
                if (!url.includes("gql.twitch.tv")) return false;
                if (Array.isArray(body)) {
                    return body.some(b => b.operationName === operationName);
                }
                return body && body.operationName === operationName;
            },
            handler: async (url, opts, body) => {
                if (typeof responseOrHandler === "function") {
                    return responseOrHandler(url, opts, body);
                }
                return new MockResponse(responseOrHandler, { status, url });
            }
        });
        return this;
    }

    onUrl(urlMatch, responseOrHandler, status = 200) {
        this.routes.unshift({
            predicate: (url) => url.includes(urlMatch),
            handler: async (url, opts, body) => {
                if (typeof responseOrHandler === "function") {
                    return responseOrHandler(url, opts, body);
                }
                return new MockResponse(responseOrHandler, { status, url });
            }
        });
        return this;
    }

    async fetch(url, options = {}) {
        let body = null;
        if (options.body) {
            try {
                body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
            } catch (e) {
                body = options.body;
            }
        }

        const record = {
            url: typeof url === "string" ? url : url.url || url.href,
            method: options.method || "GET",
            headers: options.headers || {},
            body: body,
            rawBody: options.body,
            timestamp: Date.now()
        };
        this.history.push(record);

        // Check custom registered routes first
        for (const route of this.routes) {
            try {
                if (route.predicate(record.url, options, body)) {
                    return await route.handler(record.url, options, body);
                }
            } catch (err) {
                throw err;
            }
        }

        // Integrity token route
        if (record.url.includes("/integrity")) {
            return new MockResponse({
                token: "mock-integrity-token-jwt-" + Date.now(),
                expiration: Date.now() + 3600000
            }, { status: 200, url: record.url });
        }

        // Fallback default GraphQL handler
        if (record.url.includes("gql.twitch.tv")) {
            if (Array.isArray(body)) {
                const results = body.map(op => {
                    const fixture = this.defaultResponses.get(op.operationName);
                    return fixture || { data: null };
                });
                return new MockResponse(results, { status: 200, url: record.url });
            } else if (body && body.operationName) {
                const fixture = this.defaultResponses.get(body.operationName);
                if (fixture) {
                    return new MockResponse(fixture, { status: 200, url: record.url });
                }
            }
            return new MockResponse({ data: {} }, { status: 200, url: record.url });
        }

        // Unknown route: return 404
        return new MockResponse({ error: "Not Found" }, { status: 404, url: record.url });
    }
}

export const fetchMock = new FetchMock();
