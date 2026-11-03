#!/bin/sh
# Copy the current local version to the VPS and (re)start it. No GitHub needed.
# usage: tools/deploy.sh root@<IP> <domain>      e.g. tools/deploy.sh root@1.2.3.4 test.fckscrn.com
# The server needs Docker; server/.env.local on the VPS is kept (never uploaded).
set -eu
HOST="$1"; DOMAIN="$2"
cd "$(dirname "$0")/.."
rsync -az --delete \
  --include server/.env.example --exclude node_modules --exclude server/data --exclude '.env*' \
  --exclude .git --exclude '*.log' \
  ./ "$HOST:/opt/fckscrn/"
# anything but the real domain is a test server: keep it out of search engines
INDEX=on; REDIRECTS="www.fckscrn.com, fckscrn.cz, www.fckscrn.cz"
[ "$DOMAIN" = "fckscrn.com" ] || { INDEX=off; REDIRECTS="http://www.$DOMAIN"; }  # http only: no certificate requested for it
ssh "$HOST" "cd /opt/fckscrn && touch server/.env.local && chmod 600 server/.env.local && cd deploy && DOMAIN=$DOMAIN SEARCH_INDEX=$INDEX REDIRECTS='$REDIRECTS' docker compose up -d --build && docker compose ps"
