#!/bin/sh
# Copy the current local version to the VPS and (re)start it. No GitHub needed.
#   tools/deploy.sh <ssh host> staging   → the staging copy (try it there first)
#   tools/deploy.sh <ssh host> live      → the live site
# The server keeps its own settings in /opt/fckscrn/deploy/.env (domains, COMPOSE_FILE) and secrets in
# server/.env.local; neither is ever uploaded. Single-instance servers: see DEPLOY.md.
set -eu
HOST="$1"; TARGET="${2:-staging}"
cd "$(dirname "$0")/.."
case "$TARGET" in
  staging) DIR=/opt/fckscrn-staging; SERVICES="staging"
           # its compose settings are read from the live folder: keep that one file in sync
           rsync -az deploy/docker-compose.staging.yml "$HOST:/opt/fckscrn/deploy/" ;;
  live)    DIR=/opt/fckscrn;         SERVICES="fckscrn caddy" ;;
  *) echo "usage: tools/deploy.sh <host> staging|live" >&2; exit 1 ;;
esac
rsync -az --delete \
  --include server/.env.example --exclude node_modules --exclude server/data --exclude '.env*' \
  --exclude .git --exclude '*.log' \
  ./ "$HOST:$DIR/"
ssh "$HOST" "cd /opt/fckscrn/deploy && docker compose up -d --build $SERVICES && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; docker compose ps"
