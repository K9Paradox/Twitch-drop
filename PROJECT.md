# Project: Auto Twitch Drops Pro

## Architecture
Auto Twitch Drops Pro is a Manifest V3 Chrome Extension designed for resilient background automation of Twitch Drops and Community Points with zero memory leaks, robust data contracts, and a dark-theme UI.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Extension Popup                                 │
│  (index.html, assets/js/main.js, assets/css/main.css, assets/img/*)         │
│  - 5 Tabs: Home, Drops, Queue, Activity, Settings + Disabled Overlay        │
│  - Real-time reactive storage hydration & message listeners                 │
│  - Quick Stream Controls Toolbar, Searchable Dropdowns, Fallback SVGs       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ chrome.runtime.sendMessage / storage
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                    Background Service Worker (background.js)                │
│  - Alarm-driven scheduler: watchdogAlarm, dropCheckAlarm, tokenRefreshAlarm │
│  - Hydration Mutex & State Manager (persisted in chrome.storage.local)      │
│  - Stream Rotation Engine & Channel Discovery with Offline Failover         │
│  - Non-intrusive Background Tab Manager (#atd-managed=1)                    │
│  - Stall Watchdog & Automatic Recovery                                      │
└───────────────────┬──────────────────────────────────┬──────────────────────┘
                    │ HTTPS (fetch)                    │ chrome.tabs / content
┌───────────────────▼───────────────┐  ┌───────────────▼──────────────────────┐
│   Twitch GraphQL Client Engine    │  │    In-Page Interceptors & Playback   │
│      (background/twitchApi.js)    │  │       (inject.js, onPage.js)         │
│  - 9 GQL Queries & Mutations      │  │  - Low bandwidth 160p30 forcing      │
│  - Strict unwrapping & errors     │  │  - Page Visibility API spoofing      │
│  - Auth & Client-Integrity        │  │  - Hermes & PubSub WS interception   │
│  - Token expiration handling      │  │  - Deduplicated bonus points claim   │
└───────────────────────────────────┘  └──────────────────────────────────────┘
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---|---|---|---|
| 1 | GraphQL Contract Hardening & Error Handling | Inspect `json.errors`, unwrap `json.data` properly for single & batched queries, return typed error objects | M1 | Survey (Explorer 1) |
| 2 | Drops Reward Claim Hardening | Validate `claimDropReward.status === "SUCCESS"` before incrementing stats, triggering notifications and sounds | M1 | Survey (Explorer 1) |
| 3 | WebSocket & PubSub Proxy Hardening | Remove fragile `res.origin` check, support `hermes.twitch.tv` and `pubsub-edge.twitch.tv`, handle JSON parse safely | M1 | Survey (Explorer 1) |
| 4 | Channel Points Bonus Claim Deduplication | Deduplicate chest clicks, WebSocket `claim-available`, and `points-earned` events to prevent 3x overcounting | M1 | Survey (Explorer 1 & 2) |
| 5 | Token & Integrity Security | Store and renew OAuth/Client-Integrity tokens cleanly without stale headers | M1 | Survey (Explorer 1) |
| 6 | Service Worker Hydration Mutex | Promise-memoized `hydrateState()` preventing race conditions across concurrent boot triggers | M2 | Survey (Explorer 2) |
| 7 | Persistent Window/Tab Lifecycle | Persist `autoGetTokenWindow` ID in storage to eliminate orphaned popup windows across service worker suspensions | M2 | Survey (Explorer 2) |
| 8 | Stream Stall & Freeze Watchdog | Implement stalled stream watchdog (`settings.autoRefresh`) tracking progress deltas and refreshing/rotating stalled streams | M2 | Survey (Explorer 2) |
| 9 | Offline Channel Detection & Failover | Periodically verify channel live status and category match via `getStreamMetadata()`, auto-triggering rotation on offline streams | M2 | Survey (Explorer 2) |
| 10 | Background Tab Isolation & Non-Intrusive Playback | Tag extension-managed stream tabs (`#atd-managed=1`), open in background (`active: false`), prevent user tab hijacking | M2 | Survey (Explorer 2) |
| 11 | Real-Time Reactive Popup Synchronization | Add `chrome.storage.onChanged` listener in `main.js` and real-time status/error banners (unauthenticated, network error) | M3 | Survey (Explorer 3) |
| 12 | Popup UI/UX Polish & Dynamic Quality Sync | Polish micro-animations, quick controls, responsive layout, dynamic `lowQualityMode` settings sync to active stream tab | M3 | Survey (Explorer 3) |
| 13 | Asset Optimization & Fallback SVG Glyphs | Clean unreferenced assets, verify all inline SVG fallbacks and image error handlers | M3 | Survey (Explorer 3) |
| 14 | Automated Mock Contract Test Suite (Tiers 1-4) | Comprehensive mock test harness verifying all 9 GQL endpoints, WebSocket parsing, error branches, and contract schemas | Test Track / M4 | Survey (All Explorers) |
| 15 | Adversarial Coverage Hardening (Tier 5) | White-box stress-testing, fault injection, edge-case simulation, and memory/listener leak validation | M4 Phase 2 | Project Pattern |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| MT | E2E Testing Track | Mock contract test harness, test runner, fixtures for all GraphQL/WebSocket payloads (Tiers 1-4) | none | IN_PROGRESS |
| M1 | Twitch GraphQL & WebSocket Automation Hardening | Hardening `twitchApi.js`, `onPage.js` WS/PubSub proxying, `json.data` / `errors` unwrapping, bonus points deduplication | none | PLANNED |
| M2 | Stream Player Lifecycle & Resilient Worker Automation | Service worker hydration mutex, token window storage persistence, stall watchdog, offline failover, non-intrusive background tabs | M1 contracts | PLANNED |
| M3 | Popup UI/UX Perfection & Reactive State Sync | `chrome.storage.onChanged` reactivity, auth/error banners, micro-animations, dynamic settings sync, asset cleanup | M1, M2 state | PLANNED |
| M4 | Final Integration & 100% Verification (Tiers 1-5) | Pass 100% of E2E test suite (Tiers 1-4) + Tier 5 Adversarial Coverage Hardening with Challenger loop | MT, M1, M2, M3 | PLANNED |

## Interface Contracts
### `background/twitchApi.js` ↔ Consumers (`background.js`, tests)
- `post(body, isBatched)`: Returns `{ data: Object }` (or `Array<{ data: Object }>`) or throws `TwitchApiError`.
- `postAuthorized(body, isBatched)`: Attaches OAuth + Client-Integrity + Session headers. Returns unwrapped `data` object (or batched array). Throws on `{ errors: [...] }` or HTTP error.
- `claimDropReward(dropInstanceID)`: Returns `{ status: "SUCCESS" | "ELIGIBLE_FOR_CLAIM" | string, dropInstanceID: string }`. Throws on failure.
- `claimChannelPoints(channelID, claimID)`: Returns `{ claimID: string, status: string }`. Deduplicated before dispatch.
- `getChannelWithDrops(gameName, campaignId, slug, skippedLogins)`: Returns `{ channelLogin: string, stream: Object }` or `null`.

### Background ↔ Extension Popup (`main.js`)
- Communication via `chrome.storage.local` and `chrome.runtime.onMessage`.
- `chrome.storage.onChanged` triggers UI updates across active tabs.
- Error/Auth State: `authState: { isAuthenticated: boolean, username: string | null, error: string | null }`.

## Code Layout
```
/Users/k9/Desktop/Twitch-drop/
├── manifest.json              # MV3 configuration, permissions, content scripts
├── background.js              # Background service worker & automation engine
├── background/
│   ├── twitchApi.js           # Twitch GraphQL & Internal API Client
│   └── buffer.js              # Buffer polyfill
├── inject.js                  # Document_start content script bridge
├── onPage.js                  # In-page hook (player visibility, WebSocket proxy)
├── index.html                 # Extension popup HTML UI
├── assets/
│   ├── js/
│   │   ├── main.js            # Popup UI controller
│   │   └── jquery.js          # Vendored jQuery
│   ├── css/
│   │   └── main.css           # Dark theme design system & animations
│   └── img/                   # Icons & artwork
├── waiting.html               # Stream waiting placeholder tab
└── test/                      # E2E & Mock Contract Test Suite (Test Track)
    ├── harness/               # Mock server & test runner
    ├── fixtures/              # GraphQL & WebSocket response fixtures
    └── tests/                 # Tier 1-4 contract & behavioral tests
```
