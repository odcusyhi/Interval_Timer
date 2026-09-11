# PushBird

Flappy Bird you play with push-ups. Your head is the controller: the camera
tracks it, and the bird flies wherever you are in the rep. Every run records
itself so you leave with a clip worth posting.

Built from [this idea](https://x.com/ernestosoftware/status/2098051742113886293)
— Ernesto Lopez's "Push Day Killer" clip, plus Simone Canci's reply proposing
the business layer (weekly/annual pricing, shareable referral codes, a global
leaderboard).

No build step, no dependencies, no CDN. Open it and it runs.

## How it plays

1. Prop your phone in front of you, facing your head.
2. Calibrate: hold the top of a push-up, then the bottom. Two taps.
3. Lower into a rep to dive, push up to climb. Thread the pipes.

Pipes span to both edges, so parking at the top or bottom is not a safe lane.
The gap narrows and the field speeds up as your score climbs.

No camera, or permission denied? It falls back to tap-to-flap automatically —
classic gravity-and-flap Flappy Bird, fully playable.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `app.css` | Shell and styles |
| `js/tracker.js` | Head tracking, calibration, rep counting |
| `js/game.js` | Physics, collision, rendering |
| `js/recorder.js` | Clip capture and sharing |
| `js/store.js` | Persistence, entitlements, referrals, leaderboard |
| `js/main.js` | Wiring |
| `test/` | Test suite (see below) |
| `timer/` | An unrelated interval timer, built here before the idea was legible |

## Head tracking

The camera frame is reduced to 64×48 greyscale and scored one row at a time.
The head is the argmax of the smoothed row profile. Two cues are combined:

- **Texture.** A face carries far more local gradient — eyes, nostrils,
  hairline, mouth — than a floor or a blank wall.
- **Foreground.** A slowly adapting background model flags what differs from the
  room's resting state, which separates the player from a textured background.

Both cues are **contrast-relative**, divided by local intensity. This is the
single most important detail in the file. An absolute gradient threshold
silently under-detects dark subjects: a dark face has plenty of structure, but
its raw gradient magnitudes are a fraction of a brightly lit one, so a fixed
cutoff scores it near zero. The first draft did exactly this and tracked a dark
subject at r = 0.55 against r = 0.97 for a light one. Dividing by local
intensity closed that gap to r = 0.98 / 0.97. The test suite asserts the spread
across skin tones stays under 0.12 so the regression cannot come back.

Skin-tone segmentation — the usual quick answer for face tracking — was rejected
for the same reason: it encodes one narrow range of complexions as "skin".

**Why not MediaPipe.** Its npm package is ~36 MB of WASM and ships no model
files; those are fetched from a Google CDN at runtime. That would make the app
non-functional offline, add a hard third-party dependency to the one thing the
game cannot work without, and cost several megabytes on first run. The tracker
here is about 4 KB and runs in roughly a millisecond per frame.

**Calibration** maps whatever range the tracker actually reports onto the
playfield, so systematic offsets cancel and only relative motion matters. The
reported position sits slightly above the geometric centre of the head, and that
offset differs between a held pose and a moving one — so the range also widens
adaptively during play, converging on your true range over the first few reps.
It only ever widens, so it cannot collapse.

## Recording

The camera frame, pipes, bird and HUD all composite onto a **single canvas**,
which is what makes `captureStream()` + `MediaRecorder` a few lines rather than a
render pipeline. Overlaying a transparent canvas on a `<video>` element would
look identical on screen and be unrecordable. MP4/H.264 is preferred where
supported so the clip shares natively on iOS and Android; otherwise WebM.

## What is real and what is not

Everything about the game is real: tracking, calibration, rep counting,
physics, collision, recording, sharing, persistence.

The business layer is a **working front-end over a backend that does not
exist**, and the app says so in its own UI rather than only here:

- **Payments.** Selecting a plan grants access on this device. Nothing is
  charged and nothing is verified. It is a client-side gate over `localStorage`:
  anyone can clear site data and play unlimited runs. This is the right *shape*
  for a paywall and the right place to hook one up — it is not revenue
  protection.
- **Leaderboard.** Device-local. The pace-setter rows are fixed targets to beat,
  labelled as such in the UI, not passed off as real players.
- **Referrals.** Codes validate shape, reject self-referral and repeat
  redemption, and grant a month locally. With no server, this install cannot
  confirm a code belongs to a real user or credit the referrer.

All three route through one seam: `Backend` in `js/store.js`. Set `Backend.BASE`
to a real API and `verifyPurchase` / `topScores` / `redeemReferral` become
network calls. Nothing else in the app changes. Real billing needs a server that
validates App Store / Play / Stripe receipts and returns a signed entitlement.

## Tests

```sh
python3 test/make-fixture.py     # once: builds the synthetic camera footage (needs numpy)
npm install playwright
node test/run-tests.js           # CHROME_PATH=... to reuse an existing Chromium
```

59 assertions. The tracker is tested against synthetic frames with exact ground
truth across three skin tones; the app is driven end to end in Chromium with a
**simulated camera** fed from a generated Y4M file, so tracking, rep counting,
clip recording, the paywall gate, referral validation and collision are all
exercised against real pixels rather than mocks.

Screenshots land in `test/screenshots/`.

## Running locally

```sh
python3 -m http.server 8000
```

Then <http://127.0.0.1:8000/>. A server is required: ES modules and
`getUserMedia` do not work from `file://`. Camera access needs HTTPS or
localhost.
