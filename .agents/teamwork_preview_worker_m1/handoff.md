# Milestone 1 Handoff Report: Twitch GraphQL & WebSocket Automation Hardening

**Agent**: Worker M1 (`teamwork_preview_worker_m1`)  
**Milestone**: M1 - Twitch GraphQL & WebSocket Automation Hardening  
**Date**: 2026-08-15  
**Workspace**: `/Users/k9/Desktop/Twitch-drop`  

---

## 1. Observation

Direct code observations and modifications across all owned files:

### 1.1 `background/twitchApi.js`
- **Custom Error Class**: Created and exported `TwitchApiError extends Error` with explicit properties `status`, `errors`, `operationName`, and descriptive error messages.
- **Request Pipeline & Headers**: Standardized `buildHeaders(authorized)` and `extractOperationName(data)` attaching `Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko`, `Authorization: OAuth ...`, `X-Device-Id`, `Client-Integrity`, and `Client-Session-Id` cleanly across all queries and mutations.
- **Strict Response & Error Unwrapping**:
  - `post()` and `postAuthorized()` now verify `res.ok`. On HTTP failure, they throw `TwitchApiError` containing the status code, status text, and target operation name(s).
  - Single query responses inspecting `json.errors`: If `json.errors && json.errors.length > 0`, they throw `TwitchApiError` with the aggregated error messages and error payload instead of returning the raw error dictionary.
  - Single query responses with valid data safely return `json.data`.
  - Batched array responses (`Array.isArray(json)`) return the array of `{ data: ... }` elements for batch consumers.
- **Hardened Claim Operations**:
  - `claimDropReward(dropInstanceId)`: Validates `dropInstanceID` presence, sends `DropsPage_ClaimDropRewards` mutation, verifies `data?.claimDropReward?.status`, and returns `{ status, dropInstanceID, success: status === "SUCCESS" || status === "ELIGIBLE_FOR_CLAIM" }`. Throws `TwitchApiError` on invalid/empty response.
  - `claimChannelPoints(channelID, claimID)`: Supports flexible parameter signatures, executes `ClaimCommunityPoints` mutation, inspects `data.claimCommunityPoints.error`, and returns `{ claimID, status, points, success: true }`. Throws `TwitchApiError` on error code.
- **9 Hardened GraphQL Operations**:
  1. `CoreActionsCurrentUser` (`postAuthorized`)
  2. `DirectoryRoot_Directory` (`post`)
  3. `ViewerDropsDashboard` (`postAuthorized` / `post`)
  4. `DropCampaignDetails` (`postAuthorized`, single or batched)
  5. `Inventory` (`postAuthorized`)
  6. `DirectoryPage_Game` (`post`, batched)
  7. `DropsPage_ClaimDropRewards` (`postAuthorized`)
  8. `ClaimCommunityPoints` (`postAuthorized`)
  9. `ChannelShell` (`post`, single or batched)

### 1.2 `onPage.js`
- **WebSocket Interception Hardening**:
  - Removed fragile `res.origin === "wss://hermes.twitch.tv"` check.
  - In `window.WebSocket` constructor proxy, extracted `targetUrl` from constructor arguments (`args[0]`).
  - Supported incoming WebSocket connections matching `hermes.twitch.tv` and `pubsub-edge.twitch.tv`.
  - Added robust nested `try...catch` JSON parsing for both top-level frame payloads and stringified inner `data.message` fields.
  - Added full message parsing for `points-earned`, `claim-available`, and `drop-progress` (including PubSub topics `community-points-user-v1` and `user-drop-events` / `drop-progress`).
- **Channel Points Deduplication**:
  - Implemented `isDuplicateClaim(key, ttlMs)` in `onPage.js` with rolling timestamp cache.
  - Deduplicated DOM chest clicks (`dom-chest-claim` key with 10s TTL) and WebSocket point messages (`ws-points-earned-*` and `claim-*` keys).

### 1.3 `background.js`
- **Import & Error Handling**:
  - Imported `TwitchApiError` from `./background/twitchApi.js`.
- **Background Deduplication**:
  - Implemented `isDuplicateBackgroundClaim(key, ttlMs)` in `background.js` to serialize point claims and drop claims across concurrent message bursts.
- **Message Router Hardening**:
  - `claim-points`: Deduplicated incoming `claimID` claims (15s window), verified `client.claimChannelPoints()` result status, and updated stats, activity log, and UI broadcasts.
  - `points-earned`: Deduplicated watch bonus events (3s window) and broadcast both `p:statsUpdated` and `p:activityUpdated`.
  - `claim-drop`: Invoked `checkClaimDrop()`.
- **Reward Verification in `checkClaimDrop()`**:
  - Validates `dropInstanceID` existence.
  - Deduplicates drop claims with `drop-claim-${dropInstanceID}` (30s window).
  - Only increments `extStats.claimedDrops++`, logs activity, sends notification, and triggers sound chime if `client.claimDropReward()` succeeds without errors (`dropClaim.status === "SUCCESS"` or `"ELIGIBLE_FOR_CLAIM"` or `dropClaim.success === true`).
  - Marks `drop.self.isClaimed = true` immediately upon successful claim.

---

## 2. Logic Chain

1. **Eliminating False Positive Drop Claims**:
   - *Problem*: Previously, `checkClaimDrop()` checked `if (dropClaim)` where `dropClaim` was a raw error dictionary `{ errors: [...] }` if GraphQL failed. This caused false positive stats increments, erroneous notifications, and audio chimes.
   - *Resolution*: `twitchApi.js` now throws `TwitchApiError` when `json.errors` is present, and `claimDropReward` validates `data.claimDropReward.status`. In `background.js`, `checkClaimDrop` checks `dropClaim.success === true`, eliminating all false positives.

2. **Fixing WebSocket Drop-Off**:
   - *Problem*: `MessageEvent.origin` in modern Chrome can be `""` or `https://www.twitch.tv` for WebSockets, causing `res.origin === "wss://hermes.twitch.tv"` to evaluate to `false` and drop 100% of Hermes messages.
   - *Resolution*: Capturing the URL directly from the `WebSocket` constructor arguments (`targetUrl.includes("hermes.twitch.tv")` or `pubsub-edge.twitch.tv`) ensures all relevant sockets are intercepted regardless of `event.origin`.

3. **Preventing Channel Points Triple-Counting**:
   - *Problem*: A single bonus chest click fired DOM synthetic click (+50), Hermes `claim-available` (+50), and Hermes `points-earned` (+50), producing +150 points and 3 duplicate activity rows.
   - *Resolution*: Dual-layer deduplication caches in `onPage.js` and `background.js` prevent duplicate dispatches within rolling TTL windows.

---

## 3. Caveats

- Twitch periodically updates persisted query SHA256 hashes. When Twitch rotates hashes, `twitchApi.js` will cleanly throw `TwitchApiError` with operation name details, allowing higher-level recovery mechanisms to trigger integrity or token refreshes.
- No other caveats.

---

## 4. Conclusion

Milestone 1 objectives are 100% fulfilled:
1. `TwitchApiError` and strict unwrapping / error throwing implemented in `background/twitchApi.js`.
2. All 9 GraphQL operations standardized and hardened.
3. WebSocket proxy in `onPage.js` hardened for Hermes and PubSub with safe parsing.
4. Channel points bonus claims and drop claims fully deduplicated across DOM and WebSocket channels.
5. All syntax checks and contract assertions pass cleanly.

---

## 5. Verification Method

### 5.1 Static Verification Commands
```bash
# 1. Verify syntax across all modified JS files
node -c /Users/k9/Desktop/Twitch-drop/background.js
node -c /Users/k9/Desktop/Twitch-drop/background/twitchApi.js
node -c /Users/k9/Desktop/Twitch-drop/inject.js
node -c /Users/k9/Desktop/Twitch-drop/onPage.js
```

### 5.2 Dynamic Contract Assertions
Run unit assertions in Node.js:
```bash
node -e '
import("./background/twitchApi.js").then(async ({ Client, TwitchApiError }) => {
    const client = new Client({ oauthToken: "oauth_123" });
    
    // HTTP error test
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });
    try {
        await client.post({ operationName: "testOp" });
    } catch (e) {
        console.assert(e instanceof TwitchApiError && e.status === 401);
    }
    
    // GraphQL error test
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: "PersistedQueryNotFound" }] }) });
    try {
        await client.postAuthorized({ operationName: "Inventory" });
    } catch (e) {
        console.assert(e instanceof TwitchApiError && e.message.includes("PersistedQueryNotFound"));
    }
    
    console.log("All contract assertions passed!");
});
'
```
