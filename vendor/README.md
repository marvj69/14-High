# Vendored dependencies

These files are served locally (no third-party CDNs, so the Content-Security-Policy
in `vercel.json` can stay strict) and precached by `service-worker.js` for offline use.

## Fonts

- `fontawesome/` — Font Awesome Free 5.15.4 (`css/all.min.css` and `webfonts/`),
  byte-identical to the cdnjs/npm release (the CSS matches the cdnjs SRI hash).
  Icons: CC BY 4.0, fonts: SIL OFL 1.1, code: MIT.
- `fonts/` — Inter v20 from Google Fonts (`family=Inter:wght@400;500;600;700;800`),
  all seven unicode-range subsets. `inter.css` is Google's stylesheet with only the
  URLs changed. SIL OFL 1.1.

## QR libraries

`html5-qrcode.min.js` is loaded on demand when Import from QR opens.

## Local html5-qrcode camera-resolution patch

`html5-qrcode.min.js` has a small patch in `foreverScan`. Upstream draws each
camera frame into a canvas sized to the CSS preview/QR region. On narrow phones,
this reduces an HD image to roughly 300 pixels across and prevents dense game
QR codes from decoding even when the camera image is sharp.

The patch keeps the existing source crop, sizes the decoder canvas from the
source video crop (capped at 1280 pixels on the longest edge), and draws into that resolution.
It resets the canvas transform before each new frame so a previous mirrored
scan does not affect the next frame. Preview layout and the decoder stay the
same. The browser regression test exercises the actual patched video pipeline
with a dense multipart game at a 390-pixel mobile viewport.

Preserve or re-evaluate this patch when replacing the library. Because each frame
is redrawn unmirrored, the library's flipped retry would decode identical pixels,
so the app passes `disableFlip: true`.

The QR renderer in `app.js` reads qrcodejs's `_oQRCode` matrix to render crisp
modules with a four-module quiet zone, and replaces the instance's `_oDrawing` with
a no-op so qrcodejs skips its own canvas drawing and PNG export for every frame;
recheck both when updating qrcodejs.

The `stop()` cleanup also skips the canvas and paused overlay if they have not been created yet. The library's
`start()` promise resolves before the video's `playing` event creates that
canvas. Closing during a delayed permission response must still stop the
stream. App cleanup uses `getState()` instead of the later `isScanning` flag.
The video surface ignores a late `playing` event and handles an interrupted `play()` promise after closure. The browser test covers closing and reopening before that camera resolves.
