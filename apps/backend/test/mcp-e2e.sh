#!/usr/bin/env bash
#
# MCP end-to-end regression suite runner.
#
# Runs the three MCP e2e specs (catalog/reads, business flows, RBAC/audit/edge)
# against the DEV database. apps/backend/.env points at PRODUCTION, so this
# script requires an explicit dev DATABASE_URL and refuses to touch prod.
#
#   Local:  DATABASE_URL=postgres://user:pass@dev-host:port/db bash test/mcp-e2e.sh
#   CI:     set DATABASE_URL / DIRECT_URL as pipeline secrets, then run.
#
# If DATABASE_URL is unset, it defaults to the known dev DB (creds already in
# docker-compose.yml — not secrets).
set -euo pipefail

DEV_DB_HOST="80.225.236.50:8068"
DEFAULT_DEV_DB="postgresql://postgres:postgres@${DEV_DB_HOST}/myappdb"

export DATABASE_URL="${DATABASE_URL:-$DEFAULT_DEV_DB}"
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"

if [[ "$DATABASE_URL" != *"$DEV_DB_HOST"* ]]; then
  echo "❌ Refusing to run: DATABASE_URL is not the dev DB ($DEV_DB_HOST)." >&2
  echo "   The MCP e2e suite performs writes/deletes — never run it against production." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
echo "▶ MCP e2e against ${DATABASE_URL%%@*}@${DEV_DB_HOST}"
exec npm run test:mcp
