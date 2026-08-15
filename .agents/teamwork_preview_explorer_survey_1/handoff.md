# Codebase Survey Report: Twitch GraphQL APIs, WebSocket (Hermes/PubSub) & Network Data Contracts

**Explorer 1**: Codebase Survey & Network Data Contract Specialist  
**Working Directory**: `/Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_explorer_survey_1/`  
**Date**: 2026-08-15  

---

## 1. Observation

### 1.1 Codebase File & Architecture Inventory
The project is a Manifest V3 Chrome Extension located at `/Users/k9/Desktop/Twitch-drop/`.

```
/Users/k9/Desktop/Twitch-drop/
├── manifest.json              # MV3 configuration, host permissions, background module
├── background.js              # Background service worker (1,288 lines)
├── background/
│   ├── twitchApi.js           # Twitch GQL & Internal API Client class (451 lines)
│   └── buffer.js              # Polyfill for Node.js Buffer (62 KB)
├── inject.js                  # Content script injected at document_start (151 lines)
├── onPage.js                  # In-page script intercepting fetch/WebSocket/visibility (228 lines)
├── index.html                 # Extension Popup UI (364 lines)
├── assets/
│   ├── js/
│   │   ├── main.js            # Popup UI controller & messaging (842 lines)
│   │   └── jquery.js          # jQuery library
│   ├── css/
│   │   └── main.css           # Popup styles & glassmorphic theme
│   └── img/                   # Icons, artwork, fallbacks
└── waiting.html               # Stream waiting placeholder tab (19 lines)
```

### 1.2 GraphQL Queries & Mutations Mapping

All GraphQL queries and mutations send POST requests to `https://gql.twitch.tv/gql` with `Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko`.

| Operation Name | Location | Type | Persisted Query SHA256 Hash | Variables | Method |
|---|---|---|---|---|---|
| `CoreActionsCurrentUser` | `background/twitchApi.js:100` | Query | `6b5b63a013cf66a995d61f71a508ab5c8e4473350c5d4136f846ba65e8101e95` | None | `postAuthorized` |
| `DirectoryRoot_Directory` | `background/twitchApi.js:119` | Query | `99d3c9b5ceaadb36f77c8bc2d576a737c83d2e9f06c4d6190cf2c6b4f214cccb` | `{"name": string}` | `post` |
| `ViewerDropsDashboard` | `background/twitchApi.js:142, 167` | Query | `5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619` | `{"fetchRewardCampaigns": true}` | `postAuthorized` / `post` |
| `DropCampaignDetails` | `background/twitchApi.js:203, 218` | Query | `039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1` | `{"dropID": string, "channelLogin": string}` | `postAuthorized` (single or batched array) |
| `Inventory` | `background/twitchApi.js:242` | Query | `d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b` | None | `postAuthorized` |
| `DirectoryPage_Game` | `background/twitchApi.js:267` | Query | `76cb069d835b8a02914c08dc42c421d0dafda8af5b113a3f19141824b901402f` | `{"slug": string, "options": {"sort": "VIEWER_COUNT", "tags": ["c2542d6d-cd10-4532-919b-3d19f30a768b"], "recommendationsContext": {"platform": "web"}, "requestID": "JIRA-VXP-2397"}, "sortTypeIsRecency": false, "includeCostreaming": true, "limit": 30}` | `post` (batched array `[ {...} ]`) |
| `DropsPage_ClaimDropRewards` | `background/twitchApi.js:313` | Mutation | `a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930` | `{"input": {"dropInstanceID": string}}` | `postAuthorized` |
| `ClaimCommunityPoints` | `background/twitchApi.js:334` | Mutation | `46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0` | `{"input": {"channelID": string, "claimID": string}}` | `postAuthorized` |
| `ChannelShell` | `background/twitchApi.js:364, 378, 428` | Query | `580ab410bcd0c1ad194224957ae2241e5d252b2c5173d8e0cce9d32d5bb14efe` | `{"login": string}` | `post` (single or batched array) |

### 1.3 Request Headers Contract
Observed in `background/twitchApi.js:16-25` and `44-54`:
```javascript
const headers = {
    "Client-Id": this.clientId, // "kimne78kx3ncx6brgo4mv6wki5h1ko"
    "Authorization": `OAuth ${this.oauthToken}`, // only in postAuthorized
    "Content-Type": "application/json"
};
if (this.deviceId) headers["X-Device-Id"] = this.deviceId;
if (this.integrity) {
    const integToken = typeof this.integrity === "string" ? this.integrity : this.integrity?.token;
    if (integToken) headers["Client-Integrity"] = integToken;
}
if (this.uuid) headers["Client-Session-Id"] = this.uuid;
```

### 1.4 Response Structure & Unwrapping Contract
Observed in `background/twitchApi.js:33-35` and `62-64`:
```javascript
const json = await res.json();
if (Array.isArray(json)) return json;
return (json && json.data) ? json.data : json;
```

Observed handling across consumers:
1. **Single object requests** (`ViewerDropsDashboard`, `Inventory`, `CoreActionsCurrentUser`, `DirectoryRoot_Directory`, `ClaimCommunityPoints`, `DropsPage_ClaimDropRewards`, `ChannelShell`):
   - `post`/`postAuthorized` returns `json.data`.
   - Consumer access: `data.currentUser.inventory`, `data.currentUser.dropCampaigns`, `data.claimCommunityPoints`, `data.userOrError.stream`.
2. **Batched array requests** (`DirectoryPage_Game`, `DropCampaignDetails` with array of drop IDs, `ChannelShell` with array of users):
   - `post`/`postAuthorized` returns `json` (an Array of `{ data: ... }` objects).
   - In `DirectoryPage_Game` (`twitchApi.js:291`):
     ```javascript
     const edges = data?.[0]?.data?.game?.streams?.edges || [];
     ```
   - In `DropCampaignDetails` batched call (`background.js:998-1000`):
     ```javascript
     const dropCamp = c?.data?.user?.dropCampaign || c?.data?.dropCampaign || c?.user?.dropCampaign || c?.dropCampaign;
     ```

### 1.5 WebSocket (Hermes / PubSub) Architecture
Observed in `onPage.js:189-227`:
- Injects a Proxy over `window.WebSocket` in the web page.
- Listens to incoming messages:
  ```javascript
  if (res && res.origin === "wss://hermes.twitch.tv") {
      const data = JSON.parse(res.data);
      if (data.type === "MESSAGE") {
          const parsed = JSON.parse(data.data.message);
          if (parsed.type === "points-earned") { ... }
          else if (parsed.type === "claim-available") { ... }
          else if (parsed.type === "drop-progress") { ... }
      }
  }
  ```
- Dispatches `window.postMessage({ autoTwitchDrops: ... }, "*")`.
- `inject.js:6-32` catches `message` and forwards to `background.js` via `chrome.runtime.sendMessage`.
- `background.js` processes `claim-points`, `points-earned`, `claim-drop`.

### 1.6 Authentication & Integrity Token Architecture
1. **OAuth & Device Identification**:
   - `fetchTwitchCookiesAndInitClient()` in `background.js:174-216` retrieves `auth-token` and `unique_id` cookies via `chrome.cookies.get({ url: "https://www.twitch.tv", ... })` and falls back to `chrome.cookies.getAll`.
   - `inject.js:95-136` reads `document.cookie` for `auth-token` and `unique_id`, `localStorage.getItem("searchSuggestionHistory")` for `userId`, and `localStorage.getItem("local_storage_app_session_id")` for `uuid` (Client-Session-Id), dispatching `clientInfo` message to background.
2. **Integrity Token**:
   - `onPage.js:130-186` intercepts `fetch` calls to `https://gql.twitch.tv/integrity` and headers with `Client-Integrity`.
   - Dispatches `{ type: "integ", integrity: data }` to `inject.js` -> `background.js` (`sendInteg`).
   - `autoGetToken()` in `background.js:1221-1229` triggers if `client.integrity.expiration - 960000 < Date.now()`, opening a popup window to `https://www.twitch.tv/drops/inventory/` to force Twitch web client to fetch a fresh integrity token, which is caught and closes the window.
   - `tokenRefreshAlarm` in `background.js:348` runs every 15 minutes.

### 1.7 Test Harness Status
- Tool command `find_by_name` matching `*test*` and `*package*` returned **0 results**.
- There are currently no automated unit, integration, or contract tests in the repository.

---

## 2. Logic Chain

1. **GraphQL Data Contract Invariants**:
   - Observation 1.4 confirms that `twitchApi.js` unwraps `json.data` for single query/mutation payloads, while preserving the outer array for batched requests.
   - For single queries, returning `json.data` simplifies consumer code (`inventory.dropCampaignsInProgress`), but requires all consumer functions to be aligned.
   - If Twitch GQL returns `{ errors: [...] }` with HTTP 200 (a standard GraphQL pattern when validation or authentication fails), `json.data` is `undefined`, so `(json && json.data) ? json.data : json` returns `{ errors: [...] }`.
   - Consumers currently do not check `data.errors`. For example, in `checkClaimDrop()` (`background.js:1201`), `dropClaim` is evaluated for truthiness: `if (dropClaim)`. If `claimDropReward` returns `{ errors: [{ message: "already claimed" }] }`, `if (dropClaim)` is truthy and logs a false positive claim!

2. **Batched Query Response Invariants**:
   - In `getActiveStreams` (`twitchApi.js:265-289`), the request is sent as `[ { operationName: "DirectoryPage_Game", ... } ]`.
   - The response is `[ { data: { game: { streams: { edges: [...] } } } } ]`.
   - `edges = data?.[0]?.data?.game?.streams?.edges || []` correctly traverses `data[0].data` because array payloads are not stripped of `.data`.
   - Similarly, batched `DropCampaignDetails` returns `[ { data: { user: { dropCampaign: ... } } }, ... ]`, and `background.js:999` safely traverses `c?.data?.user?.dropCampaign || c?.data?.dropCampaign || c?.user?.dropCampaign`.

3. **WebSocket Vulnerabilities**:
   - `onPage.js:195` checks `res.origin === "wss://hermes.twitch.tv"`. However, WebSocket `MessageEvent.origin` is often empty string `""` or the page origin `https://www.twitch.tv` depending on the browser version and WebSocket constructor. Relying solely on `res.origin` can silently drop all incoming WebSocket events.
   - In addition to `wss://hermes.twitch.tv`, Twitch also routes channel points and drop notifications through PubSub (`wss://pubsub-edge.twitch.tv/v1`). The current interceptor ignores PubSub messages entirely.
   - Deduplication: `onPage.js` fires DOM click triggers (`autoClaimPointsChests`) while also intercepting `claim-available` and `points-earned` from WebSocket. When a claim event occurs, both the DOM clicker and the WebSocket message handler execute, leading to potential duplicate claim calls and inflated stats.

4. **Stream Playback & Page Visibility Guard**:
   - `onPage.js:13-53` overrides `Document.prototype.hidden`, `Document.prototype.visibilityState`, and captures `visibilitychange` events to prevent Twitch's player from pausing when the tab is hidden or minimized.
   - `onPage.js:5-9` sets `video-quality: {"default": "160p30"}` and `low-latency: {"default": false}` in `localStorage`.
   - `safePlaybackWatchdog()` runs every 5 seconds to dismiss static prompts and trigger `.play()` on paused video elements.

---

## 3. Caveats

1. **Twitch API Volatility**: Twitch periodically rotates persisted query hashes (`sha256Hash`) and internal GQL operation names without notice. When hashes expire, Twitch returns `PersistedQueryNotFound` (HTTP 200 with error).
2. **BotGuard / Kasada Integrity Challenge**: Twitch's integrity endpoint (`https://gql.twitch.tv/integrity`) uses client telemetry. If Twitch updates its bot detection script, opening `https://www.twitch.tv/drops/inventory/` in a background window might require human interaction (CAPTCHA) or specific browser headers.
3. **Multi-Account / Incognito**: If a user switches accounts or clears cookies, `auth-token` may become stale until the next alarm or page reload.

---

## 4. Conclusion

The Auto Twitch Drops Pro extension possesses a functional GraphQL/WebSocket architecture, but exhibits the following critical areas requiring hardening:

1. **GraphQL Contract Error Handling**:
   - Update `twitchApi.js` to inspect `json.errors` on all responses and throw or return explicit error objects rather than returning raw error dictionaries as data payloads.
   - Harden `claimDropReward` in `twitchApi.js` and `background.js` to verify `claimDropReward.status === "SUCCESS"` or `ELIGIBLE_FOR_CLAIM` before incrementing stats, triggering notifications, and playing claim sounds.
2. **WebSocket & PubSub Interception Hardening**:
   - Remove fragile `res.origin === "wss://hermes.twitch.tv"` check in `onPage.js` and instead inspect the target WebSocket URL from the constructor (`sockurl[0]`) supporting both `hermes.twitch.tv` and `pubsub-edge.twitch.tv`.
   - Add message deduplication using message IDs / nonces / timestamps to prevent double-claiming points and duplicate drop progress dispatches.
3. **Automated Verification Harness**:
   - Establish an automated mock-based test suite verifying:
     - Request payload formatting and header construction for all 8 GraphQL operations.
     - Response unwrapping logic for both single and batched operations.
     - Error and nullability branches (expired token, 401/403/429 status codes, `errors` arrays).
     - WebSocket message parsing and event relaying.

---

## 5. Verification Method

To independently verify the findings in this report:

1. **Inspect GraphQL API Client**:
   ```bash
   grep -n "postAuthorized" /Users/k9/Desktop/Twitch-drop/background/twitchApi.js
   grep -n "sha256Hash" /Users/k9/Desktop/Twitch-drop/background/twitchApi.js
   ```
2. **Inspect WebSocket Proxy**:
   ```bash
   grep -n -C 10 "window.WebSocket" /Users/k9/Desktop/Twitch-drop/onPage.js
   ```
3. **Verify Header Attachments**:
   ```bash
   grep -n -C 10 "Client-Integrity" /Users/k9/Desktop/Twitch-drop/background/twitchApi.js
   ```
4. **Syntax & Linter Validation**:
   ```bash
   node -c /Users/k9/Desktop/Twitch-drop/background.js
   node -c /Users/k9/Desktop/Twitch-drop/background/twitchApi.js
   node -c /Users/k9/Desktop/Twitch-drop/inject.js
   node -c /Users/k9/Desktop/Twitch-drop/onPage.js
   node -c /Users/k9/Desktop/Twitch-drop/assets/js/main.js
   ```
