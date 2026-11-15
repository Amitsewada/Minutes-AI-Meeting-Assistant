import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Each run owns fresh test data. It never touches the user's normal database.
const dataDirectory = resolve('.local', 'e2e', randomUUID());
const port = 3101;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
    },
  }],
  webServer: {
    command: `"${process.execPath}" --import tsx server/index.ts`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 45_000,
    env: {
      PORT: String(port),
      CLIENT_PORT: String(port),
      DATA_DIR: dataDirectory,
      AI_PROVIDER: 'demo',
      GROQ_API_KEY: '',
      GROQ_MODEL: '',
      OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      OLLAMA_MODEL: '',
      NODE_ENV: 'test',
    },
  },
});
