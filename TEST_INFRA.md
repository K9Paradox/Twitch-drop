# E2E Test Infra: Auto Twitch Drops Pro

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + BVA + Pairwise + Workload Testing.
- Strictly adhere to Regression & API Contract Verification Guardrails.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|:---:|:---:|:---:|
| 1 | GraphQL CoreActionsCurrentUser | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | GraphQL ViewerDropsDashboard | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 3 | GraphQL DropCampaignDetails | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 4 | GraphQL Inventory | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 5 | GraphQL DirectoryPage_Game | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 6 | GraphQL DropsPage_ClaimDropRewards | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 7 | GraphQL ClaimCommunityPoints | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 8 | GraphQL ChannelShell / Stream Metadata | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 9 | WebSocket Hermes & PubSub Event Pipeline | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 10 | Service Worker Hydration & Alarms | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 11 | Stream Playback, Muting & 160p30 | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 12 | Stall Detection & Streamer Rotation | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 13 | Bonus Points Deduplication & History | ORIGINAL_REQUEST §R1, R2 | 5 | 5 | ✓ |
| 14 | Popup State Sync & Storage Reactivity | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |

## Test Architecture
- Test runner: `node test/run-all-tests.js` (native Node.js test runner, zero extra runtime dependencies)
- Directory layout:
  - `test/fixtures/`: Realistic JSON response schemas & edge cases for all 9 GraphQL operations and WebSocket events
  - `test/harness/`: Mock fetch/WebSocket engine and Chrome API mocks (`chrome.storage`, `chrome.tabs`, `chrome.alarms`, `chrome.runtime`, `chrome.cookies`)
  - `test/tier1_features/`: Isolated feature happy path tests (≥5 per feature)
  - `test/tier2_boundaries/`: Boundary values, error payloads (`errors: [...]`), 401/403/429 status codes, malformed payloads (≥5 per feature)
  - `test/tier3_combinations/`: Cross-feature interactions (e.g. campaign discovery -> stream start -> drop progress WS -> drop claim mutation -> activity log update)
  - `test/tier4_scenarios/`: Real-world end-to-end workload simulations (multi-drop campaign farming, streamer offline rotation, service worker sleep/wake lifecycle)

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|---|---|---|
| 1 | Full Lifecycle Drop Farming | F2, F3, F4, F6, F9, F10, F14 | High |
| 2 | Streamer Offline & Stall Auto-Recovery | F5, F8, F10, F11, F12 | High |
| 3 | Concurrent Channel Points & Drop Claim Event Storm | F6, F7, F9, F13, F14 | High |
| 4 | Token Expiration & Integrity Refresh Loop | F1, F5, F10 | Medium |
| 5 | Service Worker Suspension & Wakeup Re-hydration | F10, F14 | Medium |

## Coverage Thresholds
- Tier 1: ≥70 test cases (5 × 14 features)
- Tier 2: ≥70 test cases (5 × 14 features)
- Tier 3: ≥14 test cases (pairwise interactions)
- Tier 4: ≥5 realistic application scenarios
- **Total Minimum Test Cases**: ≥159 tests
