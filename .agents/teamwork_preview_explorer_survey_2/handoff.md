# Codebase Survey Report: Background Service Worker Lifecycle, Stream Player Automation, Tab Management & Memory Leak Prevention

**Agent**: Explorer 2  
**Date**: 2026-08-15  
**Workspace**: `/Users/k9/Desktop/Twitch-drop`  
**Working Directory**: `/Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_explorer_survey_2/`  

---

## 1. Observation

Direct code observations across all source files in the project (`manifest.json`, `background.js`, `background/twitchApi.js`, `inject.js`, `onPage.js`, `assets/js/main.js`, `index.html`):

### 1.1 Manifest & Background Service Worker Lifecycle
- **Manifest Architecture** (`manifest.json:9-20`):
  - Declares `"manifest_version": 3`, `"background": { "service_worker": "background.js", "type": "module" }`.
  - Permissions declared: `["alarms", "storage", "tabs", "cookies", "contentSettings", "notifications"]`.
  - Permissions omitted: `webNavigation`, `offscreen`, `declarativeNetRequest`.
  - Content scripts: `inject.js` matches `https://*.twitch.tv/*` at `run_at: "document_start"`.
  - Web accessible resources: `onPage.js` and `assets/img/*.png`.
- **Periodic Alarm Scheduling** (`background.js:345-350`):
  ```js
  function setupAlarms() {
      chrome.alarms.create("watchdogAlarm", { periodInMinutes: 0.5 });
      chrome.alarms.create("dropCheckAlarm", { periodInMinutes: 3 });
      chrome.alarms.create("tokenRefreshAlarm", { periodInMinutes: 15 });
      chrome.alarms.create("badgeRefreshAlarm", { periodInMinutes: 10 });
  }
  ```
  - `watchdogAlarm` specifies `periodInMinutes: 0.5` (30 seconds). In production Chrome release builds, alarm periods under 1 minute are clamped by the browser to `1.0` minute minimum.
- **State Persistence & Hydration** (`background.js:67-123`):
  - `hydrateState()` reads `exEnabled`, `settings`, `autoDropGames`, `priorityStreams`, `extStats`, `listOfConnected`, `activeStream`, `curWindow`, `activityHistory`, `oauthToken`, `deviceId`, `userId`, `uuid`, `twitchInteg` from `chrome.storage.local`.
  - `isHydrated` is an in-memory boolean flag. No promise memoization or locking is used; simultaneous calls to `hydrateState()` execute parallel reads.
  - Ephemeral variables lost on worker sleep: `autoGetTokenWindow` (`background.js:62, 462-465, 1224`), `gettingStreamObj` (`background.js:57-61`).
- **Concurrency & Lack of Mutexes**:
  - `checkForDrops()` (`background.js:1142-1190`), `createCampaign()` (`background.js:958-1140`), `handleWatchdogTick()` (`background.js:367-404`), and `checkClaimDrop()` (`background.js:1192-1219`) contain no concurrency locks or idempotency guards.
  - If `dropCheckAlarm` fires while a manual `p:startCampaign` or previous check is in flight, parallel execution proceeds without deduplication.

### 1.2 Stream Player Automation & Bandwidth Optimization
- **Playback Execution Environment**:
  - Full browser tab managed by `windowManager("open", ...)` (`background.js:1231-1271`).
  - No `offscreen` document used or permitted in manifest.
- **160p30 Low Bandwidth Configuration** (`onPage.js:5-9`):
  ```js
  try {
      localStorage.setItem("player-volume", JSON.stringify({ "default": 0.5, "volume": 0.5, "muted": false }));
      localStorage.setItem("video-quality", JSON.stringify({ "default": "160p30" }));
      localStorage.setItem("low-latency", JSON.stringify({ "default": false }));
  } catch (e) {}
  ```
  - Executed on cold page load before Twitch player init.
  - No active DOM fallback (gear menu click) if the player is already initialized or during in-page SPA navigation.
  - No dynamic synchronization between popup `lowQualityMode` setting and `onPage.js`.
- **Autoplay & Volume Mute Architecture**:
  - `enableAutoplayForTwitch()` (`background.js:157-172`) configures `chrome.contentSettings.autoplay` to allow playback.
  - Tab-level mute (`chrome.tabs.update(curWindow.id, { muted: true })` at `background.js:939`) keeps the tab silent while internal player volume is 0.5 (`onPage.js:6`), allowing Twitch drop tracking to proceed uninhibited.
  - Page Visibility API spoofing (`onPage.js:11-53`) overrides `Document.prototype.hidden` to `false`, `Document.prototype.visibilityState` to `'visible'`, and stops `visibilitychange` propagation to prevent video pause/throttle on background/minimized tabs.
  - `safePlaybackWatchdog()` (`onPage.js:69-87`) triggers synthetic click on `[data-a-target="player-overlay-click-to-unmute"]` / `[data-test-selector="unmute-button"]` and forces `video.play()` if paused.
- **Stream Stall & Buffer Freeze Detection**:
  - `settings.autoRefresh` is defined on `background.js:28` ("Automatically refreshes stream tab if no watch progress is recorded after 2 minutes"), but is **never referenced or checked anywhere in `background.js`**.
  - No stalled video detection (`video.currentTime` freezing, `waiting`/`stalled` events, error overlay detection like Error #2000/#3000/#4000) exists in `onPage.js` or `background.js`.

### 1.3 Streamer Rotation & Tab Lifecycle
- **Campaign Prioritization Algorithm** (`background.js:1142-1185`):
  - Filters active campaigns matching `autoDropGames`.
  - Performs sequential `await client.getDropCampaignDetails(campaign.id)` for each candidate.
  - Collects games with incomplete drops, calculates `endsAt = new Date(campaignDetails.endAt).getTime()`.
  - Sorts candidate games ascending by expiration timestamp (`gamesToRun.sort((a, b) => a.endsAt - b.endsAt)`).
- **Channel Selection & Discovery** (`background.js:896-921`, `background/twitchApi.js:256-308, 413-423`):
  - Whitelisted channels: picks from `curCamp.streamers` (filtering `skippedStreamers`).
  - Open category: calls `client.getChannelWithDrops(gameName, curCamp.id, slug, skippedLogins)`, which executes `DirectoryPage_Game` GraphQL with Drops-Enabled tag `c2542d6d-cd10-4532-919b-3d19f30a768b` sorted by `VIEWER_COUNT`.
- **Missing Offline Channel Detection**:
  - `background/twitchApi.js` provides `getStream(login)` (lines 360-395) and `getStreamMetadata(login)` (lines 425-450).
  - Neither function is ever called in `background.js`. Watchdog ticks do not verify if `activeStream.campaign.curWatching` is still live or still streaming the target category.
- **Tab Management Flaws in `windowManager`** (`background.js:1231-1279`):
  - **Tab Hijacking**: Queries `*://*.twitch.tv/*`. If a user is watching a personal stream, the extension reuses that tab, overwriting the URL and muting it.
  - **Focus Stealing**: `runCampaign` passes `{ active: true, url: streamUrl }`, stealing browser focus on stream start.
  - **Re-Open Loop**: `chrome.tabs.onRemoved` (`background.js:828-843`) schedules an automatic re-open after 3 seconds if the tab was closed, preventing intentional user closure without toggling the extension off.

### 1.4 Memory Leak & Performance Analysis
- **Timers & DOM Listeners**:
  - `inject.js:40`: `setInterval(updateTabTitleIndicator, 3000)` modifies `document.title` every 3 seconds.
  - `onPage.js:118`: `setInterval` runs every 5 seconds for `safePlaybackWatchdog()` and `autoClaimPointsChests()`.
- **Channel Points Bonus Claim Duplication**:
  - `onPage.js:106-111`: DOM chest clicker posts `points-earned` (+50).
  - `onPage.js:207-213`: Hermes WebSocket interceptor posts `claim-points`, calling `client.claimChannelPoints()` -> `extStats.claimedPoints += pts` (`background.js:582-586`).
  - `onPage.js:199-205`: Hermes WebSocket interceptor posts `points-earned`, adding another +50 (`background.js:598-604`).
  - **Result**: Single chest yields triple counting (+150 pts instead of +50) and 3 duplicate log entries in `activityHistory`.
- **Array & Storage Bounding**:
  - `activityHistory` is explicitly bounded to `50` entries (`background.js:76, 150-152`).
  - `listOfConnected` is bounded by unique game names.
  - Manifest V3 service worker lifecycle naturally bounds background memory footprint upon periodic worker termination.

---

## 2. Logic Chain

1. **Service Worker Termination vs. Ephemeral State**:
   - *Observation*: Manifest V3 suspends the service worker after ~30s of inactivity. `autoGetTokenWindow` is an in-memory variable initialized to `0` on line 62.
   - *Reasoning*: When `autoGetToken()` creates a token window (`background.js:1224`), the worker suspends while the window loads. Upon receiving `sendInteg` (`background.js:462`), the waking worker has `autoGetTokenWindow === 0`. The check `if (autoGetTokenWindow !== 0)` fails, leaving the popup window orphaned and permanently open on the user's desktop.
   - *Conclusion*: All cross-lifecycle identifiers (window IDs, active operation tokens) must be persisted in `chrome.storage.local`.

2. **Hydration Race Condition**:
   - *Observation*: `hydrateState()` is async and checks `if (isHydrated) return;` at `background.js:84`, setting `isHydrated = true` at `background.js:119`.
   - *Reasoning*: If multiple events (e.g. alarm + `runtime.onMessage` + storage change) trigger simultaneously when the worker boots, all pass the `isHydrated` guard before the first completes storage retrieval and cookie detection.
   - *Conclusion*: A memoized promise (`hydrationPromise`) must serialize initial hydration across concurrent callers.

3. **Stall Recovery Gap**:
   - *Observation*: Settings expose `autoRefresh: true` ("Automatically refreshes stream tab if no watch progress is recorded after 2 minutes"), but grep confirms `settings.autoRefresh` is never checked in `background.js`.
   - *Reasoning*: If a stream freezes, shows a network error, or the channel goes offline, `currentMinutesWatched` ceases to increment. Because watchdog ticks only inspect inventory without checking progress deltas over time, the system hangs indefinitely.
   - *Conclusion*: A watchdog progress tracker (`lastProgressTimestamp`, `stalledMinutesCount`) must compare `minutesWatched` across ticks and trigger channel rotation or tab reload upon stagnation exceeding 2-3 minutes.

4. **Offline Streamer Deadlock**:
   - *Observation*: `twitchApi.js` exports `getStream` and `getStreamMetadata`, but neither is invoked in `background.js`.
   - *Reasoning*: When a streamer goes offline or changes games, the channel URL remains active on Twitch with an offline screen or raid redirect. The extension continues to treat the tab as active.
   - *Conclusion*: Streamer health checks must periodically verify channel live status and category match, automatically triggering `p:skipStreamer` / `runCampaign(true)` if offline.

5. **Tab Hijacking & User Disruption**:
   - *Observation*: `windowManager("open")` queries `*://*.twitch.tv/*` without distinguishing user-created tabs from extension-managed tabs, and passes `{ active: true }`.
   - *Reasoning*: If a user is actively browsing Twitch in another tab, the extension redirects their tab and steals foreground window focus.
   - *Conclusion*: Extension stream tabs must be tagged (e.g. URL query parameter `#atd-managed=1` or tracked `managedTabId` stored in `storage.local`) and opened with `{ active: false }` to ensure background non-intrusive operation.

6. **Channel Points Triple-Counting**:
   - *Observation*: Bonus chest triggers DOM click (`onPage.js:106`), WebSocket `claim-available` (`onPage.js:207`), and WebSocket `points-earned` (`onPage.js:199`).
   - *Reasoning*: Each of these 3 pathways independently dispatches a message to `background.js`, each incrementing `extStats.claimedPoints` and calling `logActivity()`.
   - *Conclusion*: Deduplicate bonus point claims using a sliding window set of `claimID` and timestamp hashes, ignoring synthetic DOM messages when WebSocket automation is active.

---

## 3. Caveats

- **Offscreen Document API**: Chrome MV3 supports `offscreen` documents with `AUDIO_PLAYBACK` and `DOM_PARSER` reasons, but Twitch's drop tracking engine relies on proprietary HTML5 player scripts, signed cookies, and WebSockets executing in a full web browsing context. Running full Twitch playback inside an offscreen document requires validating that Twitch video decode and telemetry behave identically to tabs.
- **Twitch HTML5 Player Quality Selectors**: Twitch frequently updates class names and data attributes on its web player UI. Using `localStorage` overrides for `video-quality: 160p30` is resilient across DOM refactors, but verifying applied stream bitrate requires hooking the internal player JS instance or DOM gear menu.
- **No other caveats**: The full codebase (31 files) has been inspected.

---

## 4. Conclusion

The Auto Twitch Drops Pro codebase has a solid foundation for Manifest V3 background operation, but contains 7 critical architectural flaws requiring hardening:

| Issue # | Area | Severity | Root Cause & File Location | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **I1** | Service Worker Lifecycle | High | `autoGetTokenWindow` not persisted in storage (`background.js:62, 1224`) | Orphaned popup windows remain open on user desktop after worker suspension. |
| **I2** | Concurrency / Hydration | High | `hydrateState()` lacks promise memoization (`background.js:83-123`) | Concurrent event bursts trigger redundant storage reads and race conditions. |
| **I3** | Stall Detection | High | `settings.autoRefresh` defined but not implemented (`background.js:28`) | Stream buffer freezes or network errors freeze drop farming indefinitely. |
| **I4** | Streamer Rotation | High | No channel live/game check in watchdog (`background.js:367-404`) | Streamer going offline halts drop progress with no automatic failover. |
| **I5** | Tab Management | Medium | `windowManager` captures user Twitch tabs & steals focus (`background.js:1231-1271`) | Disrupts user browsing; forces new tabs into foreground. |
| **I6** | Data Duplication | Medium | Chest clicks & WebSockets both dispatch point events (`onPage.js:106, 199, 207`) | 3x inflated channel point stats and duplicate activity log rows. |
| **I7** | Dynamic Quality Sync | Low | `lowQualityMode` setting changes not messaged to `onPage.js` | Changing 160p toggle does not dynamically reconfigure active tab quality. |

---

## 5. Verification Method

To independently verify all findings and validate future hardening:

### 5.1 Static Verification Commands
```bash
# 1. Verify JS syntax across background and page scripts
node -c /Users/k9/Desktop/Twitch-drop/background.js
node -c /Users/k9/Desktop/Twitch-drop/background/twitchApi.js
node -c /Users/k9/Desktop/Twitch-drop/inject.js
node -c /Users/k9/Desktop/Twitch-drop/onPage.js
node -c /Users/k9/Desktop/Twitch-drop/assets/js/main.js

# 2. Check for missing autoRefresh references
grep -rn "autoRefresh" /Users/k9/Desktop/Twitch-drop/background.js

# 3. Check for unused getStream / getStreamMetadata in background.js
grep -rn "getStream" /Users/k9/Desktop/Twitch-drop/background.js
```

### 5.2 Dynamic Invalidation & Testing Conditions
1. **Service Worker Suspension & Token Window Cleanup**:
   - Trigger `autoGetToken()` in background -> verify window ID is stored in `chrome.storage.local`.
   - Terminate service worker in `chrome://extensions` (Inspect Views -> Service Worker -> Stop).
   - Simulate `sendInteg` message -> verify window is properly closed using persisted ID.
2. **Stall & Offline Recovery Verification**:
   - Navigate active stream tab to `about:blank` or an offline channel while campaign is active.
   - Wait 2 watchdog ticks -> verify watchdog detects 0 progress delta and automatically triggers `runCampaign(true)` to rotate to a live streamer.
3. **Tab Isolation & Background Mode**:
   - Open a personal Twitch tab (`twitch.tv/shroud`).
   - Start a campaign -> verify extension opens a separate non-active background tab with `#atd-managed=1` without altering the user's tab.
4. **Point Deduplication**:
   - Trigger a simulated bonus chest claim -> verify `extStats.claimedPoints` increases by exactly 50 and only 1 activity log row is created.
