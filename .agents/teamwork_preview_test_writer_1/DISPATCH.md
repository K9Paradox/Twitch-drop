## 2026-08-15T05:43:43Z

You are the E2E Test Writer for Auto Twitch Drops Pro.
Your working directory is: /Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_test_writer_1/
The project workspace is: /Users/k9/Desktop/Twitch-drop
The verbatim user request is at: /Users/k9/Desktop/Twitch-drop/.agents/ORIGINAL_REQUEST.md
The project plan is at: /Users/k9/Desktop/Twitch-drop/PROJECT.md
The test specification is at: /Users/k9/Desktop/Twitch-drop/TEST_INFRA.md

Your mission:
Design and build a complete, high-reliability, opaque-box automated test harness and test suite in `test/` verifying all requirements across Tiers 1-4 without any external runtime dependencies (using pure Node.js `node:test` or custom runner in `node test/run-all-tests.js`).

Tasks:
1. Create `test/harness/`:
   - Mock fetch implementation supporting Twitch GraphQL endpoints (`https://gql.twitch.tv/gql`, `https://gql.twitch.tv/integrity`).
   - Mock Chrome extension APIs (`chrome.storage.local`, `chrome.tabs`, `chrome.alarms`, `chrome.runtime`, `chrome.cookies`, `chrome.contentSettings`, `chrome.notifications`).
   - Mock WebSocket & EventEmitter engine simulating Hermes (`wss://hermes.twitch.tv`) and PubSub (`wss://pubsub-edge.twitch.tv/v1`).
2. Create `test/fixtures/`:
   - Realistic JSON response fixtures for all 9 GraphQL queries & mutations (`CoreActionsCurrentUser`, `DirectoryRoot_Directory`, `ViewerDropsDashboard`, `DropCampaignDetails`, `Inventory`, `DirectoryPage_Game`, `DropsPage_ClaimDropRewards`, `ClaimCommunityPoints`, `ChannelShell`).
   - Realistic WebSocket messages (`points-earned`, `claim-available`, `drop-progress`).
   - Error fixtures: `{ errors: [{ message: "...", status: 401 }] }`, expired integrity token, rate limit 429, network failure.
3. Build comprehensive test suites across all 4 tiers adhering to `TEST_INFRA.md`:
   - `test/tier1_features/`: Feature coverage (≥5 tests per feature, happy path in isolation, total ≥70 tests).
   - `test/tier2_boundaries/`: Boundary values, error handling, nullability, rate limits, token expirations (≥5 tests per feature, total ≥70 tests).
   - `test/tier3_combinations/`: Pairwise and cross-feature interactions (total ≥14 tests).
   - `test/tier4_scenarios/`: Real-world workload simulations (full lifecycle drop farming, streamer offline recovery, event storm deduplication, token renewal, worker sleep/wake, total ≥5 tests).
4. Create `test/run-all-tests.js`:
   - Unified test runner executable via `node test/run-all-tests.js` with clear ANSI color reporting, total test count, assertions, and pass/fail summary.
5. Execute the test suite and verify runner works as expected.
6. Publish `TEST_READY.md` at `/Users/k9/Desktop/Twitch-drop/TEST_READY.md` following the template in `PROJECT.md` / `TEST_INFRA.md`.
7. Deliver structured handoff report in `/Users/k9/Desktop/Twitch-drop/.agents/teamwork_preview_test_writer_1/handoff.md` and notify orchestrator via send_message.
