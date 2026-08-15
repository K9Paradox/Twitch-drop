# Regression & API Contract Verification Guardrails

1. **Baseline Diff First on Regressions**:
   - Whenever a previously working feature or data pipeline breaks following a refactor, immediately perform a `git diff` against the working commit or `origin/main` on the lowest-level data transport / API layer before adding workarounds or altering consumers.

2. **Network Contract Verification**:
   - When modifying HTTP/GraphQL wrappers, always verify the exact shape of the returned payload (e.g., unwrapped `json.data` vs. raw `{ data: ... }`).
   - Treat silent `undefined` traversals in consumer functions as data contract violations; verify payloads at the network boundary.

3. **Pre-Resolution Verification Guardrail**:
   - Do not state that a data fetching or UI rendering bug is resolved without verifying that the underlying data pipeline produces valid objects matching the expected schema.
