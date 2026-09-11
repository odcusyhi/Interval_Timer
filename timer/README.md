# HIIT Interval Timer

A single-file, offline-capable interval timer for HIIT, Tabata and circuit
training. No build step, no dependencies, no network calls — open `index.html`
and it runs.

## Features

- **Work / rest intervals** with rounds, sets, and rest between sets
- **Warm-up and cool-down** phases bracketing the workout
- **Large circular readout** sized to be legible from across the room, with a
  depleting progress ring and one dot per work interval
- **Whole-workout time remaining**, not just the current phase
- **Skip forward / back** between phases mid-workout (back once restarts the
  current phase, twice steps back — the convention every media player uses)
- **Audio beeps, spoken cues, and vibration**, each independently toggleable
- **Screen wake lock** so the display doesn't sleep mid-set
- **Saved workouts** with optional names, persisted in `localStorage`
- **Installable PWA** that works fully offline

Keyboard (desktop): `Space` pause/resume, `←` / `→` skip, `Esc` end.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The entire app — markup, styles, and timer engine |
| `sw.js` | Service worker; network-first with an offline cache fallback |
| `manifest.json` | PWA manifest and icons |

## Timer engine

Elapsed time is tracked as a **single monotonic value for the whole workout**
(seconds banked, plus time since the current run segment began). The active
phase is resolved by looking that value up in a cumulative offset table.

This is deliberate. `requestAnimationFrame` is throttled or stopped entirely
when the tab is hidden or the screen locks, so a timer that keeps a per-phase
origin and resets it on each transition discards the overrun and then replays
every skipped phase one frame at a time. Deriving the phase from absolute
elapsed time means backgrounding the app for two minutes lands on exactly the
right phase with exactly the right time remaining. Cues are keyed on
`(phase, second)` so each fires at most once, and are suppressed entirely while
catching up after a gap.

The schedule built by `buildPhases()` is the single source of truth: total
duration is summed from it rather than computed by formula, so the advertised
total always matches what actually runs.

## Running locally

```sh
python3 -m http.server 8000
```

Then open <http://127.0.0.1:8000/>. A server (rather than `file://`) is needed
only for the service worker; the timer itself works either way.
