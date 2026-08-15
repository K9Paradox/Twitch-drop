## 2026-08-15T05:49:39Z

You are Worker M2 for Milestone 2: Stream Player Lifecycle & Memory Optimization.
Your working directory is: /Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_worker_m2/
The project workspace is: /Users/k9/Desktop/Twitch-drop
The verbatim user request is at: /Users/k9/Desktop/Twitch-drop/.agents/ORIGINAL_REQUEST.md
The project plan is at: /Users/k9/Desktop/Twitch-drop/PROJECT.md
The test suite is at: /Users/k9/Desktop/Twitch-drop/test/

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your write ownership:
- `background.js`
- `onPage.js`
- `inject.js`
- `waiting.html`

Your mission:
Implement and harden all features for Milestone 2:
1. **Service Worker Hydration Mutex & State Storage**:
   - In `background.js`, implement a memoized `hydrationPromise` in `hydrateState()` to eliminate race conditions when alarms, storage changes, and messages wake the service worker concurrently.
   - Persist `autoGetTokenWindow` ID in `chrome.storage.local` upon creation (`autoGetToken()`) and load it during hydration. In `sendInteg` message handler, cleanly close the window using the stored ID even after service worker suspensions.
2. **Stream Stall & Auto-Recovery Watchdog**:
   - Implement `settings.autoRefresh` logic in `background.js` and watchdog tick. Track stream watch progress timestamps (`lastProgressTimestamp`, `lastMinutesWatched`).
   - If an active campaign's progress has not advanced for 2 minutes (or configurable stall threshold), reload the tab or rotate to the next channel.
3. **Offline Streamer Failover & Dynamic Rotation**:
   - Periodically verify live status of `activeStream.campaign.curWatching` using `client.getStreamMetadata(curWatching)` or `client.getStream(curWatching)`.
   - If the streamer goes offline or switches categories away from the drop game, add them to `skippedStreamers` and trigger `runCampaign(true)` for seamless failover.
4. **Non-Intrusive Background Tab Management**:
   - In `windowManager("open", ...)` and `runCampaign()`, open stream tabs with `{ active: false }` to avoid stealing user window focus.
   - Tag managed tabs (via URL hash `#atd-managed=1` and `curWindow.id` storage) and do not overwrite or mute unrelated user Twitch browsing tabs.
   - In `chrome.tabs.onRemoved`, ensure clean state cleanup without infinite aggressive re-opening loops.
5. **Quality & Bandwidth Optimization**:
   - Harden `160p30` low-bandwidth enforcement in `onPage.js` with fallback DOM checks and message listening for `p:settingsChanged` / `lowQualityMode`.
   - Ensure clean interval and listener garbage collection in `onPage.js` and `inject.js`.

Verify your implementation by running syntax checks (`node -c`) and the automated test suite (`node test/run-all-tests.js`). Ensure all 159+ tests pass 100%.
Deliver your complete handoff report in `/Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_worker_m2/handoff.md` and notify orchestrator via send_message.
