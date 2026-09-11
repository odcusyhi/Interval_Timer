// Persistence, entitlements and leaderboard.
//
// Everything here is client-side. That is a deliberate, documented limitation,
// not an oversight -- see the honesty note on Entitlements below.

const K = {
  best: 'pb_best',
  runs: 'pb_runs',
  cal: 'pb_cal',
  settings: 'pb_settings',
  ent: 'pb_entitlement',
  referral: 'pb_referral',
  scores: 'pb_scores',
  profile: 'pb_profile',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export const DAY = 86400000;

/* ------------------------------------------------------------------ profile */

export function getProfile() {
  let p = read(K.profile, null);
  if (!p || !p.id) {
    p = { id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2), name: '' };
    write(K.profile, p);
  }
  return p;
}
export function setName(name) {
  const p = getProfile();
  p.name = String(name || '').trim().slice(0, 16);
  write(K.profile, p);
  return p;
}

/* ------------------------------------------------------------- calibration */

export function loadCalibration() { return read(K.cal, null); }
export function saveCalibration(cal) { write(K.cal, cal); }
export function clearCalibration() { try { localStorage.removeItem(K.cal); } catch {} }

/* ---------------------------------------------------------------- settings */

const defaultSettings = { sound: true, mirror: true, control: 'auto', difficulty: 'normal' };
export function loadSettings() { return Object.assign({}, defaultSettings, read(K.settings, {})); }
export function saveSettings(s) { write(K.settings, s); }

/* ------------------------------------------------------------------ scores */

export function getBest() { return read(K.best, { score: 0, reps: 0 }); }
export function submitScore(score, reps) {
  const best = getBest();
  const isBest = score > best.score;
  if (isBest) write(K.best, { score, reps });

  const scores = read(K.scores, []);
  scores.push({ score, reps, at: Date.now() });
  // Keep the log bounded; nothing needs more than a recent window.
  write(K.scores, scores.slice(-200));

  Leaderboard.submit({ score, reps });
  return { isBest, best: getBest() };
}
export function history() { return read(K.scores, []); }

/* ------------------------------------------------------------- entitlement */

/**
 * Free tier allows FREE_RUNS_PER_DAY runs per rolling day.
 *
 * HONEST LIMITATION: this is a client-side gate over localStorage. Anyone can
 * clear site data or edit a value in devtools and play unlimited runs. It is
 * the correct shape for the paywall and the right place for the UI to hook
 * into, but it is NOT revenue protection. Enforcing entitlements requires a
 * server that validates App Store / Play / Stripe receipts and returns a signed
 * entitlement; `Backend.verifyPurchase` below is the seam where that goes.
 */
export const FREE_RUNS_PER_DAY = 3;

export const PLANS = [
  { id: 'weekly', label: 'Weekly', price: '$4.99', period: '/week', days: 7 },
  { id: 'yearly', label: 'Yearly', price: '$39.99', period: '/year', days: 365, badge: 'Best value' },
];

export function getEntitlement() {
  const e = read(K.ent, null);
  if (e && e.until && e.until > Date.now()) return e;
  return null;
}
export function isSubscribed() { return getEntitlement() !== null; }

export function grantEntitlement(source, days) {
  const current = getEntitlement();
  const from = current ? current.until : Date.now();
  const ent = { source, until: from + days * DAY, grantedAt: Date.now() };
  write(K.ent, ent);
  return ent;
}
export function clearEntitlement() { try { localStorage.removeItem(K.ent); } catch {} }

function today() { return Math.floor(Date.now() / DAY); }

export function runsUsedToday() {
  const r = read(K.runs, { day: today(), count: 0 });
  return r.day === today() ? r.count : 0;
}
export function runsLeftToday() {
  if (isSubscribed()) return Infinity;
  return Math.max(0, FREE_RUNS_PER_DAY - runsUsedToday());
}
export function canPlay() { return runsLeftToday() > 0; }
export function consumeRun() {
  if (isSubscribed()) return;
  write(K.runs, { day: today(), count: runsUsedToday() + 1 });
}

/* ------------------------------------------------------------------ referral */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1

export function myReferralCode() {
  let r = read(K.referral, null);
  if (!r || !r.code) {
    const id = getProfile().id;
    // Derive from the profile id so the code is stable for this install.
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    let code = '';
    for (let i = 0; i < 6; i++) { code += ALPHABET[(h >>> (i * 5)) & 31]; }
    r = { code, redeemed: [], usedSomeoneElses: null };
    write(K.referral, r);
  }
  return r.code;
}

export function referralState() {
  myReferralCode();
  return read(K.referral, { code: '', redeemed: [], usedSomeoneElses: null });
}

export const REFERRAL_DAYS = 30;

/**
 * Redeem someone else's code for a free month.
 *
 * HONEST LIMITATION: with no server, this install cannot verify that a code
 * belongs to a real user, nor credit the referrer. It validates shape, rejects
 * self-referral and repeat redemption, and grants the month locally. The
 * referrer's reward is what `Backend.redeemReferral` exists to deliver.
 */
export function redeemReferral(rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const state = referralState();

  if (code.length !== 6) return { ok: false, error: 'Codes are 6 characters.' };
  if (code === state.code) return { ok: false, error: "That's your own code." };
  if (state.usedSomeoneElses) return { ok: false, error: 'You already used a referral code.' };
  if (![...code].every(ch => ALPHABET.includes(ch))) return { ok: false, error: 'That code has invalid characters.' };

  state.usedSomeoneElses = code;
  write(K.referral, state);
  const ent = grantEntitlement('referral', REFERRAL_DAYS);
  Backend.redeemReferral(code).catch(() => {});
  return { ok: true, until: ent.until, days: REFERRAL_DAYS };
}

/* ----------------------------------------------------------------- backend */

/**
 * The single seam between this app and a real server.
 *
 * Ships unconfigured: every method resolves locally so the app is fully
 * playable offline with a device-local leaderboard. Point BASE at a real API
 * and these become network calls; nothing else in the app needs to change.
 */
export const Backend = {
  BASE: null,      // e.g. 'https://api.example.com'

  get configured() { return typeof this.BASE === 'string' && this.BASE.length > 0; },

  async post(path, body) {
    if (!this.configured) return null;
    const res = await fetch(this.BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  },

  async submitScore(entry) { return this.post('/scores', entry); },
  async topScores() { return this.configured ? this.post('/scores/top', {}) : null; },
  async redeemReferral(code) { return this.post('/referrals/redeem', { code }); },
  /** Where receipt validation goes. Must return a server-signed entitlement. */
  async verifyPurchase(planId, receipt) { return this.post('/purchases/verify', { planId, receipt }); },
};

/**
 * Leaderboard with a local fallback.
 *
 * HONEST LIMITATION: with Backend unconfigured this is a device-local board, so
 * "global" ranking is simulated against a fixed set of pace-setter entries.
 * They are clearly labelled in the UI rather than passed off as real players.
 */
export const Leaderboard = {
  PACE_SETTERS: [
    { name: 'PUSHKING', score: 84, reps: 84 },
    { name: 'IRONLUNG', score: 61, reps: 61 },
    { name: 'REPMACHINE', score: 47, reps: 47 },
    { name: 'CHESTDAY', score: 33, reps: 33 },
    { name: 'FLAPJACK', score: 22, reps: 22 },
  ],

  async submit(entry) {
    try { await Backend.submitScore(Object.assign({ id: getProfile().id, name: getProfile().name }, entry)); }
    catch {}
  },

  /** @returns {{entries:Array, source:'remote'|'local'}} */
  async top() {
    try {
      const remote = await Backend.topScores();
      if (remote && Array.isArray(remote.entries)) return { entries: remote.entries, source: 'remote' };
    } catch {}

    const me = getBest();
    const name = getProfile().name || 'YOU';
    const entries = this.PACE_SETTERS.map(p => Object.assign({ pace: true }, p));
    if (me.score > 0) entries.push({ name, score: me.score, reps: me.reps, me: true });
    entries.sort((a, b) => b.score - a.score || b.reps - a.reps);
    return { entries, source: 'local' };
  },
};
