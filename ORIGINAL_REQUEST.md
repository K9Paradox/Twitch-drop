# Original User Request

## Initial Request — 2026-08-15T05:40:45Z

# Auto Twitch Drops Pro — Comprehensive Perfection & Hardening

Working directory: `/Users/k9/Desktop/Twitch-drop`
Integrity mode: development

Audit, harden, optimize, and perfect the Auto Twitch Drops Pro Chrome extension (Manifest V3) into a production-grade, ultra-resilient browser extension with flawless background automation, rock-solid Twitch GraphQL/WebSocket data contracts, polished UI, and zero memory leaks.

## Requirements

### R1. Twitch GraphQL & WebSocket Automation Hardening
- Audit and stress-test all Twitch GraphQL endpoints (`ViewerDropsDashboard`, `Inventory`, `DropCampaignDetails`, `DirectoryPage_Game`, `CoreActionsCurrentUser`, `DropsPage_ClaimDropRewards`, `ClaimCommunityPoints`).
- Ensure all query wrappers correctly unwrap `json.data` and handle network failures, rate limits, token expirations, and missing integrity tokens gracefully without dropping state.
- Ensure Hermes WebSocket (`wss://hermes.twitch.tv`) listener cleanly captures bonus points, claim availability, and drop progress without redundant duplicate events or listener leaks.

### R2. Stream Player Lifecycle & Memory Optimization
- Verify low-bandwidth stream playback (160p30) operates continuously in the background without violating browser Autoplay policies or causing video stalls.
- Ensure all background alarms and content script intervals are properly throttled with zero event listener leaks or unnecessary DOM thrashing.
- Harden the streamer rotation engine (`p:skipStreamer` and drop-channel discovery) to cleanly transition tabs without orphaned processes or broken audio states.

### R3. Popup UI/UX Perfection & High-Fidelity Design
- Polish the extension popup across all tabs (`Home`, `Drops`, `Queue`, `Activity`, `Settings`) with modern dark-theme aesthetics, micro-animations, clear typography, and responsive layouts.
- Ensure all live drop reward thumbnails render crisp official Twitch asset artwork with elegant fallback vector gift glyphs when assets are loading.
- Verify real-time reactive sync between background service worker events, popup storage state, and badge indicators.

### R4. Comprehensive Automated Verification & Regression Guardrails
- Establish automated linting, syntax validation, and mock contract tests verifying that every API endpoint response structure matches consumer expectations.
- Ensure all code conforms strictly to the persisted `Regression & API Contract Verification Guardrails`.

## Acceptance Criteria

### Data & Network Layer
- [ ] Every GraphQL method in `background/twitchApi.js` unwraps and validates payloads at the network boundary, returning structured objects matching consumer expectations.
- [ ] `getDropCampaigns()`, `getInventory()`, and `getDropCampaignDetails()` reliably extract active campaigns, drop rewards, requirement minutes, and live progress.
- [ ] Claims for drops and channel points execute automatically and increment activity/stats in persistent storage.

### UI & Performance
- [ ] Home tab accurately reflects the active streamer (`@streamer`), farming game, live progress percentage bar, and current reward image/ETA.
- [ ] Drops tab lists all campaign reward items with individual thumbnails, minute requirements, and Claimed/In-Progress badges.
- [ ] Queue tab supports seamless search filtering, bulk selection (Select All / Clear All), and real-time toggle persistence.
- [ ] Tab audio toggle accurately reflects browser tab mute state without triggering Autoplay policy warnings or player stalling.
- [ ] Zero unhandled promise rejections, syntax errors, or memory leak warnings across background workers and content scripts.
