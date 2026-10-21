import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestSandbox } from "../harness/sandbox.js";
import { Client } from "../../background/twitchApi.js";

describe("Tier 1: Feature 11 - Headless HLS & Spade Watch Engine (v2.0)", () => {
    let sandbox;
    let client;

    beforeEach(() => {
        sandbox = setupTestSandbox();
        client = new Client({
            clientId: "test-client-id",
            oauthToken: "test-oauth-token",
            userId: "12345678"
        });
    });

    it("F11-T1: getPlaybackAccessToken() requests streamPlaybackAccessToken with playerType 'site'", async () => {
        sandbox.fetchMock.onGql("PlaybackAccessToken", {
            data: {
                streamPlaybackAccessToken: {
                    value: '{"channel":"shroud"}',
                    signature: "sig123abc",
                    __typename: "PlaybackAccessToken"
                }
            }
        });

        const token = await client.getPlaybackAccessToken("Shroud");
        assert.ok(token);
        assert.equal(token.value, '{"channel":"shroud"}');
        assert.equal(token.signature, "sig123abc");
    });

    it("F11-T2: getStreamUrl() parses Usher master M3U8 playlist and selects the lowest-bandwidth variant", async () => {
        sandbox.fetchMock.onGql("PlaybackAccessToken", {
            data: {
                streamPlaybackAccessToken: {
                    value: '{"channel":"shroud"}',
                    signature: "sig123abc"
                }
            }
        });

        const masterM3u8 = [
            "#EXTM3U",
            '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,NAME="1080p60"',
            "https://video-weaver.sjc02.hls.ttvnw.net/v1/playlist/high_1080p.m3u8",
            '#EXT-X-STREAM-INF:BANDWIDTH=240000,RESOLUTION=284x160,NAME="160p"',
            "https://video-weaver.sjc02.hls.ttvnw.net/v1/playlist/low_160p.m3u8"
        ].join("\n");

        const origFetch = globalThis.fetch;
        globalThis.fetch = async (url, opts) => {
            if (String(url).includes("usher.ttvnw.net/api/channel/hls/shroud.m3u8")) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => masterM3u8
                };
            }
            return origFetch(url, opts);
        };

        try {
            const variantUrl = await client.getStreamUrl("shroud");
            assert.equal(variantUrl, "https://video-weaver.sjc02.hls.ttvnw.net/v1/playlist/low_160p.m3u8");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("F11-T3: sendWatchPlaylist() fetches variant playlist and dispatches HEAD request on latest segment URL", async () => {
        client._streamUrlCache.set("shroud", "https://video-weaver.sjc02.hls.ttvnw.net/v1/playlist/low_160p.m3u8");

        const mediaPlaylist = [
            "#EXTM3U",
            "#EXT-X-TARGETDURATION:2",
            "#EXTINF:2.000,live",
            "https://video-edge-1.sjc02.abs.hls.ttvnw.net/v1/segment/seg1.ts",
            "#EXTINF:2.000,live",
            "https://video-edge-1.sjc02.abs.hls.ttvnw.net/v1/segment/seg2.ts"
        ].join("\n");

        let headTargetUrl = null;
        let headMethod = null;
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (url, opts = {}) => {
            if (String(url).includes("low_160p.m3u8")) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => mediaPlaylist
                };
            }
            if (String(url).includes("seg2.ts")) {
                headTargetUrl = String(url);
                headMethod = opts.method;
                return { ok: true, status: 200, text: async () => "" };
            }
            return origFetch(url, opts);
        };

        try {
            const ok = await client.sendWatchPlaylist("shroud");
            assert.equal(ok, true);
            assert.equal(headMethod, "HEAD");
            assert.equal(headTargetUrl, "https://video-edge-1.sjc02.abs.hls.ttvnw.net/v1/segment/seg2.ts");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("F11-T4: sendWatchSpade() encodes base64 minute-watched event payload and POSTs to Spade endpoint", async () => {
        client._spadeUrlCache.set("shroud", "https://spade.twitch.tv/track");

        let postedUrl = null;
        let postedBody = null;
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (url, opts = {}) => {
            if (String(url).includes("spade.twitch.tv/track")) {
                postedUrl = String(url);
                postedBody = opts.body;
                return { ok: true, status: 204 };
            }
            return origFetch(url, opts);
        };

        try {
            const ok = await client.sendWatchSpade("shroud", {
                channelId: "37402112",
                broadcastId: "9988776655",
                login: "shroud"
            });
            assert.equal(ok, true);
            assert.equal(postedUrl, "https://spade.twitch.tv/track");
            assert.ok(postedBody.startsWith("data="));

            const b64 = decodeURIComponent(postedBody.slice(5));
            const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
            assert.equal(decoded[0].event, "minute-watched");
            assert.equal(decoded[0].properties.broadcast_id, "9988776655");
            assert.equal(decoded[0].properties.channel_id, "37402112");
            assert.equal(decoded[0].properties.channel, "shroud");
            assert.equal(decoded[0].properties.player, "site");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("F11-T5: sendWatch() combines HLS playlist pulse and Spade beacon and returns success if either succeeds", async () => {
        client.sendWatchPlaylist = async () => true;
        client.sendWatchSpade = async () => false;

        const res1 = await client.sendWatch("shroud", { channelId: "37402112", broadcastId: "111" });
        assert.equal(res1.success, true);
        assert.equal(res1.method, "hls");

        client.sendWatchPlaylist = async () => false;
        client.sendWatchSpade = async () => true;

        const res2 = await client.sendWatch("shroud", { channelId: "37402112", broadcastId: "111" });
        assert.equal(res2.success, true);
        assert.equal(res2.method, "spade");
    });
});
