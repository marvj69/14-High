# Vendored QR dependencies

These scripts are served locally and cached for offline PWA use.

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

Preserve or re-evaluate this patch when replacing the library. The QR renderer
in `index.html` also reads qrcodejs's `_oQRCode` matrix to render crisp modules
with a four-module quiet zone; recheck that API when updating qrcodejs.

The `stop()` cleanup also skips the canvas and paused overlay if they have not been created yet. The library's
`start()` promise resolves before the video's `playing` event creates that
canvas. Closing during a delayed permission response must still stop the
stream. App cleanup uses `getState()` instead of the later `isScanning` flag.
The video surface ignores a late `playing` event and handles an interrupted `play()` promise after closure. The browser test covers closing and reopening before that camera resolves.
