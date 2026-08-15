# TEST READY: Auto Twitch Drops Pro Test Suite

## Status
- **Test Infrastructure**: COMPLETE & VERIFIED
- **Total Test Cases**: 159
- **Passing**: 159 (100%)
- **Failing**: 0
- **Execution Command**: `node test/run-all-tests.js`
- **Zero External Dependencies**: Pure native Node.js (`node:test`, `node:assert`)

---

## Feature Coverage Matrix

| # | Feature | Scope / Source | Tier 1 (Isolation) | Tier 2 (Boundaries) | Tier 3 (Cross-Combos) | Tier 4 (Workloads) | Status |
|---|---|---|:---:|:---:|:---:|:---:|:---:|
| 1 | GraphQL `CoreActionsCurrentUser` | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 2 | GraphQL `ViewerDropsDashboard` | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 3 | GraphQL `DropCampaignDetails` | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 4 | GraphQL `Inventory` | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 5 | GraphQL `DirectoryPage_Game` | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 6 | GraphQL `DropsPage_ClaimDropRewards` | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 7 | GraphQL `ClaimCommunityPoints` | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 8 | GraphQL `ChannelShell` / Stream Metadata | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 9 | WebSocket Hermes & PubSub Pipeline | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ | PASSED |
| 10 | Service Worker Hydration & Alarms | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ | PASSED |
| 11 | Stream Playback, Muting & 160p30 | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ | PASSED |
| 12 | Stall Detection & Streamer Rotation | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ | PASSED |
| 13 | Bonus Points Deduplication & History | ORIGINAL_REQUEST §R1, R2 | 5 | 5 | ✓ | ✓ | PASSED |
| 14 | Popup State Sync & Storage Reactivity | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ | ✓ | PASSED |
| **Total** | **All 14 Features** | — | **70** | **70** | **14** | **5** | **159 / 159** |

---

## Test Directory Architecture

```
test/
├── fixtures/
│   ├── graphql-fixtures.js      # Realistic responses for all 9 GQL operations
│   ├── websocket-fixtures.js    # Hermes points-earned, claim-available, drop-progress frames
│   └── error-fixtures.js        # GQL error objects, 401/403/429/500 HTTP errors, expired tokens
├── harness/
│   ├── chrome-mock.js           # MV3 chrome APIs (storage, tabs, alarms, runtime, cookies, etc.)
│   ├── fetch-mock.js            # Mock Fetch router matching by GQL operationName or URL
│   ├── websocket-mock.js        # Mock WebSocket engine simulating Twitch Hermes/PubSub pushes
│   ├── dom-mock.js              # In-page DOM mocks for onPage.js / inject.js testing
│   └── sandbox.js               # Test isolation coordinator & global mock reset
├── tier1_features/              # 14 test files × 5 tests = 70 tests (isolated feature happy paths)
│   ├── f1_core_actions_current_user.test.js
│   ├── f2_viewer_drops_dashboard.test.js
│   ├── f3_drop_campaign_details.test.js
│   ├── f4_inventory.test.js
│   ├── f5_directory_page_game.test.js
│   ├── f6_drops_page_claim_drop_rewards.test.js
│   ├── f7_claim_community_points.test.js
│   ├── f8_channel_shell_metadata.test.js
│   ├── f9_websocket_pipeline.test.js
│   ├── f10_service_worker_alarms.test.js
│   ├── f11_stream_playback_muting.test.js
│   ├── f12_stall_detection_rotation.test.js
│   ├── f13_bonus_points_dedup.test.js
│   └── f14_popup_state_sync.test.js
├── tier2_boundaries/            # 14 test files × 5 tests = 70 tests (nulls, rate limits, 401s, timeouts)
│   ├── f1_boundary.test.js ... f14_boundary.test.js
├── tier3_combinations/          # 14 cross-feature pairwise integration tests
│   └── combinations.test.js
├── tier4_scenarios/             # 5 full application real-world workload scenarios
│   └── scenarios.test.js
└── run-all-tests.js             # Standalone test runner with ANSI color progress & summary
```

---

## Real-World Workload Scenarios (Tier 4)
1. **Full Lifecycle Drop Farming**: Complete end-to-end simulation from cookie discovery, campaign extraction, tab launching, Hermes drop progress events, inventory syncing, reward claiming, storage incrementing, and tab cleanup.
2. **Streamer Offline & Stall Auto-Recovery**: Background worker monitors channel metadata, detects offline status, queries alternate live channels with drops, and seamlessly rotates tab URL without crashing.
3. **Concurrent Channel Points & Drop Claim Event Storm**: Burst of duplicate chest clicks, WebSocket points, and drop claims processed with guaranteed deduplication and zero overcounting.
4. **Token Expiration & Integrity Refresh Loop**: Auto-detects expired integrity token (< 16 min remaining), re-fetches fresh token from `/integrity`, and completes authenticated GQL operation.
5. **Service Worker Suspension & Wakeup Re-hydration**: Simulates MV3 worker sleep cycle, triggers periodic alarm wakeup, re-hydrates state mutex from `chrome.storage.local`, and resumes watching smoothly.

---

## How to Run
```bash
# Run the entire test suite (Tiers 1-4)
node test/run-all-tests.js

# Or run via npm
npm test
```
