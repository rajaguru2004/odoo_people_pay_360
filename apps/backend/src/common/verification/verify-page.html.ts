/**
 * The verification page, served by the API itself.
 *
 * It lived in the Next portal and called the API cross-origin, which meant the
 * browser had to be told the API address before it could make its first call.
 * There is nowhere safe to put that: a build-time env var is wrong the moment
 * the portal is deployed somewhere new, and carrying the address in the link
 * would let a crafted url point the page — and the verification token with it —
 * at any host.
 *
 * Serving the page from the API removes the question. Every call is
 * same-origin, so the page needs no address at all, no CORS, and no build step.
 * The only thing that decides where the link points is the API address the
 * admin typed in settings.
 *
 * Deliberately dependency-free: no bundler, no framework, no network fetch for
 * anything. This page is opened by somebody standing outside on a phone, and
 * every asset it needs is in this string.
 */

/** HTML-escape, for the one value interpolated into the document. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export function renderVerifyPage(token: string): string {
  // The token reaches the script through a data attribute rather than string
  // interpolation into JS, so it cannot terminate the script context.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<title>Continue</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px 16px; background: #f8fafc; color: #1e293b;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 28rem; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 16px; padding: 24px; box-shadow: 0 1px 2px rgba(0,0,0,.05);
  }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .icon {
    width: 40px; height: 40px; border-radius: 12px; background: #eef2ff; color: #4f46e5;
    display: flex; align-items: center; justify-content: center; font-size: 20px; flex: none;
  }
  h1 { margin: 0; font-size: 18px; font-weight: 600; color: #1e293b; }
  .sub { margin: 0; font-size: 14px; color: #64748b; }
  p { margin: 0 0 8px; }
  .muted { color: #64748b; font-size: 14px; }
  .err { color: #be123c; font-size: 14px; }
  .ok { color: #047857; font-size: 14px; font-weight: 500; }
  .warn { background: #fffbeb; color: #92400e; font-size: 14px; padding: 12px; border-radius: 12px; margin-bottom: 16px; }
  .hint { text-align: center; color: #94a3b8; font-size: 12px; margin-top: 12px; }
  button {
    width: 100%; border: 0; border-radius: 12px; background: #4f46e5; color: #fff;
    font: inherit; font-weight: 500; padding: 14px 16px; cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: default; }
  canvas { display: none; }
  .stack > * + * { margin-top: 16px; }
  .hidden { display: none !important; }

  /* ---- camera, matching the portal's WebcamCapture component ---- */
  .cam { display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .frame {
    position: relative; overflow: hidden; border-radius: 16px;
    border: 2px solid #e2e8f0; background: #000; max-width: 100%;
  }
  video { display: block; width: 360px; height: 270px; max-width: 100%; }
  video.mirror { transform: scaleX(-1); }
  /* Dashed oval guide: 224x176, the component's h-56 w-44. */
  .guide { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .guide i { display: block; width: 176px; height: 224px; border: 2px dashed rgba(255,255,255,.6); border-radius: 9999px; }
  .guide.busy i { border-color: #4f46e5; animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
  .scan {
    position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; background: rgba(0,0,0,.4); backdrop-filter: blur(1px);
  }
  .scan p { color: #fff; font-size: 14px; font-weight: 600; margin: 12px 0 0; text-shadow: 0 1px 2px rgba(0,0,0,.5); }
  .spin { width: 40px; height: 40px; border: 4px solid #fff; border-top-color: transparent; border-radius: 9999px; animation: rot 1s linear infinite; }
  .spin.sm { width: 32px; height: 32px; border-width: 3px; }
  @keyframes rot { to { transform: rotate(360deg) } }
  .loading {
    display: flex; align-items: center; justify-content: center; flex-direction: column;
    width: 360px; height: 270px; max-width: 100%; background: #0f172a; color: #fff; gap: 8px;
  }
  .loading p { margin: 0; font-size: 14px; }
  .controls { display: flex; gap: 12px; }
  .controls button { width: auto; padding: 12px 24px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px; justify-content: center; }
  .flip {
    background: #fff !important; color: #1e293b !important; border: 1px solid #e2e8f0 !important;
    padding: 12px !important;
  }
  .camerr {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    border: 2px dashed rgba(190,18,60,.3); background: rgba(255,241,242,.5);
    border-radius: 16px; padding: 32px; gap: 12px;
  }
  .camerr p { color: #be123c; font-size: 14px; text-align: center; margin: 0; }
  .camerr button { background: #be123c; width: auto; padding: 8px 16px; }
  svg { flex: none; }
</style>
</head>
<body>
  <main class="card" data-token="${esc(token)}">
    <div class="head">
      <div class="icon" id="icon">📍</div>
      <div>
        <h1 id="label">Continue</h1>
        <p class="sub">Started from a chat</p>
      </div>
    </div>

    <div id="checking"><p class="muted">Checking your link…</p></div>

    <div id="invalid" class="hidden">
      <p class="err" id="invalidText">This link is not valid.</p>
      <p class="muted" id="invalidHint">Ask for a new one from the chat.</p>
    </div>

    <div id="insecure" class="warn hidden">
      This page needs a secure (https) address to use the camera. Ask your administrator to set
      the API address.
    </div>

    <div id="work" class="stack hidden">
      <p class="err hidden" id="retryMsg"></p>
      <p class="muted" id="instruction"></p>
      <div id="cam" class="cam hidden">
        <div class="frame">
          <video id="video" playsinline autoplay muted class="mirror hidden"></video>
          <div id="loading" class="loading">
            <div class="spin sm"></div>
            <p>Opening the camera...</p>
          </div>
          <div id="guide" class="guide hidden"><i></i></div>
          <div id="scan" class="scan hidden">
            <div class="spin"></div>
            <p>Scanning faces...</p>
          </div>
        </div>
        <div class="controls">
          <button id="shoot" type="button" disabled>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
            <span id="shootText">Take a photo</span>
          </button>
          <button id="flip" class="flip" type="button" title="Flip the camera" aria-label="Flip the camera">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/></svg>
          </button>
        </div>
      </div>

      <div id="camerr" class="camerr hidden">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#be123c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
        <p id="camerrText"></p>
        <button id="camRetry" type="button">Retry</button>
      </div>

      <canvas id="canvas"></canvas>
      <button id="go" type="button">Continue</button>
      <p class="hint">This link works once and expires shortly.</p>
    </div>

    <div id="done" class="hidden">
      <p class="ok" id="doneText">Recorded</p>
      <p class="muted">You can close this page and go back to the chat.</p>
    </div>

    <div id="fatal" class="hidden">
      <p class="err" id="fatalText"></p>
      <p class="muted">Ask for a new link from the chat.</p>
    </div>
  </main>

<script>
(function () {
  var token = document.querySelector('main').dataset.token;
  // Same-origin: the page and the API are the same host by construction.
  var API = '/channel/verify/' + encodeURIComponent(token);

  var $ = function (id) { return document.getElementById(id); };
  var show = function (id) { $(id).classList.remove('hidden'); };
  var hide = function (id) { $(id).classList.add('hidden'); };

  var requires = { face: false, location: false };
  var label = 'Continue';
  var coordsPromise = null;
  var stream = null;
  var cameraReady = false;
  var mirrored = true;
  var MAX_CAPTURE_WIDTH = 720;

  var INVALID = {
    expired: ['This link has expired.', 'Ask for a new one from the chat.'],
    used: ['This link has already been used.', 'Nothing more to do here.'],
    replaced: ['A newer link was sent, so this one is no longer active.',
               'Open the most recent message in the chat instead.'],
    unknown: ['This link is not valid.', 'Ask for a new one from the chat.']
  };

  function invalid(reason) {
    var t = INVALID[reason] || INVALID.unknown;
    $('invalidText').textContent = t[0];
    $('invalidHint').textContent = t[1];
    hide('checking'); hide('work'); show('invalid');
  }

  function fatal(msg) {
    $('fatalText').textContent = msg;
    hide('checking'); hide('work'); show('fatal');
    stopCamera();
  }

  /**
   * Position, requested as soon as the page is usable and then held.
   * enableHighAccuracy is slow on a cold phone, and the capability is
   * single-use — so the photo and the fix have to travel in one request.
   */
  function getCoords() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error('Location services are not supported on this device/browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          });
        },
        function (err) {
          if (err.code === err.PERMISSION_DENIED) {
            reject(new Error('Location permission is required to check in. Please allow location access in your browser settings and try again.'));
          } else if (err.code === err.TIMEOUT) {
            reject(new Error('Could not determine your location in time. Please check your GPS/location settings and try again.'));
          } else {
            reject(new Error('Could not determine your location. Please check your GPS/location settings and try again.'));
          }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  /**
   * Same lifecycle as the portal's WebcamCapture: stop any previous stream,
   * clear the error, and only enable the shutter once metadata has loaded —
   * videoWidth is 0 before that, and a capture taken then is a blank frame.
   */
  function startCamera() {
    stopCamera();
    hide('camerr');
    show('cam');
    show('loading');
    hide('video');
    hide('guide');
    $('shoot').disabled = true;

    return navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 360 }, height: { ideal: 270 }, facingMode: 'user' },
        audio: false
      })
      .then(function (s) {
        stream = s;
        var v = $('video');
        v.srcObject = s;
        v.onloadedmetadata = function () {
          cameraReady = true;
          hide('loading');
          show('video');
          show('guide');
          $('shoot').disabled = false;
        };
      })
      .catch(function (err) {
        // The component's exact wording: each one names a different fix.
        var msg =
          err && err.name === 'NotAllowedError'
            ? 'You need to allow camera access. Please check your browser settings.'
            : err && err.name === 'NotFoundError'
              ? 'Camera not found. Please connect the webcam and try again.'
              : 'Error opening camera: ' + ((err && err.message) || 'unknown');
        $('camerrText').textContent = msg;
        hide('cam');
        show('camerr');
      });
  }

  function capture() {
    var v = $('video'), c = $('canvas');
    // Downscale to the longest-edge cap before encoding. A modern phone reports
    // 1920x1080 here, which is roughly four times the payload against a 1 MB
    // request limit, for no gain in detection quality.
    var scale = Math.min(1, MAX_CAPTURE_WIDTH / (v.videoWidth || MAX_CAPTURE_WIDTH));
    c.width = Math.round((v.videoWidth || 360) * scale);
    c.height = Math.round((v.videoHeight || 270) * scale);

    var ctx = c.getContext('2d');
    // Capture what the employee is actually looking at: the preview is
    // mirrored, so an unmirrored capture is a different image from the one they
    // framed themselves in.
    if (mirrored) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, 0, 0, c.width, c.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // JPEG, not PNG: a PNG selfie is several megabytes on a modern phone.
    return c.toDataURL('image/jpeg', 0.8);
  }

  function setBusy(busy) {
    $('shoot').disabled = busy || !cameraReady;
    $('shootText').textContent = busy ? 'Processing...' : label;
    $('guide').classList.toggle('busy', busy);
    if (busy) { show('scan'); } else { hide('scan'); }
  }

  function submit(image) {
    hide('retryMsg');
    if (requires.face) { setBusy(true); }
    $('go').disabled = true;
    $('go').textContent = 'Working…';

    var chain = requires.location ? (coordsPromise || getCoords()) : Promise.resolve(null);

    chain.then(function (coords) {
      var body = {};
      if (coords) {
        body.latitude = coords.latitude;
        body.longitude = coords.longitude;
        if (coords.accuracy !== undefined) body.accuracy = coords.accuracy;
      }
      if (image) body.image = image;

      return fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (r) { return r.json(); })
        .then(function (out) {
          var d = (out && out.data) || {};
          if (d.ok) {
            // The server's label, already in the EMPLOYEE's timezone. Formatting
            // here would use the browser's zone and disagree with the chat.
            $('doneText').textContent = label + ' recorded' + (d.atLabel ? ' at ' + d.atLabel : '');
            hide('work'); show('done');
            stopCamera();
            return;
          }
          var msg = d.message || 'That was not accepted.';
          if (d.retryable) {
            $('retryMsg').textContent = msg;
            show('retryMsg');
            if (requires.face) { setBusy(false); }
            $('go').disabled = false;
            $('go').textContent = label;
          } else {
            fatal(msg);
          }
        });
    }).catch(function (e) {
      // A location refusal is actionable — the employee changes a browser
      // setting — so it is always retryable rather than terminal.
      $('retryMsg').textContent = (e && e.message) || 'Could not reach the server. Check your connection and try again.';
      show('retryMsg');
      if (requires.face) { setBusy(false); }
      $('go').disabled = false;
      $('go').textContent = label;
      coordsPromise = null;
    });
  }

  fetch(API, { headers: { 'ngrok-skip-browser-warning': 'true' } })
    .then(function (r) { return r.json(); })
    .then(function (out) {
      var d = (out && out.data) || {};
      if (!d.valid) { invalid(d.reason); return; }

      requires = d.requires || { face: false, location: false };
      label = d.purposeLabel || 'Continue';
      $('label').textContent = label;
      $('go').textContent = label;
      $('icon').textContent = requires.face ? '🛡️' : '📍';

      $('instruction').textContent = requires.face && requires.location
        ? 'Take a photo to confirm it is you. Your location is captured at the same time — allow both when your browser asks.'
        : requires.face
          ? 'Take a photo to confirm it is you.'
          : 'Your branch records where you are. Allow location access when your browser asks.';

      if (requires.location) {
        coordsPromise = getCoords();
        // Swallowed here; surfaced on submit, where it is actionable.
        coordsPromise.catch(function () {});
      }

      hide('checking');
      show('work');

      if (requires.face) {
        // The plain button belongs to the location-only flow; the camera has
        // its own shutter, exactly as the portal component does.
        hide('go');
        $('shootText').textContent = label;

        // getUserMedia needs a secure context. Over plain http the camera never
        // opens, which reads as a broken page rather than a misconfiguration.
        if (!window.isSecureContext) {
          show('insecure');
          show('cam');
          $('shoot').disabled = true;
          return;
        }
        startCamera();
        $('shoot').onclick = function () { submit(capture()); };
        $('flip').onclick = function () {
          mirrored = !mirrored;
          $('video').classList.toggle('mirror', mirrored);
        };
        $('camRetry').onclick = function () { cameraReady = false; startCamera(); };
      } else {
        hide('cam');
        $('go').onclick = function () { submit(); };
      }
    })
    .catch(function () { invalid('unknown'); });
})();
</script>
</body>
</html>`;
}
