import { renderVerifyPage } from './verify-page.html';
import { VerifyPageController } from './verify-page.controller';

/**
 * The verification page is served by the API, not the portal.
 *
 * That is the whole point: the page and the endpoints it calls share an origin,
 * so nothing in the browser has to be told an API address. The previous
 * arrangement — page on the portal, API on another host — failed on every split
 * deployment with
 *
 *     GET https://hrm.example.com/channel/verify/<token>
 *     404  X-Vercel-Error: DNS_HOSTNAME_RESOLVED_PRIVATE
 *
 * because the portal's catch-all proxy fell back to localhost.
 */
describe('verification page served by the API', () => {
  const TOKEN = '_tRt4c8RRO_3FP0rcXEg3LqJUTOOzDu-5MyxBamI3I4';

  describe('the document', () => {
    const html = renderVerifyPage(TOKEN);

    it('calls the API on a relative path, never an absolute host', () => {
      // An absolute host here would reintroduce the configuration this removes.
      expect(html).toContain("'/channel/verify/'");
      expect(html).not.toMatch(/https?:\/\/[^"' ]*\/channel\/verify/);
    });

    it('names no environment variable or hard-coded backend', () => {
      expect(html).not.toContain('NEXT_PUBLIC_API_URL');
      expect(html).not.toContain('localhost');
    });

    it('carries the token as data, not interpolated into script', () => {
      // A token spliced into JS could terminate the script context.
      expect(html).toContain(`data-token="${TOKEN}"`);
      expect(html).toContain('dataset.token');
    });

    it('escapes a token that tries to break out of the attribute', () => {
      const nasty = renderVerifyPage('"><script>alert(1)</script>');
      expect(nasty).not.toContain('<script>alert(1)</script>');
      expect(nasty).toContain('&quot;&gt;&lt;script&gt;');
    });

    it('fetches nothing from a third party', () => {
      // It is opened by somebody standing outside on a phone; every asset it
      // needs is in the document.
      expect(html).not.toMatch(/src="https?:\/\//);
      expect(html).not.toMatch(/href="https?:\/\//);
    });

    it('asks for location the same way the portal page did', () => {
      expect(html).toContain('enableHighAccuracy: true');
      expect(html).toContain('timeout: 10000');
      expect(html).toContain('Location permission is required to check in');
    });

    it('sends a JPEG, not a multi-megabyte PNG', () => {
      expect(html).toContain("toDataURL('image/jpeg'");
    });

    it('uses the server-formatted time rather than the browser zone', () => {
      // Formatting here would use the phone's timezone and disagree with chat.
      expect(html).toContain('d.atLabel');
      expect(html).not.toContain('toLocaleTimeString');
    });

    it('keeps every distinct reason for an unusable link', () => {
      for (const reason of ['expired', 'used', 'replaced', 'unknown']) {
        expect(html).toContain(`${reason}:`);
      }
      expect(html).toContain('A newer link was sent');
    });

    it('warns instead of silently failing on an insecure origin', () => {
      // getUserMedia needs a secure context; without this the camera simply
      // never opens and the page looks broken.
      expect(html).toContain('window.isSecureContext');
    });
  });

  describe('the route', () => {
    const controller = new VerifyPageController();
    const res = () => {
      const r: any = {};
      r.send = jest.fn().mockReturnValue(r);
      return r;
    };

    it('serves the page for any token shape', () => {
      const r = res();
      controller.page(TOKEN, r);
      expect(r.send).toHaveBeenCalledTimes(1);
      expect(r.send.mock.calls[0][0]).toContain('data-token');
    });

    it('serves a page for an unknown token too', () => {
      // A page that appeared only for live tokens would confirm which exist.
      const r = res();
      controller.page('not-a-real-token', r);
      expect(r.send).toHaveBeenCalledTimes(1);
    });

    it('renders identically whether or not the token is real', () => {
      // The document must carry no verdict: the script asks for it, so the page
      // itself cannot be used to probe which tokens exist.
      const good = res();
      const bad = res();
      controller.page(TOKEN, good);
      controller.page(TOKEN, bad);
      expect(good.send.mock.calls[0][0]).toBe(bad.send.mock.calls[0][0]);
    });

    it('embeds no verdict about the token', () => {
      const r = res();
      controller.page(TOKEN, r);
      const html = r.send.mock.calls[0][0];
      expect(html).not.toMatch(/"valid"\s*:/);
      expect(html).not.toMatch(/employeeId|userId|identityId/);
    });
  });

  describe('the camera matches the portal component', () => {
    const html = renderVerifyPage(TOKEN);

    it('mirrors the preview, and captures what the employee framed', () => {
      // An unmirrored capture is a different image from the one they saw.
      expect(html).toContain('video.mirror { transform: scaleX(-1); }');
      expect(html).toContain('ctx.scale(-1, 1)');
    });

    it('downscales to the same 720px cap at the same quality', () => {
      expect(html).toContain('MAX_CAPTURE_WIDTH = 720');
      expect(html).toContain("toDataURL('image/jpeg', 0.8)");
    });

    it('draws the dashed face guide at the component\'s size', () => {
      expect(html).toContain('width: 176px; height: 224px');
      expect(html).toContain('dashed');
    });

    it('shows the scanning overlay while a photo is being checked', () => {
      expect(html).toContain('Scanning faces...');
      expect(html).toContain('backdrop-filter: blur(1px)');
    });

    it('waits for metadata before enabling the shutter', () => {
      // videoWidth is 0 until then, and a capture taken early is a blank frame.
      expect(html).toContain('onloadedmetadata');
      expect(html).toContain('Opening the camera...');
    });

    it('offers the flip control', () => {
      expect(html).toContain('Flip the camera');
    });

    it('uses the component\'s own wording for each camera failure', () => {
      expect(html).toContain('You need to allow camera access');
      expect(html).toContain('Camera not found');
      expect(html).toContain("'Error opening camera: '");
    });

    it('offers a retry that restarts the camera', () => {
      expect(html).toContain('camRetry');
      expect(html).toContain('>Retry<');
    });
  });

});
