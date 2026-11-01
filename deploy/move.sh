#!/usr/bin/env bash
# Moves the hub on this machine to a server set up with compose.yml: the hub's secret (which seals what it keeps,
# GitHub's keys among them), its notes and pictures, and its change log and the rest of its Redis. Stop the hub here
# first. The server's own hub is stopped while it runs and replaced; nothing here is changed.
#
#   deploy/move.sh you@your-server [redis://127.0.0.1:6390]
set -euo pipefail

server=${1:?Usage: deploy/move.sh user@server [redis-url-here]}
redis=${2:-redis://127.0.0.1:6390}
here=$(cd "$(dirname "$0")/.." && pwd)
data=$here/hub/.data
remote=${BINDERS_SRC:-/opt/binders/src}
[ -f "$data/secret" ] || { echo "No hub data in $data."; exit 1; }
if curl -fs -o /dev/null "http://127.0.0.1:${HUB_PORT:-4400}/health"; then echo "The hub here is still running: stop it first."; exit 1; fi

control=$(mktemp -u /tmp/binders-move.XXXXXX)
ssh -o ControlMaster=yes -o ControlPath="$control" -o ControlPersist=120 -fN "$server"
trap 'ssh -o ControlPath="$control" -O exit "$server" 2>/dev/null || true' EXIT
on() { ssh -o ControlPath="$control" "$server" "$@"; }

echo "Stopping the hub there…"
on "cd $remote && sudo docker compose -f deploy/compose.yml stop hub"

echo "Copying the secret and notes…"
on "sudo mkdir -p /var/lib/binders/hub/notes"
rsync -a --delete -e "ssh -o ControlPath=$control" --rsync-path="sudo rsync" "$data/secret" "$server:/var/lib/binders/hub/secret"
rsync -a --delete -e "ssh -o ControlPath=$control" --rsync-path="sudo rsync" "$data/notes/" "$server:/var/lib/binders/hub/notes/"
on "sudo chown -R 1000:1000 /var/lib/binders/hub"

echo "Copying Redis…"
ssh -o ControlPath="$control" -O forward -L 6399:127.0.0.1:6379 "$server"
(cd "$here/hub" && node scripts/copy-redis.ts --from "$redis" --to redis://127.0.0.1:6399 --replace)

echo "Starting the hub there…"
on "cd $remote && sudo docker compose -f deploy/compose.yml start hub"
echo "Moved. Point runners at the new address with --hub."
