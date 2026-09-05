#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Builds and serves the frontend for the browser suite.
#
# Two things make this more than `next build && next start`:
#
#  1. `next.config.ts` sets `output: 'standalone'`, and `next start` refuses to
#     serve a standalone build ("next start does not work with output:
#     standalone"). The standalone server has to be run directly.
#
#  2. Standalone output does NOT include the static assets or `public/` — Next
#     expects the deployment step to copy them in, which the Dockerfile does.
#     Without that copy the pages load with no CSS or JS chunks, and every spec
#     fails on a blank screen for a reason that has nothing to do with the app.
#
#  3. This is a monorepo with lockfiles at both the root and apps/frontend, so
#     Next roots the trace at the repo root and the server lands at
#     .next/standalone/apps/frontend/server.js rather than .next/standalone/.
#     The path is resolved below rather than assumed.
#
# NEXT_PUBLIC_API_URL must be set by the caller: it is inlined at BUILD time, so
# it cannot be changed once this script has run.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

: "${NEXT_PUBLIC_API_URL:?NEXT_PUBLIC_API_URL must be set — it is baked in at build time}"
PORT="${PORT:-3400}"

# `next build` does NOT prune `.next/standalone`. A previous build's prerendered
# HTML and RSC payloads survive there, still naming CSS/JS chunk hashes the new
# build never emitted — and the chunk hash changes whenever NEXT_PUBLIC_API_URL
# does, which is exactly what this script varies. The browser then 404s on a
# stylesheet and every strict spec fails on a console error that has nothing to
# do with the app. Start the standalone tree empty.
echo "▸ Building the frontend against ${NEXT_PUBLIC_API_URL}"
rm -rf .next/standalone
npm run build

SERVER_JS="$(find .next/standalone -maxdepth 4 -name server.js -print -quit)"
[ -n "$SERVER_JS" ] || { echo "✖ No standalone server.js produced"; exit 1; }
APP_ROOT="$(dirname "$SERVER_JS")"

echo "▸ Copying static assets into ${APP_ROOT}"
mkdir -p "$APP_ROOT/.next"
# Replace rather than merge: `cp -r src dst` into an EXISTING directory leaves
# the old build's chunks beside the new ones, which is the other half of the
# stale-bundle trap above.
rm -rf "$APP_ROOT/.next/static" "$APP_ROOT/public"
cp -r .next/static "$APP_ROOT/.next/static"
[ -d public ] && cp -r public "$APP_ROOT/public"

echo "▸ Serving on :${PORT}"
cd "$APP_ROOT"
exec env PORT="$PORT" HOSTNAME=127.0.0.1 node server.js
