// Takes screenshots of the app (with Chromium's built-in FAKE camera/microphone only) and the
// print page. Output goes to screenshots/, which is git-ignored.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { startServer } from '../tests/server.mjs';
import { makeFakeCameraY4M } from '../tests/fake-camera.mjs';
import { rmSync } from 'node:fs';

const cam = makeFakeCameraY4M();

const out = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const { url, close } = await startServer();
const browser = await chromium.launch({
  args: ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cam.file}`, '--autoplay-policy=no-user-gesture-required'],
});
const shots = [
  { name: 'print-full', path: 'print.html', viewport: { width: 1200, height: 900 }, full: true },
  { name: 'print-compact', path: 'print.html?size=compact', viewport: { width: 1200, height: 900 }, full: true },
  { name: 'app-laptop', path: 'index.html?debug=1', viewport: { width: 1280, height: 800 }, start: true },
  { name: 'app-setup', path: 'index.html', viewport: { width: 1280, height: 800 }, start: true, setup: true },
  { name: 'app-phone', path: 'index.html', viewport: { width: 915, height: 412 }, start: true, mobile: true },
  { name: 'app-phone-portrait', path: 'index.html', viewport: { width: 412, height: 915 }, start: true, mobile: true },
];
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: s.viewport, isMobile: !!s.mobile, hasTouch: !!s.mobile, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${s.name}] console error:`, m.text()); });
  await page.goto(url + s.path);
  await page.waitForTimeout(1500);
  if (s.start) {
    const btn = page.locator('#start');
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await page.waitForFunction(() => window.deskPiano.state.markersSeen.size > 0, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (s.setup && !(await page.isVisible('#setupPanel'))) await page.click('#setupBtn');
    if (!s.setup && (await page.isVisible('#setupPanel'))) await page.click('#setupDone');
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${out}${s.name}.png`, fullPage: !!s.full });
  console.log('saved', s.name);
  await ctx.close();
}
await browser.close();
await close();
rmSync(cam.dir, { recursive: true, force: true });
