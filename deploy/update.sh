#!/usr/bin/env bash
# Keeps a server's hub on the newest commit of its branch: fetches it, runs the tests, and when they pass, builds and
# restarts. A commit whose tests fail is left alone (the hub keeps running the last good one) until a newer one comes.
# Run every few minutes by a timer, from the clone it lives in.
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
data=${BINDERS_DATA:-/var/lib/binders}
etc=${BINDERS_ETC:-/etc/binders}
branch=${BINDERS_BRANCH:-main}
cd "$src"

git fetch -q origin "$branch"
next=$(git rev-parse "origin/$branch")
running=$(cat "$data/deployed" 2>/dev/null || true)
[ "$next" = "$running" ] && exit 0
[ "$next" = "$(cat "$data/failed" 2>/dev/null || true)" ] && exit 0

echo "Updating to $next (running ${running:-nothing})."
git checkout -q -f --detach "$next"
# What the image is built from, so the hub can say which commit it runs.
export BINDERS_COMMIT=$next
BINDERS_COMMIT_SUBJECT=$(git log -1 --format=%s "$next")
export BINDERS_COMMIT_SUBJECT
# The repo on GitHub, for Settings to link the commit: origin's address, as a web address.
BINDERS_REPO_URL=$(git remote get-url origin 2>/dev/null | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##; s#^https://[^@/]*@#https://#')
case $BINDERS_REPO_URL in https://*) ;; *) BINDERS_REPO_URL= ;; esac
export BINDERS_REPO_URL
mkdir -p "$data/hub" "$data/redis"
# The hub runs as the image's node user.
chown 1000:1000 "$data/hub"

if ! docker build --target test -t binders-hub:test . >"$data/test.log" 2>&1; then
  echo "$next" >"$data/failed"
  # For the hub to show its admins: the commit, when, what it was, and how the tests ended.
  { echo "$next"; date -u +%Y-%m-%dT%H:%M:%SZ; echo "$BINDERS_COMMIT_SUBJECT"; tail -n 60 "$data/test.log"; } >"$data/hub/update-failed.txt"
  chown 1000:1000 "$data/hub/update-failed.txt" 2>/dev/null || true
  tail -n 40 "$data/test.log"
  echo "Tests failed on $next: still running ${running:-nothing}."
  exit 1
fi

# With a tunnel's settings, the tunnel; without, the hub on a port of this machine for Caddy or nginx.
compose=(-f deploy/compose.yml)
if [ -f "$etc/tunnel.env" ]; then compose+=(--profile tunnel); else compose+=(-f deploy/compose.port.yml); fi
docker compose "${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 180
echo "$next" >"$data/deployed"
rm -f "$data/failed" "$data/hub/update-failed.txt"
docker image prune -f >/dev/null
echo "Running $next."
