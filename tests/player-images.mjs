import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const port = 43000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverError = '';
server.stderr.on('data', chunk => { serverError += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start: ${serverError}`);
}

const browserPaths = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const executablePath = browserPaths.find(candidate => existsSync(candidate));
assert.ok(executablePath, 'A Chromium browser is required');

try {
  await waitForServer();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const failedPlayerImages = [];
    page.on('response', response => {
      if (response.request().resourceType() === 'image' && response.url().includes('/playerimages/') && response.status() >= 400) {
        failedPlayerImages.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(`${baseUrl}/players`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#content-players.active');
    await page.waitForFunction(() => document.querySelectorAll('#players-table-body tr').length > 5);
    const playerPhotoState = await page.evaluate(() => ({
      images: document.querySelectorAll('#players-table-body img[src*="/playerimages/"]').length,
      fallbacks: document.querySelectorAll('#players-table-body [data-player-fallback]').length,
      footballFallbacks: document.querySelectorAll('img[src*="football.ico"]').length,
      mappedPlayers: Object.keys(window.FPL.state.fotmobPlayerIds).length,
    }));
    assert.ok(playerPhotoState.images > 0, 'FotMob player photos should render');
    assert.ok(playerPhotoState.mappedPlayers > 300, 'Reep FotMob mappings should load');
    assert.ok(playerPhotoState.fallbacks > 0, 'every player photo should have a current-team fallback');
    assert.equal(playerPhotoState.footballFallbacks, 0, 'football icon must not be used as a player image');

    await page.goto(`${baseUrl}/captaincy`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#captain-picks-body tr').length === 5);
    const captainPhotoState = await page.evaluate(() => ({
      cards: document.querySelectorAll('#content-captain [data-player-fallback]').length,
      visibleFallbacks: [...document.querySelectorAll('#content-captain [data-player-fallback]')].filter(element => getComputedStyle(element).display !== 'none').length,
      fotmobPhotos: document.querySelectorAll('#content-captain img[src*="/playerimages/"]').length,
    }));
    assert.ok(captainPhotoState.cards >= 7, 'captain cards and rows should all have fallbacks');
    assert.ok(captainPhotoState.fotmobPhotos > 0, 'captain picks should use FotMob photos');
    assert.deepEqual(failedPlayerImages, []);
    await page.close();
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
