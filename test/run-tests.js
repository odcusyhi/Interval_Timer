#!/usr/bin/env node
/**
 * PushBird test suite.
 *
 * Runs the head tracker against synthetic frames with exact ground truth, then
 * drives the whole app in Chromium with a simulated camera fed from
 * test/pushup.y4m.
 *
 *   python3 test/make-fixture.py     # once, to build the camera fixture
 *   npm install playwright           # browsers are not downloaded, see below
 *   node test/run-tests.js
 *
 * CHROME_PATH may point at an existing Chromium; otherwise Playwright's own
 * download is used.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');
const FIXTURE = path.join(__dirname, 'pushup.y4m');
const PORT = Number(process.env.PORT || 8731);
const BASE = `http://127.0.0.1:${PORT}/`;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  PASS  ' + n))
  : (fail++, console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : ''))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error('Missing camera fixture. Run:  python3 test/make-fixture.py');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();

  const launch = { args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${FIXTURE}`,
    '--autoplay-policy=no-user-gesture-required',
  ] };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;

  const browser = await chromium.launch(launch);

  /* ---------------------------------------------------- tracker unit tests */
  console.log('\n== head tracker (synthetic frames, exact ground truth) ==');
  {
    const p = await browser.newPage();
    p.on('pageerror', e => console.log('PAGEERROR', String(e)));
    await p.goto(BASE + 'test/tracker.test.html');
    await p.waitForFunction(() => window.__results, null, { timeout: 180000 });
    const r = await p.evaluate(() => window.__results);

    // The same push-up sweep is run against very light, medium and very dark
    // subjects. A skin-tone-threshold tracker would score wildly differently
    // across these; equivalent correlation is the point of the assertion.
    for (const tone of ['light', 'medium', 'dark']) {
      ok(`tracks a ${tone} subject through a push-up`, r[tone].corr > 0.9, r[tone]);
      ok(`${tone} subject yields a usable range`, r[tone].range > 0.15, r[tone]);
    }
    const corrs = ['light', 'medium', 'dark'].map(t => r[t].corr);
    ok('tracking quality does not depend on skin tone',
      Math.max(...corrs) - Math.min(...corrs) < 0.12, corrs);

    ok('a still subject does not drift', r.staticDrift < 0.05, r.staticDrift);
    ok('an empty frame collapses confidence', r.emptyConfidence < 0.1, r.emptyConfidence);
    ok('two-pose calibration produces a usable span', r.calReady && r.calSpan > 0.2, r);
    ok('calibrated reps are counted', r.reps >= 5 && r.reps <= 7, r.reps);
    ok('mapped position reaches both extremes', r.mappedMin < 0.1 && r.mappedMax > 0.9, r);
    ok('threshold jitter does not inflate the rep count', r.jitterReps === 0, r.jitterReps);
    await p.close();
  }

  /* -------------------------------------------------------------- app e2e */
  console.log('\n== app (simulated camera) ==');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE);
  await page.waitForSelector('#home.active');

  console.log('\n-- home --');
  ok('home shows zero best', await page.textContent('#homeBest') === '0');
  ok('free runs shown', await page.textContent('#homeRuns') === '3');

  console.log('\n-- overlay visibility --');
  ok('HUD is not painted over the menu', !(await page.isVisible('#hud')));
  ok('REC dot is not painted over the menu', !(await page.isVisible('#recDot')));

  console.log('\n-- camera + tracking --');
  // Pre-set calibration: the fake camera loops continuously so a live two-pose
  // capture would sample a moving subject. Calibration UI is covered separately.
  await page.evaluate(() => {
    localStorage.setItem('pb_cal', JSON.stringify({ top: 0.30, bottom: 0.70 }));
    location.reload();
  });
  await page.waitForSelector('#home.active');
  await page.click('#btnPlay');
  await sleep(2500);

  const mode = await page.evaluate(() => window.__pb.mode);
  ok('camera mode engaged', mode === 'camera', mode);
  ok('HUD is visible during a run', await page.isVisible('#hud'));
  ok('menus are gone during a run', !(await page.isVisible('#home')));

  const track = await page.evaluate(async () => {
    const t = window.__pb.tracker;
    const samples = [];
    for (let i = 0; i < 90; i++) {
      samples.push(t.y);
      await new Promise(r => requestAnimationFrame(r));
    }
    return { min: Math.min(...samples), max: Math.max(...samples), conf: t.confidence };
  });
  ok('tracker follows the moving subject', track.max - track.min > 0.10, track);
  ok('tracker is confident on real footage', track.conf > 0.3, track.conf);

  const playing = await page.evaluate(() => window.__pb.game.state);
  ok('run auto-starts from a rep', playing === 'playing' || playing === 'dead', playing);

  console.log('\n-- canvas actually renders the camera --');
  const pix = await page.evaluate(() => {
    const c = document.getElementById('stage');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0, distinct = new Set();
    for (let i = 0; i < d.length; i += 4000) {
      if (d[i] + d[i+1] + d[i+2] > 30) nonBlack++;
      distinct.add(`${d[i]>>4},${d[i+1]>>4},${d[i+2]>>4}`);
    }
    return { nonBlack, distinct: distinct.size };
  });
  ok('canvas is not blank', pix.nonBlack > 50, pix);
  ok('canvas has real image variety (camera + pipes)', pix.distinct > 12, pix);

  console.log('\n-- reps --');
  // Calibrate from what the tracker actually reports, the way the app's own
  // two-pose capture does, rather than from invented numbers. The tracker's
  // peak sits on the facial-feature band, a little above the geometric centre
  // of the head, so absolute values are meaningless -- only the mapped range is.
  const repData = await page.evaluate(async () => {
    const { HeadTracker, Calibration, RepCounter } = window.__pbMod;
    const v = document.getElementById('cam');
    const t = new HeadTracker();

    const sampleFor = async ms => {
      const out = [];
      const until = performance.now() + ms;
      while (performance.now() < until) {
        t.update(v);
        out.push(t.y);
        await new Promise(r => requestAnimationFrame(r));
      }
      return out;
    };

    const observed = await sampleFor(5000);           // ~2.5 push-up cycles
    const cal = new Calibration({ top: Math.min(...observed), bottom: Math.max(...observed) });
    const rc = new RepCounter();
    const mapped = [];
    const until = performance.now() + 9000;
    while (performance.now() < until) {
      t.update(v);
      const m = cal.map(t.y);
      mapped.push(m);
      rc.update(m);
      await new Promise(r => requestAnimationFrame(r));
    }
    return {
      calSpan: Math.abs(cal.bottom - cal.top),
      mapMin: Math.min(...mapped), mapMax: Math.max(...mapped),
      reps: rc.reps,
    };
  });
  ok('calibration derived from live footage has usable span', repData.calSpan > 0.08, repData);
  ok('mapped position spans the playfield',
    repData.mapMin < 0.15 && repData.mapMax > 0.85, repData);
  ok('push-up reps are counted from the footage', repData.reps >= 2, repData);

  // Adaptive widening: a range calibrated too narrow must open up, never shut down.
  const adapt = await page.evaluate(() => {
    const { Calibration } = window.__pbMod;
    const c = new Calibration({ top: 0.45, bottom: 0.55 });
    const before = c.bottom - c.top;
    for (let i = 0; i < 60; i++) { c.observe(0.20); c.observe(0.80); }
    const after = c.bottom - c.top;
    const c2 = new Calibration({ top: 0.20, bottom: 0.80 });
    for (let i = 0; i < 60; i++) { c2.observe(0.5); }   // inside range: must not shrink
    return { before, after, unshrunk: c2.bottom - c2.top };
  });
  ok('a too-narrow calibration widens toward the real range', adapt.after > adapt.before * 2, adapt);
  ok('readings inside the range never narrow it', Math.abs(adapt.unshrunk - 0.6) < 1e-9, adapt);

  console.log('\n-- game over + clip --');
  await page.evaluate(() => window.__pb.game.die());
  await page.waitForSelector('#over.active', { timeout: 15000 });
  ok('game over panel appears', await page.isVisible('#over.active'));
  const clip = await page.evaluate(() => ({
    shareVisible: !document.getElementById('btnShare').hidden,
    note: document.getElementById('shareNote').textContent,
  }));
  ok('a shareable clip was recorded', clip.shareVisible, clip);
  ok('clip size is reported', /MB clip/.test(clip.note), clip.note);

  console.log('\n-- free-run limit --');
  const gate = await page.evaluate(() => {
    const S = window.__pb.Store;
    localStorage.removeItem('pb_entitlement');
    localStorage.setItem('pb_runs', JSON.stringify({ day: Math.floor(Date.now() / 86400000), count: 3 }));
    return { left: S.runsLeftToday(), can: S.canPlay() };
  });
  ok('free runs exhaust after 3', gate.left === 0 && gate.can === false, gate);
  await page.click('#btnAgain');
  await page.waitForSelector('#paywall.active', { timeout: 5000 });
  ok('paywall gates the 4th run', await page.isVisible('#paywall.active'));
  ok('paywall states nothing is charged',
    /nothing is charged/i.test(await page.textContent('#payDisclaimer')));

  console.log('\n-- pricing matches the brief --');
  const plans = await page.evaluate(() =>
    [...document.querySelectorAll('.plan')].map(p => p.textContent.replace(/\s+/g, ' ').trim()));
  ok('weekly is $4.99', plans.some(p => p.includes('$4.99') && /week/i.test(p)), plans);
  ok('yearly is $39.99', plans.some(p => p.includes('$39.99') && /year/i.test(p)), plans);

  console.log('\n-- referral --');
  const myCode = await page.textContent('#myCode');
  ok('a 6-char referral code is generated', /^[A-HJ-NP-Z2-9]{6}$/.test(myCode), myCode);

  await page.fill('#refInput', myCode);
  await page.click('#btnRedeem');
  ok('self-referral rejected', /your own code/i.test(await page.textContent('#refMsg')));

  await page.fill('#refInput', 'AB1');
  await page.click('#btnRedeem');
  ok('short code rejected', /6 characters/i.test(await page.textContent('#refMsg')));

  await page.fill('#refInput', 'XKCD99');
  await page.click('#btnRedeem');
  await sleep(300);
  const afterRedeem = await page.evaluate(() => ({
    sub: window.__pb.Store.isSubscribed(),
    left: window.__pb.Store.runsLeftToday(),
  }));
  ok('valid referral grants a free month', afterRedeem.sub === true, afterRedeem);
  ok('pro removes the daily cap', afterRedeem.left === Infinity, afterRedeem.left);

  await page.fill('#refInput', 'QQQQ22');
  await page.click('#btnRedeem');
  ok('second referral rejected', /already used/i.test(await page.textContent('#refMsg')));

  console.log('\n-- leaderboard --');
  await page.evaluate(() => { localStorage.setItem('pb_best', JSON.stringify({ score: 40, reps: 12 })); });
  await page.click('#btnPayBack');
  await page.click('#btnLeaderboard');
  await page.waitForSelector('#board.active');
  const board = await page.evaluate(() => ({
    rows: document.querySelectorAll('#boardList li').length,
    me: document.querySelectorAll('#boardList li.me').length,
    firstRank: document.querySelector('#boardList .rank')?.textContent,
    src: document.getElementById('boardSource').textContent,
  }));
  ok('leaderboard lists entries', board.rows >= 6, board);
  ok('your row is marked', board.me === 1, board);
  ok('a score of 40 ranks first', board.firstRank === '1' && board.rows >= 6, board);
  ok('local board is labelled honestly', /this device only/i.test(board.src), board.src);

  await page.fill('#nameInput', '<img src=x onerror=alert(1)>');
  await page.click('#btnBoardBack');
  await page.click('#btnLeaderboard');
  await sleep(300);
  const html = await page.innerHTML('#boardList');
  ok('leaderboard names are escaped', !html.includes('<img'), html.slice(0, 120));

  console.log('\n-- tap mode without camera --');
  const tap = await page.evaluate(async () => {
    window.__pb.beginRun('tap');
    const g = window.__pb.game;
    g.flap();
    const v0 = g.birdV;
    for (let i = 0; i < 30; i++) await new Promise(r => requestAnimationFrame(r));
    return { v0, state: g.state, moved: g.birdY !== 0.5 };
  });
  ok('tap mode applies a flap impulse', tap.v0 < 0, tap);
  ok('tap mode runs', tap.state === 'playing' || tap.state === 'dead', tap);

  console.log('\n-- collision + scoring --');
  const phys = await page.evaluate(() => {
    const { Game } = window.__pbMod;
    const c = document.createElement('canvas'); c.width = 400; c.height = 800;
    let scored = 0, over = null;
    const g = new Game(c, { onScore: () => scored++, onGameOver: r => over = r });
    g.reset('normal'); g.start();
    // Straight through the middle of a wide-open gap: must score, not die.
    g.pipes = [{ x: 0.6, gapY: 0.5, gap: 0.9, passed: false }];
    g.birdY = 0.5; g.setTarget(0.5);
    for (let i = 0; i < 120; i++) g.update(1 / 60, 'camera');
    const clean = { scored, state: g.state };

    // Dead centre of a solid pipe: must die.
    const g2 = new Game(c, {});
    g2.reset('normal'); g2.start();
    g2.pipes = [{ x: 0.30, gapY: 0.05, gap: 0.02, passed: false }];
    g2.birdY = 0.8; g2.setTarget(0.8);
    g2.update(1 / 60, 'camera');
    return { clean, crashed: g2.state };
  });
  ok('passing a gap scores exactly once', phys.clean.scored === 1, phys.clean);
  ok('passing a gap does not kill', phys.clean.state === 'playing', phys.clean);
  ok('flying into a pipe kills', phys.crashed === 'dead', phys.crashed);

  const bounds = await page.evaluate(() => {
    const { Game } = window.__pbMod;
    const mk = () => { const c = document.createElement('canvas'); c.width = 400; c.height = 800; return c; };

    // Tap mode: gravity carries the bird off the field, which must kill.
    const g = new Game(mk(), {}); g.reset('normal'); g.start(); g.pipes = [];
    for (let i = 0; i < 300 && g.state === 'playing'; i++) g.update(1 / 60, 'tap');
    const tapFell = g.state;

    // Camera mode: position is clamped to the calibrated range, so the player
    // cannot leave the field at all. Killing them for reaching the edge of
    // their own range would be unfair. Pipe spawning is suppressed here to
    // isolate the boundary rule from the pipe rule.
    const g2 = new Game(mk(), {}); g2.reset('normal'); g2.start();
    g2.pipes = []; g2.nextPipeAt = 1e9;
    g2.setTarget(1.4);
    for (let i = 0; i < 300; i++) { g2.nextPipeAt = 1e9; g2.update(1 / 60, 'camera'); }

    // But the edge is not a safe lane: pipes span to both edges, so sitting at
    // the bottom with pipes spawning normally still ends the run.
    const g3 = new Game(mk(), {}); g3.reset('normal'); g3.start();
    g3.setTarget(1.0);
    for (let i = 0; i < 900 && g3.state === 'playing'; i++) g3.update(1 / 60, 'camera');

    return { tapFell, cameraState: g2.state, cameraY: g2.birdY, edgeCamped: g3.state };
  });
  ok('falling off the field kills in tap mode', bounds.tapFell === 'dead', bounds);
  ok('camera mode clamps to the field instead of killing',
    bounds.cameraState === 'playing' && bounds.cameraY <= 1.0001, bounds);
  ok('camping the edge is still punished by pipes', bounds.edgeCamped === 'dead', bounds);

  console.log('\n-- large-dt guard --');
  const dtGuard = await page.evaluate(() => {
    const { Game } = window.__pbMod;
    const c = document.createElement('canvas'); c.width = 400; c.height = 800;
    const g = new Game(c, {}); g.reset('normal'); g.start();
    const before = g.pipes.length;
    g.update(30, 'tap');           // simulate a 30-second stall
    return { before, after: g.pipes.length, t: g.t };
  });
  ok('a stalled frame cannot spawn a wall of pipes', dtGuard.after - dtGuard.before <= 1, dtGuard);

  console.log('\n-- screenshots --');
  await page.evaluate(() => { localStorage.clear(); location.reload(); });
  await page.waitForSelector('#home.active');
  await page.screenshot({ path: SHOTS + '/pb-home.png' });
  await page.evaluate(() => window.__pb.show('calibrate'));
  await sleep(400);
  await page.screenshot({ path: SHOTS + '/pb-cal.png' });
  await page.evaluate(() => {
    localStorage.setItem('pb_cal', JSON.stringify({ top: 0.30, bottom: 0.70 }));
    location.reload();
  });
  await page.waitForSelector('#home.active');
  await page.click('#btnPlay');
  await sleep(3000);
  await page.screenshot({ path: SHOTS + '/pb-game.png' });
  await page.evaluate(() => window.__pb.game.die());
  await page.waitForSelector('#over.active');
  await page.screenshot({ path: SHOTS + '/pb-over.png' });
  await page.evaluate(() => window.__pb.show('paywall'));
  await page.evaluate(() => document.getElementById('btnGoPro').click());
  await sleep(400);
  await page.screenshot({ path: SHOTS + '/pb-pay.png' });

  console.log('\n-- errors --');
  ok('no uncaught errors', errors.length === 0, errors.slice(0, 4));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
