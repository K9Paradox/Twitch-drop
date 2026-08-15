## 2026-08-15T05:43:43Z

You are Worker M1 for Milestone 1: Twitch GraphQL & WebSocket Automation Hardening.
Your working directory is: /Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_worker_m1/
The project workspace is: /Users/k9/Desktop/Twitch-drop
The verbatim user request is at: /Users/k9/Desktop/Twitch-drop/.agents/ORIGINAL_REQUEST.md
The project plan is at: /Users/k9/Desktop/Twitch-drop/PROJECT.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your write ownership:
- `background/twitchApi.js`
- `onPage.js`
- `inject.js`
- GraphQL and WebSocket message handling routines in `background.js`

Your mission:
Harden all Twitch GraphQL operations, error handling, response unwrapping, WebSocket proxying, and bonus points deduplication according to findings from Explorer 1 & Explorer 2 reports.

Key implementations:
1. `background/twitchApi.js`:
   - Create custom `TwitchApiError` class with properties `status`, `errors`, `operationName`.
   - In `post()` and `postAuthorized()`:
     - Check HTTP response status (`if (!res.ok) throw new TwitchApiError(...)`).
     - Parse JSON. If `json.errors && json.errors.length > 0`, throw `TwitchApiError` instead of returning the raw error dictionary.
     - For batched array responses (`Array.isArray(json)`), check each item for errors and return the array of `{ data: ... }`.
     - For single query responses, safely unwrap and return `json.data`.
   - Harden `claimDropReward(dropInstanceID)`:
     - Verify response structure: ensure `data?.claimDropReward?.status` is returned and validated (e.g. `SUCCESS` or `ELIGIBLE_FOR_CLAIM`).
   - Harden `claimChannelPoints(channelID, claimID)`:
     - Verify response structure: return `{ claimID, status: data?.claimCommunityPoints?.claim?.status || "SUCCESS" }`.
   - Ensure all 9 operations (`CoreActionsCurrentUser`, `DirectoryRoot_Directory`, `ViewerDropsDashboard`, `DropCampaignDetails`, `Inventory`, `DirectoryPage_Game`, `DropsPage_ClaimDropRewards`, `ClaimCommunityPoints`, `ChannelShell`) format their payloads, headers (`Client-Id`, `Authorization: OAuth ...`, `Client-Integrity`, `Client-Session-Id`, `X-Device-Id`), and variables correctly.
2. `onPage.js`:
   - WebSocket interception hardening:
     - Remove fragile `res.origin === "wss://hermes.twitch.tv"` check.
     - In the `window.WebSocket` proxy, capture the target URL (`url.includes("hermes.twitch.tv")` or `url.includes("pubsub-edge.twitch.tv")`).
     - Safely parse JSON payloads with `try...catch`.
     - Support message handling for `points-earned`, `claim-available`, and `drop-progress`.
   - Channel Points deduplication:
     - Prevent double-dispatching when chest clicker and WebSocket messages occur in tandem. Add a timestamp/claimID deduplication cache (e.g., ignore duplicate claims within 10 seconds).
3. `inject.js` & `background.js`:
   - Harden `claim-drop`, `claim-points`, `points-earned` message handlers in `background.js`.
   - Verify that `checkClaimDrop()` only records claims and updates stats when `client.claimDropReward()` succeeds without errors.
   - Prevent triple-counting of channel points.

Verify your changes by running syntax checks (`node -c ...`).
Deliver a complete handoff report in `/Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_worker_m1/handoff.md` and notify orchestrator via send_message.
