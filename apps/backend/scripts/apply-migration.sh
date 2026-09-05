#!/usr/bin/env bash
#
# Apply one hand-written migration and record it as applied.
#
# `prisma migrate dev` is unusable in this repo: there is no
# prisma/migrations/migration_lock.toml, and docker-entrypoint.sh runs
# `prisma db push` on every container start, so _prisma_migrations is never
# populated by the normal flow. Migrations are therefore hand-written SQL,
# applied with `db execute`, then recorded with `migrate resolve`.
#
# Two traps this script exists to avoid:
#
#   1. `prisma db execute --schema ...` resolves the connection from the schema
#      datasource, which uses `directUrl = env("DIRECT_URL")` — NOT the
#      DATABASE_URL you exported. Passing `--url` explicitly is the only
#      reliable way to target a specific database.
#   2. apps/backend/.env has pointed at production hosts before. The target is
#      printed and confirmed before anything is written.
#
# Usage:
#   scripts/apply-migration.sh <migration_dir_name> [database_url]
#
# With no URL, DATABASE_URL from the environment is used (docker-internal
# hostnames like `postgres:5432` are NOT reachable from the host shell — pass
# localhost:<mapped-port> instead).
#
# Examples:
#   scripts/apply-migration.sh 20260803120000_add_reminder_dispatches \
#       "postgresql://user:pass@localhost:8068/myappdb?schema=public"

set -euo pipefail

MIGRATION="${1:-}"
DB_URL="${2:-${DATABASE_URL:-}}"

if [[ -z "$MIGRATION" ]]; then
  echo "usage: $0 <migration_dir_name> [database_url]" >&2
  exit 2
fi

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="$BACKEND_DIR/prisma/migrations/$MIGRATION/migration.sql"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "error: no migration.sql at $SQL_FILE" >&2
  exit 1
fi

if [[ -z "$DB_URL" ]]; then
  echo "error: no database url given and DATABASE_URL is unset" >&2
  exit 1
fi

# Never print credentials.
REDACTED="$(printf '%s' "$DB_URL" | sed -E 's#://[^@]*@#://***@#')"

echo "migration : $MIGRATION"
echo "target    : $REDACTED"
echo

if [[ "${ASSUME_YES:-}" != "1" ]]; then
  read -r -p "Apply to the database above? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }
fi

cd "$BACKEND_DIR"

echo "==> drift check (informational; nothing is applied from this)"
npx prisma migrate diff \
  --from-url "$DB_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script || true

echo
echo "==> applying $MIGRATION"
npx prisma db execute --url "$DB_URL" --file "$SQL_FILE"

echo "==> recording as applied"
DATABASE_URL="$DB_URL" DIRECT_URL="$DB_URL" \
  npx prisma migrate resolve --applied "$MIGRATION"

echo
echo "done. Remember: DEV and PROD are separate explicit runs."
