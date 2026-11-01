#!/bin/sh
# Publishes a commit of this repo to the public one as a release: its files, and none of the history behind them. The
# public repo's history is one commit per release, each with this repo's files at that commit.
#
#   deploy/publish.sh v0.1.0 [commit]        (commit: main by default)
#
# PUBLIC_REPO names the public repo (binders-io/binders-hub). Needs git and push access to it.
set -eu

version=${1:?Give the release, e.g. v0.1.0}
commit=${2:-main}
public=${PUBLIC_REPO:-binders-io/binders-hub}
here=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sha=$(git -C "$here" rev-parse --verify "$commit^{commit}")
echo "Publishing $commit ($sha) to $public as $version."

# The public repo as it is, or a new one.
if git clone -q "https://github.com/$public.git" "$work/repo" 2>/dev/null && git -C "$work/repo" rev-parse -q --verify HEAD >/dev/null; then
  git -C "$work/repo" ls-files -z | (cd "$work/repo" && xargs -0 rm -f)
else
  rm -rf "$work/repo" && git init -q -b main "$work/repo"
  git -C "$work/repo" remote add origin "https://github.com/$public.git"
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
