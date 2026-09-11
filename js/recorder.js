// Clip capture.
//
// The tweet's whole thesis is that this goes viral on TikTok and Reels, which
// only happens if leaving the app with a postable clip is trivial. Since the
// game already composites onto one canvas, recording is captureStream() into a
// MediaRecorder -- no server, no upload, no re-render.

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1',       // preferred: shareable to iOS/Android natively
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return null;
}

export const isSupported = () => pickMimeType() !== null;

export class ClipRecorder {
  constructor(canvas, { fps = 30, maxMs = 60000 } = {}) {
    this.canvas = canvas;
    this.fps = fps;
    this.maxMs = maxMs;
    this.recorder = null;
    this.chunks = [];
    this.blob = null;
    this.mime = null;
    this.stopTimer = null;
  }

  get active() { return this.recorder !== null && this.recorder.state === 'recording'; }

  start() {
    if (this.active) return false;
    const mime = pickMimeType();
    if (!mime) return false;

    try {
      const stream = this.canvas.captureStream(this.fps);
      this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    } catch { this.recorder = null; return false; }

    this.mime = mime;
    this.chunks = [];
    this.blob = null;
    this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    try { this.recorder.start(250); } catch { this.recorder = null; return false; }

    // Hard cap, so a run left running does not grow without bound.
    this.stopTimer = setTimeout(() => this.stop().catch(() => {}), this.maxMs);
    return true;
  }

  /** @returns {Promise<Blob|null>} */
  stop() {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const rec = this.recorder;
    if (!rec || rec.state === 'inactive') { this.recorder = null; return Promise.resolve(this.blob); }

    return new Promise(resolve => {
      rec.onstop = () => {
        this.blob = this.chunks.length ? new Blob(this.chunks, { type: this.mime }) : null;
        this.recorder = null;
        resolve(this.blob);
      };
      try { rec.stop(); } catch { this.recorder = null; resolve(null); }
    });
  }

  cancel() {
    clearTimeout(this.stopTimer);
    try { this.recorder?.stop(); } catch {}
    this.recorder = null;
    this.chunks = [];
    this.blob = null;
  }

  get extension() { return this.mime && this.mime.startsWith('video/mp4') ? 'mp4' : 'webm'; }

  filename(score) { return `pushbird-${score}-pipes.${this.extension}`; }
}

/**
 * Hand the clip to the OS share sheet when available, otherwise fall back to a
 * download. Returns how it was delivered so the UI can word itself accurately
 * rather than promising a share sheet that never appears.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'|'failed'>}
 */
export async function shareClip(blob, filename, text) {
  if (!blob) return 'failed';
  const file = new File([blob], filename, { type: blob.type });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // fall through to download
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
  } catch { return 'failed'; }
}
