#!/bin/sh
# Pushes each sibling repo's own schema to the shared Postgres, then starts
# the composed server. Both steps are idempotent, so restarts are safe.
set -e

echo "[entrypoint] Pushing ehr-bridge schema..."
(cd /app/ehr-bridge && yarn db:push)

echo "[entrypoint] Seeding ehr-bridge synthetic data..."
(cd /app/ehr-bridge && yarn seed)

echo "[entrypoint] Pushing sentinel schema (sentinel_registry, sentinel_core)..."
(cd /app/sentinel && yarn db:push)

echo "[entrypoint] Starting Sentinel Stack..."
exec "$@"
