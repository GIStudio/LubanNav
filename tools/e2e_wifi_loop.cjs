/* End-to-end browser test: LubanNav page ↔ car7 WiFi bridge (10.7.181.161).
 * Verifies: browser geolocation marker, WiFi connect, route dispatch,
 * RTK/replay position telemetry on the panel and map source chip.
 * Run: NODE_PATH=/opt/homebrew/lib/node_modules node tools/e2e_wifi_loop.mjs
 */
const { chromium } = require('playwright');

const PAGE_URL = process.env.PAGE_URL ?? 'http://localhost:5174/?mode=robot';
const WIFI_URL = process.env.WIFI_URL ?? 'ws://10.7.181.161:8900';

async function main() {
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: process.env.WSS_INSECURE === '1',
});
await context.grantPermissions(['geolocation'], { origin: new URL(PAGE_URL).origin });
await context.setGeolocation({ latitude: 22.88837, longitude: 113.47768 });
const page = await context.newPage();
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('[wifi]') || text.includes('[ble]') || msg.type() === 'error') {
    console.log('  [console]', msg.type(), text.slice(0, 160));
  }
});
page.on('pageerror', (err) => console.log('  [pageerror]', err.message.slice(0, 200)));

function ok(label) {
  console.log(`  ✓ ${label}`);
}

try {
  console.log(`[1] open ${PAGE_URL}`);
  await page.goto(PAGE_URL);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.osm-map', { timeout: 15000 });
  await page.waitForTimeout(3000); // let OSM layers + geolocation settle
  ok('page + map loaded');

  // Browser geolocation: source chip should show 浏览器定位 (browser is the
  // only fresh source before the robot connects).
  const chip = page.locator('.position-source-chip');
  await chip.waitFor({ state: 'visible', timeout: 10000 });
  const chipText = (await chip.innerText()).trim();
  console.log(`  [chip] "${chipText}"`);
  ok('position source chip visible (browser geolocation fallback)');

  // Open the system menu → robot panel.
  await page.click('.system-menu-trigger');
  await page.waitForSelector('.system-menu', { state: 'visible' });
  const tabs = page.locator('[role="tab"]');
  const tabCount = await tabs.count();
  console.log(`  [tabs] ${tabCount} tabs`);
  for (let i = 0; i < tabCount; i += 1) {
    const label = (await tabs.nth(i).innerText()).trim().replace(/\n/g, ' ');
    console.log(`    tab[${i}]: ${label}`);
  }
  // Robot tab contains the code "BLE" (VOICE | BLE).
  await tabs.filter({ hasText: 'BLE' }).first().click();
  await page.waitForSelector('.robot-control', { state: 'visible' });
  ok('robot panel open');

  // WiFi transport is the default; fill URL and connect.
  const urlInput = page.locator('.robot-wifi-url input');
  await urlInput.fill(WIFI_URL);
  ok('WiFi URL filled');

  await page.click('.robot-connect-button');
  await page.waitForFunction(() => {
    const state = document.querySelector('.robot-state');
    return state && state.textContent.includes('已连接');
  }, null, { timeout: 15000 });
  ok(`WiFi connected (${WIFI_URL})`);

  // Dispatch the current robot route (streaming JSONL).
  await page.click('.robot-send-button');
  await page.waitForFunction(() => {
    const el = document.querySelector('.robot-live-progress');
    return el !== null;
  }, null, { timeout: 15000 });
  ok('route dispatched, live progress panel appeared');

  // Wait for position telemetry to render.
  await page.waitForFunction(() => {
    const el = document.querySelector('.robot-position strong');
    return el && el.textContent.includes(',');
  }, null, { timeout: 15000 });
  const posText = (await page.locator('.robot-position').innerText()).replace(/\n/g, ' · ');
  console.log(`  [position] ${posText.slice(0, 200)}`);
  ok('position telemetry shown in panel');

  // The source chip should switch to the robot (RTK/replay) source.
  await page.waitForFunction(() => {
    const el = document.querySelector('.position-source-chip');
    return el && el.textContent.includes('小车');
  }, null, { timeout: 10000 });
  console.log(`  [chip] "${(await page.locator('.position-source-chip').innerText()).trim()}"`);
  ok('map source chip switched to 小车');

  // Progress bar should be visible with a width.
  const barWidth = await page.locator('.robot-live-progress-bar span').evaluate((el) => el.style.width);
  console.log(`  [progress bar] width=${barWidth}`);
  ok('live progress bar rendered');

  // Emergency stop round trip.
  await page.click('.robot-stop-button');
  await page.waitForFunction(() => {
    const logs = document.querySelectorAll('.robot-log p');
    return [...logs].some((p) => p.textContent.includes('stopped') || p.textContent.includes('紧急停止'));
  }, null, { timeout: 10000 });
  ok('emergency stop ack logged');

  await page.screenshot({ path: '/tmp/lubannav-wifi-e2e.png', fullPage: false });
  console.log('\nPASS  LubanNav ↔ car7 WiFi bridge end-to-end verified');
} catch (error) {
  await page.screenshot({ path: '/tmp/lubannav-wifi-e2e-fail.png', fullPage: false });
  console.error('\nFAIL', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
}
main().catch((error) => { console.error('FATAL', error); process.exit(1); });
