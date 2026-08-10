/**
 * Regenerates public/og-home.png — the default Open Graph / link-preview card.
 *
 * It's a real screenshot of the live home page at 1200x630 (rendered at 2x for
 * retina), so the share card always looks like the site actually looks. Because
 * it's a snapshot, the numbers baked into it (place count, "this week's pick")
 * drift over time — rerun this whenever the home page changes noticeably:
 *
 *   npm run og:generate
 *   npm run og:generate -- --url http://localhost:4321   (against a local dev server)
 *
 * Uses headless Edge/Chrome rather than a rendering dependency, so there's
 * nothing to install. Commit the regenerated PNG; it's served statically.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'og-home.png');

// OG wants 1200x630 (1.91:1). Captured at 2x so it stays sharp on retina.
const WIDTH = 1200;
const HEIGHT = 630;
const SCALE = 2;

const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const url = urlFlag >= 0 ? args[urlFlag + 1] : 'https://lucaseatsbig.com/';

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const browser = process.env.CHROME_PATH ?? CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('No Chrome/Edge found. Set CHROME_PATH to a Chromium binary and retry.');
  process.exit(1);
}

// Throwaway profile: a headless run against the user's real profile can fail
// if a normal browser window is already open.
const profile = mkdtempSync(join(tmpdir(), 'og-shot-'));

console.log(`Capturing ${url} -> public/og-home.png`);
const result = spawnSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    // Give fonts, the hero photo, and the D1-backed render time to settle.
    '--virtual-time-budget=15000',
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${OUT}`,
    url,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);

rmSync(profile, { recursive: true, force: true });

if (!existsSync(OUT)) {
  console.error('Screenshot failed.');
  console.error(result.stderr?.toString() ?? '');
  process.exit(1);
}
console.log(`Wrote ${OUT} (${WIDTH * SCALE}x${HEIGHT * SCALE})`);
