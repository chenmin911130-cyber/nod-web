import { defineConfig, devices } from '@playwright/test'

/**
 * Nod Web E2E.
 *
 * The backend serves the built frontend (web/dist) on :9320, so the E2E
 * harness only needs to boot the API server — no separate dev server. The
 * server must run from the REPO ROOT (it does `from server...` and serves
 * ./web/dist), so cwd is set to `..` (the repo root).
 *
 * Isolation: DATA_DIR points at a throwaway dir so E2E never reads/writes
 * the real data/nod.db, and fake provider keys make the app boot into a
 * usable (non-Keys) state. Mock keys mean STT/LLM won't actually run, which
 * is exactly what the fast smoke suite wants; the real-audio end-to-end path
 * is exercised separately (nightly/release), not here.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // a single app process + SQLite; keep ordering deterministic
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:9320',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Run from the repo root so `server.*` imports resolve and web/dist is served.
    cwd: '..',
    // PYTHON resolves to a real interpreter in both local (.venv) and CI
    // (system python via `pip install`) runs. In CI there is no .venv, so a
    // hard-coded `../.venv/bin/python` would fail to boot the server. When
    // PYTHON is unset (plain `npx playwright test` locally), fall back to the
    // repo-root venv that the README tells you to create.
    command:
      'DATA_DIR=/tmp/nod-e2e-data ASSEMBLYAI_API_KEY=test DEEPSEEK_API_KEY=test ' +
      'QUOTA_DISABLED=1 NOD_SKIP_DOTENV=1 ${PYTHON:-.venv/bin/python} -m uvicorn server.app:app --host 127.0.0.1 --port 9320',
    url: 'http://127.0.0.1:9320/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
