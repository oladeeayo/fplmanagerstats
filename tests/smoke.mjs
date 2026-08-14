import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const port = 32000 + Math.floor(Math.random() * 10000);
const baseUrl = process.env.SMOKE_BASE_URL?.replace(/\/$/, '') ?? `http://127.0.0.1:${port}`;
const server = process.env.SMOKE_BASE_URL ? null : spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverError = '';
server?.stderr.on('data', (chunk) => { serverError += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Production server did not start${serverError ? `:\n${serverError}` : ''}`);
}

try {
  await waitForServer();
  const browserPaths = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const executablePath = browserPaths.find((candidate) => existsSync(candidate));
  assert.ok(executablePath, 'Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to run browser smoke tests');
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  const slowContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await slowContext.addInitScript(() => localStorage.setItem('fplManagerId', '1'));
  const slowPage = await slowContext.newPage();
  await slowPage.route('**/api/bootstrap-static', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await route.abort();
  });
  await slowPage.route('**/api/analyze-manager/*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.fulfill({ json: { managerInfo: { name: 'Test Manager' }, playerStats: [], currentTeam: [] } });
  });
  const shellStartedAt = Date.now();
  await slowPage.goto(`${baseUrl}/players`, { waitUntil: 'domcontentloaded' });
  await slowPage.waitForSelector('#content-players.active');
  await slowPage.waitForSelector('#loading-overlay', { state: 'hidden' });
  assert.ok(Date.now() - shellStartedAt < 8000, 'Application shell was blocked by initial data requests');
  await slowPage.locator('#mobile-menu-btn').click();
  await slowPage.waitForSelector('#sidebar.mobile-open');
  await slowContext.close();

  const routes = ['/', '/manager', '/league', '/players', '/tactics', '/fixtures', '/captaincy', '/ownership', '/set-pieces'];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const consoleErrors = [];
    const failedResponses = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
    });

    for (const route of routes) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.layout');
      const expectedTab = route === '/' ? 'general' : route === '/tactics' ? 'zones' : route === '/captaincy' ? 'captain' : route === '/set-pieces' ? 'setpieces' : route.slice(1);
      await page.waitForSelector(`#content-${expectedTab}.active`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${route} overflows viewport by ${overflow}px at ${viewport.width}px`);
    }

    if (viewport.width < 1024) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForSelector('#loading-overlay', { state: 'hidden', timeout: 30000 });
      } catch (error) {
        const startupState = await page.evaluate(() => ({
          classes: document.querySelector('#loading-overlay')?.className,
          timer: document.querySelector('#main-overlay-timer')?.textContent,
          error: document.querySelector('#error-toast')?.textContent,
          hasBootstrap: Boolean(window.FPL?.state.bootstrapData),
          apiFetchHasTimeout: window.FPL?.apiFetch?.toString().includes('AbortController'),
          controlledByServiceWorker: Boolean(navigator.serviceWorker?.controller),
        }));
        throw new Error(`Startup remained blocked: ${JSON.stringify(startupState)}`, { cause: error });
      }
      await page.locator('#mobile-menu-btn').click();
      await page.waitForSelector('#sidebar.mobile-open');
      await page.locator('#sidebar [data-tab="players"]').click();
      await page.waitForURL('**/players');
      await page.waitForSelector('#content-players.active');
    }

    const appFailures = failedResponses.filter((entry) => entry.includes(baseUrl));
    assert.deepEqual(appFailures, [], `Failed application requests at ${viewport.width}px:\n${appFailures.join('\n')}`);
    const actionableConsoleErrors = consoleErrors.filter((entry) => !entry.startsWith('Failed to load resource:'));
    assert.deepEqual(actionableConsoleErrors, [], `Browser console errors at ${viewport.width}px:\n${actionableConsoleErrors.join('\n')}\nFailed responses:\n${failedResponses.join('\n')}`);
    await page.close();
  }

  const redirectPage = await browser.newPage();
  await redirectPage.goto(`${baseUrl}/?tab=fixtures`);
  await redirectPage.waitForURL('**/fixtures');
  await redirectPage.goto(`${baseUrl}/not-a-route`);
  await redirectPage.waitForURL(`${baseUrl}/`);
  await redirectPage.close();
  await browser.close();
} finally {
  server?.kill();
}
