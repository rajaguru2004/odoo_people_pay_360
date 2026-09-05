import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  /**
   * Build output directory. `.next` unless told otherwise.
   *
   * Overridable because the build directory is SHARED STATE that ports do not
   * isolate. A dev server and a second `next build` in the same checkout fight
   * over it: the build fails outright with "Unable to acquire lock", or — worse,
   * because it is silent — the running server keeps serving HTML naming chunk
   * hashes that the other build has just replaced, every chunk answers 500, and
   * the app renders a blank "Loading..." for ever.
   *
   * The user-manual pipeline sets `NEXT_DIST_DIR` so it can build and serve
   * without touching whatever else is running from this checkout. Nothing else
   * sets it, so every existing command behaves exactly as before.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Emit a self-contained server bundle at <distDir>/standalone/ for Docker
  // deployments. This eliminates node_modules from the production image (≈60%
  // size reduction). No application code or behaviour is changed by this setting.
  output: 'standalone',
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
    ],
  },

  // Anything no page or asset claims is proxied to the backend.
  //
  // This is what lets ONE public https tunnel serve the whole dev loop: the
  // handset opens /verify/<token> (a page here), the page's relative API calls
  // fall through to the backend, and the Evolution webhook posting to
  // /whatsapp/webhook falls through the same way. Without it the free ngrok
  // plan needs a second tunnel, and its one static domain cannot cover both.
  //
  // A FALLBACK, so it can never shadow a real route — it only fires after the
  // filesystem (pages, assets, api routes) has failed to match.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        {
          source: '/:path*',
          // Resolution order matters. BACKEND_INTERNAL_URL is for a private
          // network hop; NEXT_PUBLIC_API_URL is the address the browser
          // already uses, so honouring it keeps a split deployment working
          // with the ONE variable that is set everywhere. localhost is last
          // and is a developer default only — it used to be the sole fallback,
          // and a managed host cannot proxy to a private address, so the
          // /verify page 404'd with DNS_HOSTNAME_RESOLVED_PRIVATE on every
          // deployment where the API is not the portal.
          destination: `${
            process.env.BACKEND_INTERNAL_URL ??
            process.env.NEXT_PUBLIC_API_URL ??
            'http://localhost:3001'
          }/:path*`,
        },
      ],
    };
  },

  // Optimize bundle splitting
  experimental: {
    // Turbopack's persistent dev cache is on by default in Next 16. On this
    // app it grew to ~900MB under .next/dev and every compile spent ~70s
    // writing it back out, which pegged CPU/RAM and made `next dev` look like
    // it hung on "Compiling / ...". Dev only — builds are unaffected.
    turbopackFileSystemCacheForDev: false,

    // Optimize package imports - only import what's used.
    // 'lucide-react' and 'date-fns' are omitted: Next already includes them in
    // its own default list. @fullcalendar/* are omitted too — barrel-analysing
    // six calendar packages costs compile time on every route for a gain that
    // only two routes ever see.
    optimizePackageImports: [
      'recharts',
      'framer-motion',
    ],
  },
};

export default nextConfig;
