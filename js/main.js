// Wiring: camera, tracker, game loop, screens.

import { HeadTracker, Calibration, RepCounter } from './tracker.js';
import { Game, DIFFICULTY } from './game.js';
import { ClipRecorder, shareClip, isSupported as canRecord } from './recorder.js';
import * as Store from './store.js';

const $ = id => document.getElementById(id);

const canvas = $('stage');
const video = $('cam');
const tracker = new HeadTracker();
const repCounter = new RepCounter();
let calibration = new Calibration(Store.loadCalibration());
let settings = Store.loadSettings();

const game = new Game(canvas, {
  onScore: () => sfx(880, 0.07, 0.18),
  onGameOver: handleGameOver,
});

let recorder = null;
let stream = null;
let mode = 'tap';           // resolved control mode for the current run
let rafId = null;
let lastFrame = 0;
let lastClip = null;
let cameraError = null;

/* ───────────────────────────────── audio ──────────────────────────────── */

let actx = null;
function sfx(freq, dur, vol = 0.2, type = 'square') {
  if (!settings.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime;
    const osc = actx.createOscillator();
    const g = actx.createGain();
    osc.connect(g); g.connect(actx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t); osc.stop(t + dur + 0.02);
  } catch {}
}
const sfxCrash = () => { sfx(180, 0.22, 0.3, 'sawtooth'); setTimeout(() => sfx(90, 0.3, 0.25, 'sawtooth'), 90); };
const sfxRep = () => sfx(520, 0.06, 0.12, 'sine');

/* ───────────────────────────────── screens ────────────────────────────── */

const PANELS = ['home', 'calibrate', 'over', 'board', 'paywall', 'settings'];
let current = 'home';

function show(name) {
  current = name;
  for (const p of PANELS) $(p).classList.toggle('active', p === name);
  $('hud').hidden = name !== null;
  if (name) $('hud').hidden = true;
}
function showGame() {
  current = null;
  for (const p of PANELS) $(p).classList.remove('active');
  $('hud').hidden = false;
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ───────────────────────────────── canvas ─────────────────────────────── */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resize);
resize();

/* ───────────────────────────────── camera ─────────────────────────────── */

async function startCamera() {
  if (stream) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError = 'This browser has no camera API.';
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    cameraError = null;
    return true;
  } catch (err) {
    stream = null;
    cameraError = err && err.name === 'NotAllowedError'
      ? 'Camera permission denied.'
      : 'No camera available.';
    return false;
  }
}
function stopCamera() {
  try { stream?.getTracks().forEach(t => t.stop()); } catch {}
  stream = null;
  video.srcObject = null;
}

/* ─────────────────────────────── main loop ────────────────────────────── */

function loop(now) {
  rafId = requestAnimationFrame(loop);
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0.016;
  lastFrame = now;

  let tracking = null;
  if (stream && mode === 'camera') {
    tracking = tracker.update(video);
    if (tracking.confidence > 0.12 && game.state === 'playing') calibration.observe(tracking.y);
    const pos = calibration.map(tracking.y);
    if (tracking.confidence > 0.12) {
      game.setTarget(pos);
      if (game.state === 'playing' && repCounter.update(pos)) {
        game.addRep();
        sfxRep();
        $('hudReps').textContent = game.reps;
      }
      // A deliberate rep starts the run; no tap needed once calibrated.
      if (game.state === 'ready' && Math.abs(pos - 0.5) > 0.18) game.start();
    }
    $('trackWarn').hidden = !(tracking.confidence <= 0.12);
  } else {
    $('trackWarn').hidden = true;
  }

  game.update(dt, mode);
  game.render(stream ? video : null, { mirror: settings.mirror });

  if (current === null) {
    $('hudScore').textContent = game.score;
    $('readyPrompt').hidden = game.state !== 'ready';
  }
  if (current === 'calibrate') renderCalibration(tracking);
}

function startLoop() { if (!rafId) { lastFrame = 0; rafId = requestAnimationFrame(loop); } }
function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

/* ────────────────────────────── calibration ───────────────────────────── */

let calStage = 0;            // 0 = awaiting top, 1 = awaiting bottom, 2 = done
let calSamples = null;
let calPending = null;

function openCalibration() {
  calStage = 0;
  calSamples = null;
  tracker.reset();
  updateCalUI();
  show('calibrate');
  startLoop();
}

function updateCalUI() {
  $('calStep1').className = calStage === 0 ? 'active' : 'done';
  $('calStep2').className = calStage === 1 ? 'active' : (calStage > 1 ? 'done' : '');
  $('btnCalCapture').textContent = calStage === 0
    ? 'Hold still — capture top'
    : 'Hold still — capture bottom';
  $('calStep').textContent = calStage === 0
    ? 'Prop your phone in front of you. Get into the TOP of a push-up, arms straight.'
    : 'Now lower down to the BOTTOM of a push-up, chest near the floor.';
}

function renderCalibration(tracking) {
  const status = $('calStatus');
  if (!stream) {
    status.textContent = cameraError || 'Starting camera…';
    status.className = 'cal-status bad';
    return;
  }
  if (!tracking) return;

  $('calMarker').style.top = (tracking.y * 100).toFixed(1) + '%';

  if (calPending) {
    const pct = Math.round((calSamples.length / CAL_SAMPLES) * 100);
    status.textContent = `Hold still… ${pct}%`;
    status.className = 'cal-status';
    return;
  }
  if (tracking.confidence < 0.2) {
    status.textContent = "Can't see you clearly — more light, or move into frame";
    status.className = 'cal-status bad';
  } else {
    status.textContent = 'Got you. Hold the pose, then tap capture.';
    status.className = 'cal-status good';
  }
}

const CAL_SAMPLES = 40;

function capturePose() {
  if (calPending) return;
  tracker.reacquire();
  calSamples = [];
  calPending = true;
  $('btnCalCapture').disabled = true;

  // Sample across ~1.3s and take the median: one frame is far too fragile, and
  // a mean would be dragged by a single bad frame.
  const iv = setInterval(() => {
    const r = tracker.update(video);
    if (r.confidence > 0.1) calSamples.push(r.y);
    if (calSamples.length >= CAL_SAMPLES) {
      clearInterval(iv);
      calPending = false;
      $('btnCalCapture').disabled = false;
      const sorted = calSamples.slice().sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      finishPose(median);
    }
  }, 33);
}

function finishPose(value) {
  if (calStage === 0) {
    calibration.top = value;
    calStage = 1;
    updateCalUI();
    sfx(660, 0.1, 0.2);
    toast('Top captured');
  } else {
    calibration.bottom = value;
    if (!calibration.ready) {
      // Same reading twice means the two poses were not distinguishable.
      calibration.bottom = null;
      toast('Those poses looked the same — try a bigger range', 3200);
      sfx(200, 0.2, 0.2, 'sawtooth');
      return;
    }
    // Tracker y grows downward; if the user captured in the other order, swap
    // rather than refusing, since the intent is unambiguous.
    if (calibration.bottom < calibration.top) {
      const t = calibration.top; calibration.top = calibration.bottom; calibration.bottom = t;
    }
    calStage = 2;
    Store.saveCalibration(calibration.toJSON());
    sfx(880, 0.12, 0.22);
    toast('Calibrated');
    beginRun('camera');
  }
}

/* ──────────────────────────────── runs ────────────────────────────────── */

async function requestPlay() {
  if (!Store.canPlay()) { openPaywall('You are out of free runs today.'); return; }

  const want = settings.control;
  if (want === 'tap') { beginRun('tap'); return; }

  const ok = await startCamera();
  if (!ok) {
    if (want === 'camera') {
      toast(cameraError + ' Playing in tap mode.', 3000);
    }
    beginRun('tap');
    return;
  }
  if (calibration.ready) beginRun('camera');
  else openCalibration();
}

function beginRun(runMode) {
  mode = runMode;
  Store.consumeRun();
  game.reset(settings.difficulty);
  repCounter.reset();
  lastClip = null;

  $('hudScore').textContent = '0';
  $('hudReps').textContent = '0';
  $('readySub').textContent = runMode === 'camera'
    ? 'Do a rep to start'
    : 'Tap anywhere to start';
  showGame();
  startLoop();

  if (runMode === 'camera' && canRecord()) {
    recorder = new ClipRecorder(canvas);
    const started = recorder.start();
    $('recDot').hidden = !started;
    if (!started) recorder = null;
  } else {
    recorder = null;
    $('recDot').hidden = true;
  }
}

async function handleGameOver({ score, reps }) {
  sfxCrash();
  $('recDot').hidden = true;

  if (recorder) {
    lastClip = await recorder.stop().catch(() => null);
    recorder = null;
  }

  if (mode === 'camera' && calibration.ready) Store.saveCalibration(calibration.toJSON());

  const { isBest, best } = Store.submitScore(score, reps);

  $('overScore').textContent = score;
  $('overRepsVal').textContent = reps;
  $('overBadge').hidden = !isBest;
  $('overTitle').textContent = isBest ? 'New personal best' : 'Run over';
  $('overBest').textContent = isBest
    ? `Beat your old best of ${Math.max(0, best.score - score) === 0 ? score : best.score}.`
    : `Your best is ${best.score} pipes.`;

  const shareable = !!lastClip;
  $('btnShare').hidden = !shareable;
  $('shareNote').hidden = !shareable;
  if (shareable) {
    $('shareNote').textContent = `${(lastClip.size / 1048576).toFixed(1)} MB clip of this run, ready to post.`;
  }

  // Keep rendering so the crashed frame stays on screen behind the panel.
  show('over');
  stopLoop();
  game.render(stream ? video : null, { mirror: settings.mirror });
}

function quitRun() {
  if (recorder) { recorder.cancel(); recorder = null; }
  $('recDot').hidden = true;
  stopLoop();
  goHome();
}

function goHome() {
  stopCamera();
  refreshHome();
  show('home');
}

function refreshHome() {
  const best = Store.getBest();
  const totalReps = Store.history().reduce((s, r) => s + (r.reps || 0), 0);
  const left = Store.runsLeftToday();
  $('homeBest').textContent = best.score;
  $('homeReps').textContent = totalReps;
  $('homeRuns').textContent = left === Infinity ? '∞' : left;
  $('btnGoPro').hidden = Store.isSubscribed();
  $('btnGoPro').textContent = Store.isSubscribed()
    ? 'Pro active'
    : 'Go Pro — unlimited runs';
}

/* ────────────────────────────── leaderboard ───────────────────────────── */

async function openBoard() {
  $('nameInput').value = Store.getProfile().name;
  const { entries, source } = await Store.Leaderboard.top();
  $('boardList').innerHTML = entries.map((e, i) => `
    <li class="${e.me ? 'me' : ''}">
      <span class="rank">${i + 1}</span>
      <span class="who"></span>
      ${e.pace ? '<span class="tag">pace-setter</span>' : ''}
      <span class="pts">${e.score}</span>
    </li>`).join('');
  // Names are user-supplied; set them as text, never as markup.
  [...$('boardList').querySelectorAll('.who')].forEach((el, i) => {
    el.textContent = entries[i].name || 'Anonymous';
  });

  $('boardSource').textContent = source === 'remote'
    ? 'Live global ranking.'
    : 'No leaderboard server is configured, so this board is stored on this device only. The pace-setter rows are fixed targets to beat, not real players.';
  show('board');
}

/* ──────────────────────────────── paywall ─────────────────────────────── */

function openPaywall(reason) {
  $('plans').innerHTML = Store.PLANS.map(p => `
    <button class="plan" data-plan="${p.id}">
      <span class="plan-name">${p.label}</span>
      ${p.badge ? `<span class="plan-badge">${p.badge}</span>` : ''}
      <span><span class="plan-price">${p.price}</span><span class="plan-period">${p.period}</span></span>
    </button>`).join('');

  [...$('plans').querySelectorAll('.plan')].forEach(btn => {
    btn.onclick = () => purchase(btn.dataset.plan);
  });

  $('myCode').textContent = Store.myReferralCode();
  $('refMsg').textContent = '';
  $('refMsg').className = 'ref-msg';

  const ent = Store.getEntitlement();
  $('payDisclaimer').textContent = ent
    ? `Pro active until ${new Date(ent.until).toLocaleDateString()} (source: ${ent.source}). ` + DISCLAIMER
    : DISCLAIMER;

  if (reason) toast(reason, 3000);
  show('paywall');
}

const DISCLAIMER =
  'No payment processor is connected. Selecting a plan grants access on this device only — ' +
  'nothing is charged and nothing is verified. Real billing needs a server that validates ' +
  'store receipts; see Backend.verifyPurchase in js/store.js.';

async function purchase(planId) {
  const plan = Store.PLANS.find(p => p.id === planId);
  if (!plan) return;

  try {
    const verified = await Store.Backend.verifyPurchase(planId, null);
    if (verified && verified.until) {
      Store.grantEntitlement('purchase', Math.ceil((verified.until - Date.now()) / Store.DAY));
      toast(`${plan.label} active.`);
      refreshHome();
      show('home');
      return;
    }
  } catch {
    toast('Could not reach the store.', 3000);
    return;
  }

  // Unconfigured backend: grant locally and be explicit that nothing was charged.
  Store.grantEntitlement('local-unverified', plan.days);
  toast(`${plan.label} unlocked on this device — no payment was taken.`, 4000);
  refreshHome();
  openPaywall();
}

/* ──────────────────────────────── settings ────────────────────────────── */

function renderSettings() {
  for (const [id, key] of [['segControl', 'control'], ['segDifficulty', 'difficulty']]) {
    [...$(id).querySelectorAll('button')].forEach(b => {
      b.classList.toggle('on', b.dataset.v === settings[key]);
    });
  }
  $('tgMirror').classList.toggle('on', settings.mirror);
  $('tgSound').classList.toggle('on', settings.sound);

  const ent = Store.getEntitlement();
  $('entStatus').textContent = ent
    ? `Pro until ${new Date(ent.until).toLocaleDateString()} — granted by ${ent.source}.`
    : `Free tier: ${Store.FREE_RUNS_PER_DAY} runs per day.`;
}

/* ───────────────────────────────── events ─────────────────────────────── */

$('btnPlay').onclick = requestPlay;
$('btnAgain').onclick = () => {
  if (!Store.canPlay()) { openPaywall('You are out of free runs today.'); return; }
  beginRun(mode);
};
$('btnQuit').onclick = quitRun;
$('btnOverHome').onclick = goHome;
$('btnLeaderboard').onclick = openBoard;
$('btnOverBoard').onclick = openBoard;
$('btnBoardBack').onclick = () => show(Store.getBest().score ? 'home' : 'home');
$('btnGoPro').onclick = () => openPaywall();
$('btnPayBack').onclick = () => { refreshHome(); show('home'); };
$('btnSettings').onclick = () => { renderSettings(); show('settings'); };
$('btnSettingsBack').onclick = () => { refreshHome(); show('home'); };

$('btnCalCapture').onclick = capturePose;
$('btnCalSkip').onclick = () => { stopLoop(); beginRun('tap'); };

$('nameInput').oninput = e => Store.setName(e.target.value);

$('btnShare').onclick = async () => {
  if (!lastClip) return;
  const name = `pushbird-${game.score}-pipes.${lastClip.type.includes('mp4') ? 'mp4' : 'webm'}`;
  const how = await shareClip(lastClip, name, `${game.score} pipes and ${game.reps} push-ups on PushBird`);
  if (how === 'downloaded') toast('Clip saved to your downloads.');
  else if (how === 'failed') toast('Could not save the clip.');
};

$('btnRedeem').onclick = () => {
  const res = Store.redeemReferral($('refInput').value);
  const msg = $('refMsg');
  if (res.ok) {
    msg.textContent = `Unlocked — ${res.days} days of Pro.`;
    msg.className = 'ref-msg ok';
    $('refInput').value = '';
    refreshHome();
    openPaywall();
  } else {
    msg.textContent = res.error;
    msg.className = 'ref-msg err';
  }
};

$('btnCopyCode').onclick = async () => {
  const code = Store.myReferralCode();
  try { await navigator.clipboard.writeText(code); toast('Code copied'); }
  catch { toast(`Your code is ${code}`); }
};

for (const [id, key] of [['segControl', 'control'], ['segDifficulty', 'difficulty']]) {
  $(id).onclick = e => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    settings[key] = b.dataset.v;
    Store.saveSettings(settings);
    renderSettings();
  };
}
$('tgMirror').onclick = () => { settings.mirror = !settings.mirror; Store.saveSettings(settings); renderSettings(); };
$('tgSound').onclick = () => { settings.sound = !settings.sound; Store.saveSettings(settings); renderSettings(); };

$('btnRecal').onclick = async () => {
  Store.clearCalibration();
  calibration = new Calibration(null);
  const ok = await startCamera();
  if (!ok) { toast(cameraError, 3000); return; }
  openCalibration();
};

$('btnResetAll').onclick = () => {
  const b = $('btnResetAll');
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = 'Tap again to erase everything';
    setTimeout(() => { delete b.dataset.armed; b.textContent = 'Reset all data'; }, 3000);
    return;
  }
  try { localStorage.clear(); } catch {}
  location.reload();
};

// Tap to flap (tap mode), and to dismiss the ready prompt.
canvas.addEventListener('pointerdown', e => {
  if (current !== null) return;
  e.preventDefault();
  if (mode === 'tap') game.flap();
  else if (game.state === 'ready') game.start();
});

document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (current !== null) return;
  if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); if (mode === 'tap') game.flap(); else game.start(); }
  if (e.code === 'Escape') quitRun();
});

// Pausing on hide: returning to a run that kept simulating would be an
// instant, unearned death.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && current === null && game.state === 'playing') {
    game.die();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ────────────────────────────────── init ──────────────────────────────── */

refreshHome();
renderSettings();
show('home');

// Exposed for the test harness only.
window.__pbMod = { Game, HeadTracker, Calibration, RepCounter, DIFFICULTY };
window.__pb = { game, tracker, calibration: () => calibration, Store, beginRun, show, get mode() { return mode; } };
