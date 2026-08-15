# Chrome Web Store Listing — Auto Twitch Drops Pro

## Store Metadata

- **Name**: Auto Twitch Drops Pro
- **Version**: 1.5.0
- **Short Description**: Automatically claim Twitch drops, channel points, and monitor drop campaigns in the background.
- **Category**: Productivity / Fun & Games
- **Pricing**: Free

---

## Detailed Description

**Auto Twitch Drops Pro** is a lightweight, background-enabled Chrome extension built on Manifest V3 designed to help gamers and Twitch viewers automatically track campaigns, collect drop rewards, and claim community channel points with zero effort.

### 🌟 Key Features

- 🎁 **Automatic Drop Claiming**: Monitors active drop campaigns in real time and claims completed reward items directly to your Twitch inventory.
- 💎 **Channel Points Collector**: Automatically clicks and claims bonus channel points chest icons as soon as they appear.
- ⚡ **Smart Auto-Queue**: Automatically prioritizes and sequences multiple game campaigns by expiration date, ensuring you never miss limited-time drops.
- 📊 **Real-time Live Progress & ETA**: Live progress bar showing minutes watched, requirement thresholds, and estimated completion time.
- 📜 **Claim History & Activity Feed**: View a detailed, timestamped feed of recent drop claims and points redemptions.
- 🔇 **Tab-Level Audio Muting**: Keeps background stream tabs completely silent without muting the HTML5 player so watch progress never halts.
- 🔋 **Modern Manifest V3 Architecture**: Ephemeral service worker with persistent alarm scheduling, low memory usage, and zero battery drain.

---

## Permissions Justification

| Permission | Justification |
| :--- | :--- |
| `alarms` | Required to schedule periodic background tasks (drop verification, watchdog timer, token refresh) in compliance with Manifest V3 service worker lifecycle. |
| `storage` | Required to store user preferences, active queue settings, claimed drop statistics, and local activity history. |
| `tabs` | Required to inspect active Twitch stream tabs, mute stream audio in the background, and open inventory/stream links. |
| `cookies` | Required to read the local session authentication cookies (`auth-token`, `unique_id`) to authenticate GQL requests on behalf of the user. |
| `contentSettings` | Required to configure background autoplay permissions for Twitch streams so video playback does not stall when minimized. |

### Host Permissions
- `*://*.twitch.tv/*` & `https://gql.twitch.tv/*`: Required to interact with Twitch live streams, query campaign progress via GraphQL, and claim drop items.

---

## Privacy & Data Use

- **Data Collection**: No personal data, email, passwords, or browsing activity is collected, transmitted, or sold to any third party.
- **Local Storage Only**: All tokens and session IDs are stored strictly on the user's local device (`chrome.storage.local`) and used exclusively to communicate with official Twitch endpoints (`twitch.tv` and `gql.twitch.tv`).
- **Telemetry**: Zero third-party telemetry, analytics, or trackers.

---

## Version History

- **v1.5.0**:
  - Overhauled background service worker with persistent `chrome.alarms` scheduling.
  - Added Live Activity Feed and Claim History log.
  - Redesigned popup UI with Twitch dark theme, glassmorphic cards, and smooth micro-interactions.
  - Enhanced smart queue sequencing based on campaign expiration dates.
  - Removed legacy dependencies and unified local storage persistence.
- **v1.4.2**:
  - Initial Manifest V3 migration and background stream watchdog.
