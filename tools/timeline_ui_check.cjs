/* 时间轴选段 UI 冒烟检查：加载轨迹 → 拖动时间轴滑块 → 自动选段 → 保存/加载/删除已保存段。
 * Run: NODE_PATH=/opt/homebrew/lib/node_modules node tools/timeline_ui_check.cjs
 */
const { chromium } = require('playwright');

const PAGE_URL = process.env.PAGE_URL ?? 'http://10.7.181.161:8901/';

async function main() {
  const browser = await chromium.launch({ args: ['--proxy-server=direct://'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message.slice(0, 200)));
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console]', msg.text().slice(0, 160)); });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#traj-load', { timeout: 10000 });
  await page.click('#traj-load');
  await page.waitForFunction(() => {
    const el = document.getElementById('tl-count');
    return el && el.textContent.includes('选段');
  }, { timeout: 10000 });

  const full = await page.evaluate(() => document.getElementById('tl-count').textContent);
  console.log('✓ 加载后时间轴:', full.slice(0, 120));

  // 拖动起点滑块到 30%，终点到 70%
  await page.evaluate(() => {
    const s = document.getElementById('tl-start');
    const e = document.getElementById('tl-end');
    const max = parseInt(e.max, 10);
    s.value = Math.floor(max * 0.3);
    e.value = Math.ceil(max * 0.7);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const segInfo = await page.evaluate(() => document.getElementById('tl-count').textContent);
  console.log('✓ 拖动滑块后:', segInfo.slice(-60));

  // 自动选段
  await page.click('#traj-auto');
  await page.waitForTimeout(300);
  const autoInfo = await page.evaluate(() => document.getElementById('traj-info').textContent);
  console.log('✓ 自动选段:', autoInfo.slice(0, 100));

  // 保存选段
  await page.fill('#traj-save-name', 'ui-smoke');
  await page.click('#traj-save');
  await page.waitForFunction(() => document.getElementById('traj-info').textContent.includes('已保存'), { timeout: 8000 });
  console.log('✓ 保存:', (await page.evaluate(() => document.getElementById('traj-info').textContent)).slice(0, 80));

  // 已保存列表应有 ui-smoke
  const options = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#traj-saved option')).map((o) => o.textContent));
  console.log('✓ 已保存列表:', JSON.stringify(options));

  // 加载已保存段
  await page.selectOption('#traj-saved', { label: options.find((t) => t.includes('ui-smoke')) });
  await page.click('#traj-load-saved');
  await page.waitForFunction(() => document.getElementById('traj-info').textContent.includes('已加载'), { timeout: 8000 });
  console.log('✓ 加载已保存:', (await page.evaluate(() => document.getElementById('traj-info').textContent)).slice(0, 80));

  // 删除
  await page.once('dialog', (d) => d.accept());
  await page.click('#traj-del-saved');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.getElementById('traj-info').textContent);
  console.log('✓ 删除:', after.slice(0, 60));

  await page.screenshot({ path: 'artifacts/timeline_ui.png', fullPage: false });
  console.log('✓ 截图: artifacts/timeline_ui.png');
  await browser.close();
  console.log('ALL-OK');
}

main().catch((err) => { console.error('FAIL', err.message.split('\n')[0]); process.exit(1); });
