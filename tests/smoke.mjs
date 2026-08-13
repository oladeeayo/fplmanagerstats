import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const port = 3100;
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Production server did not start');
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

    const localFailures = failedResponses.filter((entry) => entry.includes(baseUrl));
    assert.deepEqual(localFailures, [], `Failed application requests at ${viewport.width}px:\n${localFailures.join('\n')}`);
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
  server.kill();
}
