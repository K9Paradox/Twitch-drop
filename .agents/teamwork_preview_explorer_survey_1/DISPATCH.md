## 2026-08-15T05:41:31Z
You are Explorer 1 for Auto Twitch Drops Pro codebase survey.
Your working directory is: /Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_explorer_survey_1/
The project workspace is: /Users/k9/Desktop/Twitch-drop
The verbatim user request is at: /Users/k9/Desktop/Twitch-drop/.agents/ORIGINAL_REQUEST.md

Your mission:
Investigate and map the full codebase with focus on Twitch GraphQL APIs, WebSocket (Hermes/PubSub), and Network Data Contracts.
Read ORIGINAL_REQUEST.md first.

Specifically investigate:
1. All GraphQL queries and mutations used across the extension:
   - ViewerDropsDashboard, Inventory, DropCampaignDetails, DirectoryPage_Game, CoreActionsCurrentUser, DropsPage_ClaimDropRewards, ClaimCommunityPoints, etc.
   - Exact request payloads, headers (Client-ID, Authorization/OAuth, Client-Session-Id, Client-Version, X-Device-Id, Integrity tokens).
   - Response structures: verify whether responses are raw `{ data: ... }` or unwrapped `json.data`, nullability handling, error formats (`errors` array vs HTTP status codes).
2. WebSocket / Hermes / PubSub connection management:
   - Topic subscriptions (user-drop-events, community-points-channel-v1, etc.).
   - Connection lifecycle (reconnect backoff, ping/pong heartbeats, duplicate message deduplication, cleanup on disconnect).
   - Message handling for drop progress updates, drop claim notifications, community bonus points.
3. Integrity tokens and authentication:
   - Integrity token generation / acquisition mechanisms.
   - OAuth / user token retrieval from cookies or storage.
   - Token expiration detection and re-authentication flow.
4. Existing test harness / mocks for network requests and GraphQL endpoints.

Produce a comprehensive, structured report in:
`/Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_explorer_survey_1/handoff.md`
and write your progress to `progress.md`.
Notify orchestrator when done via send_message.
