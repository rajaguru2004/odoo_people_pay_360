#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Backend Docker Entrypoint
#
# Execution order:
#   1. prisma db push        — applies schema changes (idempotent, safe on every start)
#   2. node dist/prisma/seed — upserts bootstrap data (upsert guards prevent duplicates)
#   3. node dist/src/main    — starts the NestJS production server
#
# `exec` replaces the shell process with Node so Docker signals (SIGTERM on
# `docker stop`) are delivered to the running server rather than to a shell that
# would ignore them and let the container be killed after the grace period.
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "=============================================="
echo "  People Pay 360 — Backend Container Starting"
echo "=============================================="

echo ""
echo "🔄  Step 1/3 — Applying Prisma schema (db push)..."
npx prisma db push --schema=./prisma/schema.prisma

echo ""
echo "🌱  Step 2/3 — Running database seed..."
# The COMPILED seed, not `ts-node prisma/seed.ts`: the runner image ships dist/
# but not src/, and `nest build` emits dist/prisma/seed.js alongside dist/src/main.
node dist/prisma/seed.js

echo ""
echo "🚀  Step 3/3 — Starting NestJS server on port ${PORT:-3011}..."
exec node dist/src/main
