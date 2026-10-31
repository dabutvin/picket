// Drives the web export of the app in headless Chromium at phone size and screenshots every
// screen, running against the built-in sample photos (EXPO_PUBLIC_PICKET_DEMO=1 at export time).
// The ui-preview workflow posts the result on each pull request; run it locally with
//   EXPO_PUBLIC_PICKET_DEMO=1 npx expo export --platform web --output-dir dist
//   node scripts/ui-screenshots.mjs dist screenshots
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

// CommonJS resolution, so a globally installed Playwright (NODE_PATH) works as well as a local one.
const { chromium } = createRequire(import.meta.url)('playwright');

const [distDir = 'dist', outDir = 'screenshots'] = process.argv.slice(2);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json' };

// Tiny static server with a single-page fallback, so no extra dependency is needed.
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = path.join(distDir, pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html');
  res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

fs.mkdirSync(outDir, { recursive: true });
// PLAYWRIGHT_CHROMIUM_PATH points at a preinstalled browser when Playwright's own download is absent.
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.warn('console.error:', m.text().slice(0, 300));
});

const shots = [];
const shot = async (name, caption) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  shots.push({ file: `${name}.png`, caption });
  console.log('shot', name);
};
const byId = (id) => page.getByTestId(id);
const settle = (ms) => page.waitForTimeout(ms);

await page.goto(base, { waitUntil: 'networkidle' });
await byId('tab-review').waitFor({ timeout: 30_000 });
await settle(2500); // sample previews
await shot('01-review', 'Review: the carousel, first photo');
await page.getByText('↑ Pick', { exact: true }).click();
await settle(900);
await shot('02-review-after-pick', 'Review: after flicking one up (next photo slid in, Undo enabled)');

await byId('tab-picks').click();
await settle(1500);
await shot('03-picks', 'Picks: waiting to be sent, one failed upload');
await byId('grid-select').click();
await byId('thumb-demo-11').click();
await byId('thumb-demo-12').click();
await settle(300);
await shot('04-picks-select', 'Picks: selecting a few to send or skip');
await byId('grid-select').click(); // Done
await byId('thumb-demo-13').click();
await settle(1200);
await shot('05-picks-detail-failed', 'Picks: detail view of a failed upload');
await byId('detail-close').click();
await byId('picks-send-all').click();
await settle(700);
await shot('06-picks-sending', 'Picks: right after Send all (queued, then sending)');
await settle(4500);
await byId('tab-sent').click();
await settle(1500);
await shot('07-sent', 'Sent: everything Lightroom has');
await byId('tab-skipped').click();
await settle(1500);
await shot('08-skipped', 'Skipped');
await byId('tab-camera').click();
await settle(800);
await shot('09-camera', 'Camera: receiver settings');
await byId('tab-settings').click();
await settle(800);
await shot('10-settings', 'Settings (sample-photos mode)');

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(shots, null, 2));
await browser.close();
server.close();
if (pageErrors.length) {
  console.error('Page errors:\n' + pageErrors.join('\n'));
  process.exit(1);
}
