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

/** A real two-finger pinch through the DevTools protocol (Playwright has no pinch API). */
const cdp = await page.context().newCDPSession(page);
async function pinch(testId, fromGap, toGap, steps = 8) {
  const box = await byId(testId).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const points = (gap) => [
    { x: cx - gap / 2, y: cy, id: 0 },
    { x: cx + gap / 2, y: cy, id: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(fromGap) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(fromGap + ((toGap - fromGap) * i) / steps) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const settle = (ms) => page.waitForTimeout(ms);

await page.goto(base, { waitUntil: 'networkidle' });
await byId('tab-review').waitFor({ timeout: 30_000 });
await settle(2500); // sample previews
await shot('01-review', 'Review: the carousel, first photo');
await byId('review-image').dblclick();
await settle(700);
await shot('01b-review-zoomed', 'Review: double-tapped to zoom (pinch works too; one finger pans while zoomed)');
await byId('review-image').dblclick();
await settle(700);
// Pinch in on the fitted photo: the Jump-to grid opens.
await pinch('review-image', 260, 80);
await settle(900);
if (await byId('review-grid-close').isVisible().catch(() => false)) {
  await shot('01c-review-pinched-to-grid', 'Review: pinched in on the photo, the Jump-to grid opened');
  await byId('review-grid-close').click();
  await settle(500);
} else {
  throw new Error('pinching in on the fitted Review photo did not open the Jump-to grid');
}
await page.getByText('↑ Pick', { exact: true }).click();
await settle(900);
await shot('02-review-after-pick', 'Review: after flicking one up (next photo slid in, Undo enabled)');
await byId('review-grid').click();
await settle(1500);
await shot('02b-review-jump-grid', 'Review: "Jump to" grid of the queue by day (current photo outlined)');
await byId('review-thumb-demo-08').click();
await settle(1200);
await shot('02c-review-after-jump', 'Review: after tapping a photo in the grid (position jumped)');
// Jump to the last photo in the queue and skip it: Review steps back to the one before it
// instead of showing the end page while earlier photos still wait.
await byId('review-grid').click();
await settle(1000);
for (let i = 0; i < 20 && !(await byId('review-thumb-demo-54').isVisible().catch(() => false)); i++) {
  await page.mouse.move(195, 500);
  await page.mouse.wheel(0, 1500);
  await settle(500);
}
await byId('review-thumb-demo-54').click();
await settle(1200);
await page.getByText('↓ Skip', { exact: true }).click();
await settle(1200);
// The end page stays mounted beside the photo in view, so check the Skip button instead:
// it is disabled only when no photo is in view.
const skipButton = page.getByRole('button', { name: '↓ Skip', exact: true });
if ((await skipButton.getAttribute('aria-disabled')) === 'true') {
  throw new Error('skipping the last Review photo showed the end page instead of stepping back');
}
await shot('02d-review-after-skipping-last', 'Review: skipped the last photo, the one before it slid in');

await byId('tab-picks').click();
await settle(1500);
await shot('03-picks', 'Picks: by capture day, one failed upload');
await byId('day-2026-10-30').click();
await settle(400);
await shot('03b-picks-collapsed', 'Picks: a day collapsed');
await byId('day-2026-10-30').click();
await byId('grid-select').click();
await byId('day-select-2026-10-30').click();
await settle(300);
await shot('04-picks-select', 'Picks: selecting a whole day (or single photos) to send or skip');
await byId('grid-select').click(); // Done
await byId('thumb-demo-13').click();
await settle(1200);
await shot('05-picks-detail-failed', 'Picks: detail view of a failed upload');
await byId('detail-close').click();
await byId('picks-send-all').click();
await settle(400);
await shot('06-picks-sending', 'Picks: the instant after Send all (queued at once, progress line)');
await settle(2200);
await shot('06b-picks-uploading', 'Picks: a moment later (uploading, with spinners)');
await settle(4500);
await shot('06c-picks-sent', 'Picks: everything sent (notice stays a few seconds)');
await byId('tab-library').click();
await settle(1500);
await shot('07-library-sent', 'Library → Sent: everything Lightroom has');
await byId('library-skipped').click();
await settle(1500);
await shot('08-library-skipped', 'Library → Skipped');
await byId('grid-collapse-all').click();
await settle(500);
if (!(await page.getByText('Expand all', { exact: true }).isVisible())) throw new Error('Collapse all did not collapse every day');
await shot('08a-library-skipped-collapsed', 'Library → Skipped: Collapse all (just the days and their counts)');
await byId('grid-collapse-all').click(); // Expand all
await settle(500);
await byId('tab-settings').click();
await settle(1200);
await shot('09-settings', 'Settings: camera / receiver settings at the top (sample-photos mode)');
await page.getByText('Picket API', { exact: true }).scrollIntoViewIfNeeded();
await settle(600);
await shot('10-settings-lower', 'Settings, scrolled: Lightroom and the Picket API');

// Expired signed URLs: Skipped starts with dead thumbnail URLs (the app saves none to disk, and the
// ones it has expire within the hour). Each failed thumbnail asks for a fresh URL; all must load.
await page.goto(`${base}?expired-urls`, { waitUntil: 'domcontentloaded' });
await byId('tab-library').waitFor({ timeout: 30_000 });
await byId('tab-library').click();
await byId('library-skipped').click();
await settle(3500);
const thumbs = await page.$$eval('[data-testid^="thumb-"] img', (imgs) =>
  imgs.slice(0, 12).map((i) => ({ src: i.currentSrc || i.src, ok: i.complete && i.naturalWidth > 0 })),
);
if (thumbs.length < 12 || thumbs.some((t) => !t.ok || t.src.includes('picket.invalid'))) {
  throw new Error(`thumbnails with expired URLs were not refreshed: ${JSON.stringify(thumbs)}`);
}
await shot('08b-skipped-urls-refreshed', 'Library → Skipped: thumbnails whose signed URLs had expired, re-signed on demand and loaded');

// An API without the change feed (deployed before it, or rolled back): tabs must still fill by
// full loads. Sample mode answers /photos/changes with a 404 under ?no-feed.
await page.goto(`${base}?no-feed`, { waitUntil: 'domcontentloaded' });
await byId('tab-library').waitFor({ timeout: 30_000 });
await byId('tab-library').click();
await byId('library-skipped').click();
await page.getByText('242 skipped', { exact: true }).waitFor({ timeout: 10_000 });

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(shots, null, 2));
await browser.close();
server.close();
if (pageErrors.length) {
  console.error('Page errors:\n' + pageErrors.join('\n'));
  process.exit(1);
}
