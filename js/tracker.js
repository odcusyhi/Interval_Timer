// Head tracking from a plain camera frame, with no ML model and no network.
//
// Why hand-rolled: MediaPipe's npm package ships ~36MB of WASM and no model
// files (those are fetched from a Google CDN at runtime), which would make the
// app non-functional offline and add a hard third-party dependency to the one
// thing the game cannot work without. This tracker is ~4KB, runs in about a
// millisecond per frame, and degrades predictably.
//
// The signal: during a push-up the head is the closest, most textured object in
// frame and it translates almost purely vertically. Two cues are combined into
// a per-row score, and the head is the argmax of the smoothed profile.
//
//   1. Texture energy. A face carries far more local gradient (eyes, nostrils,
//      hairline, mouth) than a floor or a blank wall. Scale-free and, unlike
//      skin-tone segmentation, it does not privilege any particular skin tone.
//   2. Foreground mass. A slowly-adapting background model flags pixels that
//      differ from the scene's resting state. This disambiguates a textured
//      background (a bookshelf) from the person in front of it.
//
// Absolute accuracy does not matter because calibration maps whatever range the
// tracker actually reports onto the playfield. Only relative motion matters.

const W = 64;   // working resolution; tracking a head needs nothing finer
const H = 48;

// Tuning. Values chosen by sweeping against synthetic push-up footage across
// light, medium and dark subjects; see test/tracker.test.html.
const REL_FLOOR   = 20;    // added to intensity before dividing, avoids blowup in near-black pixels
const TEX_MIN     = 0.06;  // relative-gradient floor, counts real structure and rejects sensor noise
const FG_MIN      = 0.05;  // relative background-difference floor
const FG_BOOST    = 0.6;   // how much foreground sharpens an existing texture peak
const BLUR        = 3;     // profile blur radius, in rows
const CONT_SIGMA  = 0.22;  // temporal continuity window, as a fraction of frame height
const CONT_FLOOR  = 0.35;  // continuity never fully suppresses a distant lobe (see below)
const WIN         = 8;     // sub-row centroid half-window, in rows
const SMOOTH_BASE = 0.30;  // filter responsiveness when still
const SMOOTH_GAIN = 6.0;   // extra responsiveness proportional to movement

export class HeadTracker {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.gray = new Float32Array(W * H);
    this.bg = null;                       // background model, lazily seeded
    this.rowScore = new Float32Array(H);
    this.rowFg = new Float32Array(H);
    this.smooth = new Float32Array(H);

    this.y = 0.5;                         // last accepted estimate, 0..1
    this.confidence = 0;
    this.initialized = false;
  }

  /**
   * Drop the continuity prior for the next few frames so the tracker may jump
   * anywhere in frame. Call this before sampling a new calibration pose, or
   * after the subject has been out of frame.
   */
  reacquire() { this.confidence = 0; }

  /** Forget the learned background, e.g. after the phone has been repositioned. */
  reset() {
    this.bg = null;
    this.initialized = false;
    this.y = 0.5;
    this.confidence = 0;
  }

  /**
   * @param {HTMLVideoElement|HTMLCanvasElement} video  any canvas-drawable source
   * @returns {{y:number, confidence:number}} y is 0 (top of frame) .. 1 (bottom)
   */
  update(video) {
    // Accepts any canvas-drawable source: a <video>, but also a <canvas> or
    // ImageBitmap, which is what the test harness feeds it.
    const srcW = video.videoWidth || video.width || 0;
    const srcH = video.videoHeight || video.height || 0;
    const notReady = video.readyState !== undefined && video.readyState < 2;
    if (!srcW || !srcH || notReady) {
      return { y: this.y, confidence: 0 };
    }

    this.ctx.drawImage(video, 0, 0, W, H);
    let px;
    try {
      px = this.ctx.getImageData(0, 0, W, H).data;
    } catch {
      return { y: this.y, confidence: 0 };   // tainted canvas
    }

    const gray = this.gray;
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      gray[i] = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114);
    }

    if (!this.bg) {
      this.bg = Float32Array.from(gray);
      this.initialized = true;
    }
    const bg = this.bg;

    // Per-row cue accumulation.
    //
    // Both cues are CONTRAST-RELATIVE, divided by local intensity. An absolute
    // gradient threshold silently under-detects dark subjects: a dark face on a
    // mid-grey floor has plenty of structure, but its raw gradient magnitudes
    // are a fraction of a brightly lit one, so a fixed cutoff scores it near
    // zero. Dividing by local intensity makes the cue depend on relative
    // contrast, which is roughly constant across skin tones and lighting.
    const rowTex = this.rowScore;
    const rowFg = this.rowFg;
    rowTex.fill(0);
    rowFg.fill(0);
    let totalTex = 0, totalFg = 0;

    for (let y = 1; y < H - 1; y++) {
      let tex = 0, fg = 0;
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        const g = gray[i];
        const gx = gray[i + 1] - gray[i - 1];
        const gy = gray[i + W] - gray[i - W];
        const rel = (Math.abs(gx) + Math.abs(gy)) / (g + REL_FLOOR);
        if (rel > TEX_MIN) tex += rel;
        const d = Math.abs(g - bg[i]) / (bg[i] + REL_FLOOR);
        if (d > FG_MIN) fg += d;
      }
      rowTex[y] = tex; totalTex += tex;
      rowFg[y] = fg;  totalFg += fg;
    }

    if (totalTex < 1e-6) {
      this.confidence *= 0.9;
      return { y: this.y, confidence: this.confidence };
    }

    // Foreground is a multiplicative BONUS on texture rather than a separate
    // additive cue. Additive mixing made the profile depend on how much of the
    // subject had been absorbed into the background model, so a pose held during
    // calibration and the same pose during play scored differently and the
    // calibrated range never matched the played range. As a bonus term it can
    // only sharpen a peak that texture already found, never invent one.
    const fgScale = totalFg > 1e-6 ? H / totalFg : 0;
    const rowScore = this.rowScore;
    for (let y = 0; y < H; y++) {
      rowScore[y] = rowTex[y] * (1 + FG_BOOST * rowFg[y] * fgScale);
    }

    // Blur the profile so a single noisy row cannot win the argmax.
    const smooth = this.smooth;
    for (let y = 0; y < H; y++) {
      let sum = 0, n = 0;
      for (let k = -BLUR; k <= BLUR; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= H) continue;
        sum += rowScore[yy]; n++;
      }
      smooth[y] = sum / n;
    }

    // Temporal continuity: prefer the lobe nearest where the head was last
    // frame, so a textured background (a bookshelf, a patterned rug) cannot
    // steal the track. The window is wide enough not to impede a fast rep, and
    // is disabled entirely while confidence is low so the tracker can reacquire.
    // The prior is floored rather than applied as a bare Gaussian. A bare
    // Gaussian annihilates distant lobes outright, which means the tracker
    // cannot follow a large discontinuous move -- exactly what happens when
    // someone repositions between calibration poses, or drops into position
    // from standing. With a floor, a distant lobe that is genuinely much
    // stronger than the nearby one still wins, while mild background clutter
    // still loses.
    if (this.confidence > 0.15) {
      const prev = this.y * (H - 1);
      const inv2s2 = 1 / (2 * CONT_SIGMA * CONT_SIGMA * H * H);
      for (let y = 0; y < H; y++) {
        const d = y - prev;
        smooth[y] *= CONT_FLOOR + (1 - CONT_FLOOR) * Math.exp(-d * d * inv2s2);
      }
    }

    let peak = 0, peakVal = 0, total = 0;
    for (let y = 0; y < H; y++) {
      total += smooth[y];
      if (smooth[y] > peakVal) { peakVal = smooth[y]; peak = y; }
    }

    if (total < 1e-9 || peakVal <= 0) {
      this.confidence *= 0.9;
      return { y: this.y, confidence: this.confidence };
    }

    // Sub-row refinement: centroid over a window around the peak. A local
    // window rather than the whole profile keeps a second lobe (torso, legs)
    // from dragging the estimate away from the head.
    let wsum = 0, wy = 0;
    for (let y = Math.max(0, peak - WIN); y <= Math.min(H - 1, peak + WIN); y++) {
      const w = smooth[y];
      wsum += w; wy += w * y;
    }
    const rawY = wsum > 0 ? (wy / wsum) / (H - 1) : this.y;

    // Confidence from peak sharpness: a clear subject makes one tall narrow
    // lobe; an empty or uniformly textured frame makes a flat profile.
    const mean = total / H;
    const sharpness = mean > 0 ? peakVal / mean : 0;
    const conf = Math.max(0, Math.min(1, (sharpness - 1.15) / 1.6));
    this.confidence = this.confidence * 0.7 + conf * 0.3;

    // Temporal smoothing, adaptive: follow a deliberate rep quickly while
    // damping jitter when nearly stationary. Attenuating a real rep's amplitude
    // would shrink the usable range and make the game unplayable, so the filter
    // opens up sharply as soon as genuine movement is detected.
    const delta = Math.abs(rawY - this.y);
    const alpha = Math.min(0.95, SMOOTH_BASE + delta * SMOOTH_GAIN);
    this.y = this.y + (rawY - this.y) * alpha;

    // Adapt the background slowly. The time constant is deliberately long
    // (~15s at 30fps) so a subject pausing at the top of a rep is not absorbed.
    for (let i = 0; i < W * H; i++) {
      bg[i] += (gray[i] - bg[i]) * 0.002;
    }

    return { y: this.y, confidence: this.confidence };
  }
}

/**
 * Maps the tracker's observed vertical range onto the playfield.
 *
 * Calibration records the head position at the top and bottom of a rep. The
 * mapping is inverted deliberately: moving the head DOWN (lowering into a
 * push-up) moves the bird DOWN, which is the intuitive direction.
 */
export class Calibration {
  constructor(saved) {
    this.top = saved?.top ?? null;
    this.bottom = saved?.bottom ?? null;
  }

  get ready() {
    return this.top !== null && this.bottom !== null &&
           Math.abs(this.bottom - this.top) > 0.04;
  }

  toJSON() { return { top: this.top, bottom: this.bottom }; }

  /**
   * Widen the calibrated range toward a reading that fell outside it.
   *
   * Two-pose calibration is only ever approximate: people do not hold the exact
   * extremes they will actually reach once they are moving, and the tracker's
   * reported position sits on the facial-feature band rather than the geometric
   * centre of the head, so the offset differs slightly between a held pose and
   * a moving one. Widening (never narrowing) lets the mapping converge on the
   * player's true range over the first few reps, and cannot degenerate: the
   * usable span only ever grows.
   */
  observe(rawY) {
    if (!this.ready) return;
    if (rawY < this.top) this.top += (rawY - this.top) * 0.25;
    else if (rawY > this.bottom) this.bottom += (rawY - this.bottom) * 0.25;
  }

  /** @returns {number} 0 (top of playfield) .. 1 (bottom) */
  map(rawY) {
    if (!this.ready) return rawY;
    const span = this.bottom - this.top;
    const t = (rawY - this.top) / span;
    // Allow a little overshoot past the calibrated extremes, then clamp, so a
    // rep slightly deeper than calibration still reaches the edge of the field.
    return Math.max(0, Math.min(1, t));
  }
}

/**
 * Counts push-up reps from the mapped position with hysteresis, so noise around
 * a threshold cannot ratchet the count. A rep is a full down-then-up cycle.
 */
export class RepCounter {
  constructor(downAt = 0.68, upAt = 0.34) {
    this.downAt = downAt;
    this.upAt = upAt;
    this.state = 'up';
    this.reps = 0;
  }
  reset() { this.state = 'up'; this.reps = 0; }
  update(pos) {
    if (this.state === 'up' && pos >= this.downAt) {
      this.state = 'down';
    } else if (this.state === 'down' && pos <= this.upAt) {
      this.state = 'up';
      this.reps++;
      return true;      // a rep just completed
    }
    return false;
  }
}
