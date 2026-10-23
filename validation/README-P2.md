# Reproducing the isolated P2 validation

Baseline: `361f92d9a8b3c1f87597fb66d9c62bd230d8097a`. Use a separate checkout/worktree and the exact lockfile. Never load Production env files. This candidate has no real provider credentials.

- Node: 24.22.1 at `/tmp/mahshar-provider-tools/node-v24.22.1-linux-x64/bin` for this run. Put that bin directory first in PATH, then run `python3 tests/provider-auth/run.py`. Set `MAHSHAR_AUTH_RESULTS` to an evidence file path. The runner uses synthetic config and fully mocked service boundaries.
- Build: `python3 validation/build.py`. `MAHSHAR_NODE_BIN` can select an existing Node 24 installation. The build needs public assets from Google Fonts; no live database or paid provider is configured.
- Database: set `MAHSHAR_PG_BIN` to a local PostgreSQL bin directory, then run `python3 tests/provider-auth/postgres.py`. It initializes and destroys only its own temporary Unix-socket cluster, applies all 54 baseline migrations and P2, and accepts no database URL. Full server binaries for PostgreSQL 16 and 17 were used. Local socket execution needs the environment's sandbox permission.
- Browser: run `python3 tests/provider-auth/browser-run.py` with `MAHSHAR_PLAYWRIGHT_MODULE` and `MAHSHAR_CHROMIUM_EXECUTABLE` pointing to installed Playwright/Chromium. This starts only a local test adapter. The mock consent page is not a real provider authorization.
- Built runtime: run Node 24 with `tests/provider-auth/runtime-smoke.mjs` and the same browser variables. It starts Next on localhost with synthetic configuration and blocks external browser requests.
- Scope: `python3 validation/check-scope.py` checks the original workspace and previous combined backup without modifying either. Those original paths must be available for reproduction.

The paths used for Chromium and the local libraries are recorded by the readiness report and test logs. No dependencies, application configuration or remote infrastructure were changed by this validation. Financial and provider boundaries remain mocked. The accepted pre-existing recovery restart-harness failure is intentionally excluded, with its implementation unchanged.

The backup's `changes.patch` is relative to the exact P1 baseline. Its `implementation/` directory also carries the surrounding auth tests and modules, plus all historical migrations for standalone review. Do not apply it to a dirty or different source tree, replay the old combined migration, or deploy before the operator reviews P2 and approves the next phase.
