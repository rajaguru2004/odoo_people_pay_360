#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Bring the e2e database up (and seeded) or tear it down.
#
#   scripts/e2e-db.sh up     — start Postgres, push the schema, seed
#   scripts/e2e-db.sh down   — stop and remove it
#   scripts/e2e-db.sh reset  — down, then up
#
# Starts the DATABASE ONLY. The backend is run separately with .env.test loaded,
# so a developer can restart the API without losing the database, and so the
# suite can point at a locally-run backend it can attach a debugger to:
#
#   cd apps/backend && set -a && . ./.env.test && set +a && npm run start:prod
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.test.yml"
BACKEND="$ROOT/apps/backend"
ENV_TEST="$BACKEND/.env.test"
ACTION="${1:-up}"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

down() {
  echo "🛑 Stopping the e2e database..."
  compose down --remove-orphans
}

up() {
  if [[ ! -f "$ENV_TEST" ]]; then
    echo "❌ $ENV_TEST is missing." >&2
    echo "   Copy it first:  cp apps/backend/.env.test.example apps/backend/.env.test" >&2
    exit 1
  fi

  echo "🐘 Starting the e2e Postgres..."
  compose up -d

  echo "⏳ Waiting for it to accept connections..."
  # Poll the container's own healthcheck rather than sleeping a fixed number of
  # seconds — a cold image start and a warm one differ by an order of magnitude,
  # and a fixed sleep is either flaky or wasteful.
  for _ in $(seq 1 40); do
    if [[ "$(compose ps --format json postgres-test | grep -c '"Health":"healthy"' || true)" != "0" ]]; then
      break
    fi
    sleep 1
  done

  echo "📐 Pushing the schema..."
  ( cd "$BACKEND" && set -a && . ./.env.test && set +a && npx prisma db push --skip-generate )

  echo "🌱 Seeding..."
  ( cd "$BACKEND" && set -a && . ./.env.test && set +a && npm run prisma:seed )

  # The bootstrap seed makes admin, hr.manager and employee1. global-setup.ts
  # also signs in as manager@company.com, which only the e2e baseline creates —
  # and the baseline is layered ON TOP of the bootstrap seed (it fails without
  # the HRD department and HO branch), so the order here is load-bearing.
  echo "🌱 Seeding the e2e baseline..."
  ( cd "$BACKEND" && set -a && . ./.env.test && set +a && npm run prisma:seed:e2e )

  echo "✅ e2e database ready on port 8174."
}

case "$ACTION" in
  up)    up ;;
  down)  down ;;
  reset) down; up ;;
  *)     echo "usage: $0 {up|down|reset}" >&2; exit 1 ;;
esac
