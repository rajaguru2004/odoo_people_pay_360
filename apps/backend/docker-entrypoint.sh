#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Backend Docker Entrypoint
#
# Execution order:
#   1. prisma db execute prisma/db-push-preflight.sql — constraints db push
#      refuses to add on its own (idempotent, safe on every start)
#   2. prisma db push  — applies schema changes (idempotent, safe on every start)
#   3. node dist/prisma/seed.js — upserts seed data (upsert guards prevent
#      duplicates) and runs the one-time data repairs at its tail, each guarded
#      by its own marker row (see prisma/backfill-schedule-timezone.ts)
#   4. node dist/src/main — starts the NestJS production server
#
# `exec` replaces the shell process with Node so Docker signals (SIGTERM on
# `docker stop`) are delivered correctly to the running server.
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "=============================================="
echo "  ESS Portal — Backend Container Starting"
echo "=============================================="

echo ""
echo "🧭  Step 1/4 — Applying pre-flight DDL..."
# `db push` will not add a UNIQUE constraint to a table that already has rows —
# it cannot prove the rows are duplicate-free, so it bails out asking for
# --accept-data-loss. That flag is not the answer: it is global, and would also
# authorise silent column/table drops on every future schema change. The
# pre-flight script applies those constraints itself (idempotently, and aborting
# with a readable message if real duplicates exist), after which `db push` sees
# no diff and runs clean. See prisma/db-push-preflight.sql.
npx prisma db execute \
  --schema=./prisma/schema.prisma \
  --file=./prisma/db-push-preflight.sql

echo ""
echo "🔄  Step 2/4 — Applying Prisma schema (db push)..."
npx prisma db push --schema=./prisma/schema.prisma

echo ""
echo "🌱  Step 3/4 — Running database seed..."
# The COMPILED seed, not `ts-node prisma/seed.ts`.
#
# The runner image ships dist/ but not src/, and the seed shares its library
# defaults with the app (src/library-items/library-defaults.ts) so the two can
# never drift. ts-node would try to resolve that import against a src/ that is
# not in the image; the compiled seed already points at dist/src/, which is.
# `nest build` emits dist/prisma/seed.js from prisma/seed.ts, mirroring the same
# dist/src/main layout the server below is started from.
node dist/prisma/seed.js

echo ""
echo "🚀  Step 4/4 — Starting NestJS server on port 3001..."
exec node dist/src/main
