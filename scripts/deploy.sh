#!/bin/bash
# Runs on the server, not locally — pulls whatever's on GitHub's main branch
# and brings the running app up to match it. Triggered remotely by
# `npm run deploy` (see package.json), which is the only piece that
# actually SSHes in; this script itself is what runs once it's there.
set -e

cd "$(dirname "$0")/.."

git pull
npm install
npm run build
systemctl restart playlister

# Cloudflare caches static assets (bundle.js/bundle.css) at its edge by
# default even with no origin cache-control guidance — a stale copy served
# there once bit a real deploy (the Events tab didn't show up for ~20
# minutes despite the origin already having the new file). Purging on every
# deploy keeps that from happening again. Best-effort: a purge failure
# shouldn't fail the whole deploy — the app itself is already updated by
# this point regardless.
set -a
source .env
set +a
if [ -n "$CLOUDFLARE_API_TOKEN" ] && [ -n "$CLOUDFLARE_ZONE_ID" ]; then
  PURGE_RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"purge_everything":true}')
  echo "[deploy] cloudflare cache purge: $PURGE_RESULT"
else
  echo "[deploy] skipping cache purge — CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID not set"
fi

echo "[deploy] done — $(git log -1 --oneline)"
