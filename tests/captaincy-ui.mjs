import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const baseUrl = process.env.CAPTAINCY_BASE_URL?.replace(/\/$/, '') || 'http://127.0.0.1:3000';
const browserPaths = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const executablePath = browserPaths.find(candidate => existsSync(candidate));
assert.ok(executablePath, 'A Chromium browser is required');

const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const consoleErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`${baseUrl}/captaincy`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#content-captain.active');
    await page.waitForFunction(() => document.querySelectorAll('#captain-picks-body tr').length === 5);
    assert.match(await page.locator('#cap-best-card').innerText(), /BEST CAPTAIN/);
    assert.match(await page.locator('#cap-differential-card').innerText(), /DIFFERENTIAL/);
    assert.match(await page.locator('#cap-best-card').innerText(), /FDR \d/);
    assert.match(await page.locator('#cap-differential-card').innerText(), /xPts/);
    assert.equal(await page.locator('#captain-picks-body tr').count(), 5);

    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(pageOverflow <= 1, `captaincy page overflows by ${pageOverflow}px at ${viewport.width}px`);

    const screenshot = `C:\\Users\\User\\AppData\\Local\\Temp\\opencode\\captaincy-${viewport.width}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(consoleErrors.filter(error => !error.startsWith('Failed to load resource:')), []);
    await page.close();
  }
} finally {
  await browser.close();
}
