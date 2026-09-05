#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run the backend's supertest specs against the E2E database.
#
# The env file is loaded HERE rather than left to Jest, because the backend's
# own `test:e2e` script would otherwise pick up `.env` — the DEV database — and
# these specs create, approve and delete real rows. Pointing them at the
# database you are working in would quietly rewrite it.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/apps/backend"
ENV_TEST="$BACKEND/.env.test"

if [[ ! -f "$ENV_TEST" ]]; then
  echo "❌ $ENV_TEST is missing." >&2
  echo "   Copy it first:  cp apps/backend/.env.test.example apps/backend/.env.test" >&2
  exit 1
fi

# Refuse to run if the loaded DATABASE_URL is not the e2e one. A copied-and-
# edited .env.test pointing at the dev port is the one mistake that would make
# this destructive, and it is cheap to rule out.
set -a
# shellcheck disable=SC1090
. "$ENV_TEST"
set +a

if [[ "${DATABASE_URL:-}" != *"8174"* ]]; then
  echo "❌ .env.test does not point at the e2e database (port 8174)." >&2
  echo "   DATABASE_URL=$DATABASE_URL" >&2
  echo "   Refusing to run — these specs write rows." >&2
  exit 1
fi

cd "$BACKEND"
exec npx jest --config ./test/jest-e2e.json --forceExit "$@"
