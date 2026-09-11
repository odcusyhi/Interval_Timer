#!/usr/bin/env python3
"""Generate synthetic push-up footage for Chromium's fake capture device.

Writes test/pushup.y4m: a textured head travelling between the top and bottom
of a push-up over a static, deliberately busy background. The background is
textured on purpose -- a tracker that only works against a blank wall is not
a tracker.

Requires numpy.  Usage:  python3 test/make-fixture.py
"""
import os
import numpy as np

W, H, FPS, FRAMES = 320, 240, 30, 120
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pushup.y4m')

rng = np.random.default_rng(7)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
bg = 82 + 26 * np.sin(xx * 0.06) + 16 * np.sin(yy * 0.13) + rng.normal(0, 7, (H, W))


def frame(cy):
    img = bg.copy()
    cx, rw, rh = 160.0, 56.0, 70.0
    ell = ((xx - cx) / rw) ** 2 + ((yy - cy) / rh) ** 2 <= 1.0
    img[ell] = 150.0
    img[ell & (yy < cy - rh * 0.52)] = 34.0                      # hair
    for ex in (cx - 22, cx + 22):                                # eyes
        img[(((xx - ex) / 13.0) ** 2 + ((yy - (cy - 8)) / 8.0) ** 2 <= 1.0) & ell] = 238.0
        img[(((xx - ex) / 5.5) ** 2 + ((yy - (cy - 8)) / 5.5) ** 2 <= 1.0) & ell] = 24.0
    img[((np.abs(xx - cx) < 3) & (yy > cy - 6) & (yy < cy + 18)) & ell] = 96.0   # nose
    img[((np.abs(yy - (cy + 38)) < 3) & (np.abs(xx - cx) < 22)) & ell] = 70.0    # mouth
    img += rng.normal(0, 4, (H, W))
    return np.clip(img, 0, 255).astype(np.uint8)


def main():
    chroma = np.full((H // 2, W // 2), 128, np.uint8).tobytes()
    with open(OUT, 'wb') as f:
        f.write(b"YUV4MPEG2 W%d H%d F%d:1 Ip A1:1 C420\n" % (W, H, FPS))
        for i in range(FRAMES):
            cy = 120 + 46 * np.sin(i / 60.0 * 2 * np.pi)   # 2-second push-up cycle
            f.write(b"FRAME\n")
            f.write(frame(cy).tobytes())
            f.write(chroma)
            f.write(chroma)
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")


if __name__ == '__main__':
    main()
