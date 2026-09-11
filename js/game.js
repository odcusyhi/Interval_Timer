// The game: Flappy Bird where your body is the controller.
//
// Everything (camera frame, pipes, bird, HUD) composites onto a SINGLE canvas.
// That is deliberate: the whole premise is a clip worth posting, and a canvas
// that already contains the full picture can be handed straight to
// captureStream() + MediaRecorder. Overlaying a transparent canvas on a <video>
// element would look identical on screen and be unrecordable.

export const DIFFICULTY = {
  easy:   { gap: 0.40, speed: 0.30, ramp: 0.010, spacing: 1.55 },
  normal: { gap: 0.32, speed: 0.38, ramp: 0.016, spacing: 1.35 },
  hard:   { gap: 0.26, speed: 0.46, ramp: 0.022, spacing: 1.15 },
};

const BIRD_X = 0.30;          // fraction of width
const BIRD_R = 0.045;         // fraction of min(w,h)
const PIPE_W = 0.14;          // fraction of width
const GRAVITY = 2.6;          // tap mode only, in field-heights per second^2
const FLAP_V = -0.85;

export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onScore:Function, onGameOver:Function, onRep:Function}} hooks
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.reset('normal');
  }

  reset(difficulty = 'normal') {
    this.cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    this.pipes = [];
    this.score = 0;
    this.reps = 0;
    this.t = 0;
    this.speed = this.cfg.speed;
    this.birdY = 0.5;
    this.birdV = 0;
    this.targetY = 0.5;
    this.rotation = 0;
    this.state = 'ready';      // ready -> playing -> dead
    this.deadAt = 0;
    this.shake = 0;
    this.flashT = 0;
    this.nextPipeAt = 0.8;
    this.trail = [];
  }

  start() {
    if (this.state === 'playing') return;
    this.state = 'playing';
    this.t = 0;
    this.nextPipeAt = 0.8;
  }

  /** Position control (camera mode): 0 = top of field, 1 = bottom. */
  setTarget(y) { this.targetY = Math.max(0, Math.min(1, y)); }

  /** Impulse control (tap mode). */
  flap() {
    if (this.state === 'ready') this.start();
    if (this.state === 'playing') this.birdV = FLAP_V;
  }

  get birdRadius() {
    const { width: w, height: h } = this.canvas;
    return Math.min(w, h) * BIRD_R;
  }

  /**
   * @param {number} dt seconds
   * @param {'camera'|'tap'} mode
   */
  update(dt, mode) {
    dt = Math.min(dt, 0.05);            // clamp so a stalled tab cannot teleport the bird through a pipe
    this.t += dt;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3);
    if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - dt * 4);

    if (this.state !== 'playing') {
      if (mode === 'camera') this.birdY += (this.targetY - this.birdY) * Math.min(1, dt * 10);
      return;
    }

    if (mode === 'camera') {
      // Direct positional control. A push-up IS the input, so mapping head
      // height straight onto bird height is both the obvious mechanic and the
      // one that makes the clip read instantly to a viewer. Smoothing gives it
      // weight without adding lag a player would feel.
      const prev = this.birdY;
      this.birdY += (this.targetY - this.birdY) * Math.min(1, dt * 11);
      this.birdV = (this.birdY - prev) / Math.max(dt, 1e-3);
    } else {
      this.birdV += GRAVITY * dt;
      this.birdY += this.birdV * dt;
    }

    this.rotation = Math.max(-0.5, Math.min(1.1, this.birdV * 0.5));

    this.trail.push({ y: this.birdY, t: this.t });
    while (this.trail.length && this.t - this.trail[0].t > 0.25) this.trail.shift();

    this.speed = this.cfg.speed + this.score * this.cfg.ramp;

    // Spawn pipes on a distance-based cadence so ramping speed does not also
    // ramp how many pipes are on screen.
    this.nextPipeAt -= this.speed * dt;
    if (this.nextPipeAt <= 0) {
      this.nextPipeAt = this.cfg.spacing;
      const gap = Math.max(0.17, this.cfg.gap - this.score * 0.0035);
      const margin = gap / 2 + 0.08;
      const gapY = margin + Math.random() * (1 - margin * 2);
      this.pipes.push({ x: 1 + PIPE_W, gapY, gap, passed: false });
    }

    for (const p of this.pipes) p.x -= this.speed * dt;
    while (this.pipes.length && this.pipes[0].x < -PIPE_W * 2) this.pipes.shift();

    for (const p of this.pipes) {
      if (!p.passed && p.x + PIPE_W / 2 < BIRD_X) {
        p.passed = true;
        this.score++;
        this.flashT = 1;
        this.hooks.onScore?.(this.score);
      }
    }

    if (this.birdY < 0 || this.birdY > 1) return this.die();
    if (this.hitsPipe()) return this.die();
  }

  hitsPipe() {
    const { width: w, height: h } = this.canvas;
    const r = this.birdRadius;
    const bx = BIRD_X * w;
    const by = this.birdY * h;

    for (const p of this.pipes) {
      const left = (p.x - PIPE_W / 2) * w;
      const right = (p.x + PIPE_W / 2) * w;
      if (bx + r < left || bx - r > right) continue;

      const gapTop = (p.gapY - p.gap / 2) * h;
      const gapBottom = (p.gapY + p.gap / 2) * h;
      // Circle vs the two rectangles, via closest-point.
      if (this.circleHitsRect(bx, by, r, left, 0, right, gapTop)) return true;
      if (this.circleHitsRect(bx, by, r, left, gapBottom, right, h)) return true;
    }
    return false;
  }

  circleHitsRect(cx, cy, r, x0, y0, x1, y1) {
    const nx = Math.max(x0, Math.min(cx, x1));
    const ny = Math.max(y0, Math.min(cy, y1));
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  die() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deadAt = this.t;
    this.shake = 1;
    this.hooks.onGameOver?.({ score: this.score, reps: this.reps });
  }

  addRep() { this.reps++; this.hooks.onRep?.(this.reps); }

  /* ------------------------------------------------------------- rendering */

  render(video, opts = {}) {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    ctx.save();

    if (this.shake > 0) {
      const s = this.shake * this.shake * 14;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    this.drawBackground(video, opts.mirror !== false);
    for (const p of this.pipes) this.drawPipe(p, w, h);
    this.drawBird(w, h);
    ctx.restore();

    if (this.flashT > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flashT * 0.10})`;
      ctx.fillRect(0, 0, w, h);
    }
    if (this.state === 'dead') {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, w, h);
    }
  }

  drawBackground(video, mirror) {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;

    const vw = video?.videoWidth || 0;
    const vh = video?.videoHeight || 0;
    if (!vw || !vh) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#4ec0ca');
      grad.addColorStop(1, '#8fd8a0');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // Cover-fit, preserving aspect ratio.
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale;
    const dx = (w - dw) / 2, dy = (h - dh) / 2;

    ctx.save();
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.restore();

    // Slight darkening so bright pipes and white text stay readable over any room.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, w, h);
  }

  drawPipe(p, w, h) {
    const ctx = this.ctx;
    const x = (p.x - PIPE_W / 2) * w;
    const pw = PIPE_W * w;
    const gapTop = (p.gapY - p.gap / 2) * h;
    const gapBottom = (p.gapY + p.gap / 2) * h;
    const lipH = Math.min(34, pw * 0.34);
    const lipOver = pw * 0.10;

    const body = ctx.createLinearGradient(x, 0, x + pw, 0);
    body.addColorStop(0, '#4a9e2f');
    body.addColorStop(0.28, '#8fd94f');
    body.addColorStop(0.62, '#5cb83a');
    body.addColorStop(1, '#2f6b1f');

    ctx.fillStyle = body;
    ctx.strokeStyle = 'rgba(20,48,12,0.9)';
    ctx.lineWidth = 3;

    ctx.fillRect(x, 0, pw, gapTop - lipH);
    ctx.strokeRect(x, 0, pw, gapTop - lipH);
    ctx.fillRect(x - lipOver, gapTop - lipH, pw + lipOver * 2, lipH);
    ctx.strokeRect(x - lipOver, gapTop - lipH, pw + lipOver * 2, lipH);

    ctx.fillRect(x, gapBottom + lipH, pw, h - gapBottom - lipH);
    ctx.strokeRect(x, gapBottom + lipH, pw, h - gapBottom - lipH);
    ctx.fillRect(x - lipOver, gapBottom, pw + lipOver * 2, lipH);
    ctx.strokeRect(x - lipOver, gapBottom, pw + lipOver * 2, lipH);
  }

  drawBird(w, h) {
    const ctx = this.ctx;
    const r = this.birdRadius;
    const x = BIRD_X * w;
    const y = this.birdY * h;

    for (let i = 0; i < this.trail.length; i += 2) {
      const t = this.trail[i];
      const age = (this.t - t.t) / 0.25;
      ctx.globalAlpha = (1 - age) * 0.18;
      ctx.fillStyle = '#ffd60a';
      ctx.beginPath();
      ctx.arc(x - (1 - age) * r * 1.4, t.y * h, r * (1 - age * 0.5), 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this.rotation);

    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = r * 0.5;
    ctx.shadowOffsetY = r * 0.16;

    ctx.fillStyle = '#ffd233';
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.86, 0, 0, 7); ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.fillStyle = '#f5a623';
    ctx.beginPath(); ctx.ellipse(-r * 0.1, r * 0.3, r * 0.7, r * 0.4, 0, 0, 7); ctx.fill();

    // wing beat, faster while climbing
    const beat = Math.sin(this.t * (this.birdV < 0 ? 34 : 18)) * r * 0.3;
    ctx.fillStyle = '#fff4d0';
    ctx.beginPath(); ctx.ellipse(-r * 0.18, beat * 0.5, r * 0.46, r * 0.3, -0.3, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1.5; ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(r * 0.38, -r * 0.26, r * 0.30, 0, 7); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(r * 0.46, -r * 0.26, r * 0.14, 0, 7); ctx.fill();

    ctx.fillStyle = '#ff7a1a';
    ctx.beginPath();
    ctx.moveTo(r * 0.72, 0);
    ctx.lineTo(r * 1.28, r * 0.12);
    ctx.lineTo(r * 0.72, r * 0.30);
    ctx.closePath(); ctx.fill();

    ctx.restore();
  }
}
