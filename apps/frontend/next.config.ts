import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Turbopack's workspace root.
   *
   * This checkout is an npm-workspaces monorepo with node_modules hoisted to
   * the repository root, so `next` itself lives OUTSIDE apps/frontend. Pointing
   * the root at apps/frontend makes every hoisted dependency "outside of the
   * project directory", which Turbopack refuses to compile — the build dies on
   * `./app` with "We couldn't find the Next.js package". The monorepo root is
   * the directory that actually contains both the app and its node_modules.
   */
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },

  /**
   * Build output directory. `.next` unless told otherwise.
   *
   * Overridable because the build directory is SHARED STATE that ports do not
   * isolate. A dev server and a second `next build` in the same checkout fight
   * over it: the build fails outright with "Unable to acquire lock", or — worse,
   * because it is silent — the running server keeps serving HTML naming chunk
   * hashes that the other build has just replaced, every chunk answers 500, and
   * the app renders a blank page for ever. Any secondary pipeline (docs capture,
   * a preview build) should set NEXT_DIST_DIR rather than share `.next`.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // Emit a self-contained server bundle at <distDir>/standalone/ for Docker.
  // This removes node_modules from the production image (~60% smaller). No
  // application behaviour changes.
  output: "standalone",

  images: {
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }],
  },

  /**
   * Anything no page or asset claims is proxied to the backend.
   *
   * A FALLBACK, so it can never shadow a real route — it fires only after the
   * filesystem (pages, assets, route handlers) has failed to match. This is what
   * lets a single public tunnel serve the whole dev loop, and what makes
   * same-origin API calls work when NEXT_PUBLIC_API_URL is left unset.
   *
   * Resolution order matters. BACKEND_INTERNAL_URL is for a private network hop;
   * NEXT_PUBLIC_API_URL is the address the browser already uses, so honouring it
   * keeps a split deployment working off the ONE variable that is set
   * everywhere. localhost is last and is a developer default only — a managed
   * host cannot proxy to a private address.
   */
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        {
          source: "/:path*",
          destination: `${
            process.env.BACKEND_INTERNAL_URL ??
            process.env.NEXT_PUBLIC_API_URL ??
            "http://localhost:3011"
          }/:path*`,
        },
      ],
    };
  },

  experimental: {
    // Turbopack's persistent dev cache is on by default in Next 16. It grows to
    // hundreds of MB and every compile spends real time writing it back out,
    // which makes `next dev` look like it hung on "Compiling / ...". Dev only —
    // builds are unaffected.
    turbopackFileSystemCacheForDev: false,

    // Only import what is used. 'lucide-react' and 'date-fns' are omitted
    // because Next already has them in its own default list.
    optimizePackageImports: ["recharts", "framer-motion"],
  },
};

export default nextConfig;
