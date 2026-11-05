#!/bin/sh
# Publishes a commit of this repo to the public one as a release: its files, and none of the history behind them. The
# public repo's history is one commit per release, each with this repo's files at that commit.
#
#   deploy/publish.sh v0.1.0 [commit]        (commit: main by default)
#
# PUBLIC_REPO names the public repo (binders-io/binders-hub); PUBLIC_REMOTE, its address, if not on GitHub. Needs git and
# push access to it.
#
# The Helm chart pulls the release's image by default, so its appVersion is the release: when it isn't yet, it's set
# and committed on that branch, and pushed, before anything is published. That takes the branch checked out here.
set -eu

version=${1:?Give the release, e.g. v0.1.0}
commit=${2:-main}
public=${PUBLIC_REPO:-binders-io/binders-hub}
here=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sha=$(git -C "$here" rev-parse --verify "$commit^{commit}")

chart=deploy/helm/binders-hub/Chart.yaml
want=${version#v}
have=$(git -C "$here" show "$sha:$chart" 2>/dev/null | sed -n 's/^appVersion: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p')
if [ -n "$have" ] && [ "$have" != "$want" ]; then
  if [ "$(git -C "$here" symbolic-ref -q --short HEAD)" != "$commit" ] || [ "$(git -C "$here" rev-parse HEAD)" != "$sha" ] || [ -n "$(git -C "$here" status --porcelain)" ]; then
    echo "The Helm chart pulls $have by default, not $want. Check out $commit here, up to date and with nothing changed, and run this again: it sets it."
    exit 1
  fi
  sed "s/^appVersion:.*/appVersion: \"$want\"/" "$here/$chart" > "$work/Chart.yaml" && mv "$work/Chart.yaml" "$here/$chart"
  git -C "$here" commit -q -m "The Helm chart pulls Binders Hub $version by default" -- "$chart"
  git -C "$here" push -q origin "$commit"
  sha=$(git -C "$here" rev-parse HEAD)
  echo "Set the chart's appVersion to $want, on $commit."
fi
echo "Publishing $commit ($sha) to $public as $version."

# The public repo as it is, or a new one.
remote=${PUBLIC_REMOTE:-https://github.com/$public.git}
if git clone -q "$remote" "$work/repo" 2>/dev/null && git -C "$work/repo" rev-parse -q --verify HEAD >/dev/null; then
  git -C "$work/repo" ls-files -z | (cd "$work/repo" && xargs -0 rm -f)
else
  rm -rf "$work/repo" && git init -q -b main "$work/repo"
  git -C "$work/repo" remote add origin "$remote"
fi

# This repo's files at that commit, and nothing untracked.
git -C "$here" archive "$sha" | tar -x -C "$work/repo"

cd "$work/repo"
git add -A
if git diff --cached --quiet; then
  echo "Nothing changed since the last release."
else
  git -c user.name="$(git -C "$here" config user.name)" -c user.email="$(git -C "$here" config user.email)" \
    commit -q -m "Binders Hub $version"
fi
git tag -a "$version" -m "Binders Hub $version"
git push -q origin main "$version"
echo "Published $version: https://github.com/$public/releases/tag/$version"
