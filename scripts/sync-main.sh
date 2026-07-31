#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXPECTED_BRANCH="${SIRK_SYNC_EXPECTED_BRANCH:-feat/central-production-hardening}"
REMOTE="${SIRK_SYNC_REMOTE:-origin}"
BASE_BRANCH="${SIRK_SYNC_BASE_BRANCH:-main}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail "git is required."
[[ -d .git ]] || fail "Run from a Git working tree."

current_branch="$(git branch --show-current)"
[[ "$current_branch" == "$EXPECTED_BRANCH" ]] || fail "Expected branch $EXPECTED_BRANCH, current branch is $current_branch."
[[ -z "$(git status --porcelain)" ]] || fail "Working tree must be clean."

git fetch --prune "$REMOTE" "$BASE_BRANCH"
base_ref="$REMOTE/$BASE_BRANCH"

if git merge-base --is-ancestor "$base_ref" HEAD; then
  printf '%s is already integrated into %s.\n' "$base_ref" "$current_branch"
  exit 0
fi

backup_branch="backup/${EXPECTED_BRANCH//\//-}-before-main-sync-$(date -u +%Y%m%dT%H%M%SZ)"
git branch "$backup_branch" HEAD
printf 'Created safety branch: %s\n' "$backup_branch"

set +e
git merge --no-ff --no-edit "$base_ref"
merge_status=$?
set -e

if [[ "$merge_status" -ne 0 ]]; then
  mapfile -t conflicts < <(git diff --name-only --diff-filter=U | sort)
  [[ "${#conflicts[@]}" -gt 0 ]] || {
    git merge --abort || true
    fail "Merge failed without resolvable conflict metadata."
  }

  allowed=(package-lock.json package.json)
  for conflict in "${conflicts[@]}"; do
    allowed_match=false
    for candidate in "${allowed[@]}"; do [[ "$conflict" == "$candidate" ]] && allowed_match=true; done
    if [[ "$allowed_match" != true ]]; then
      printf 'Unexpected conflict: %s\n' "$conflict" >&2
      git merge --abort || true
      fail "Merge aborted. Only package.json and package-lock.json may be resolved automatically."
    fi
  done

  git checkout --ours -- package.json package-lock.json
  git add package.json package-lock.json

  for required in \
    src/persistent-session-map.js \
    src/preload-hardening.js \
    src/server-hardened.js \
    src/server-production.js \
    test/persistent-session-map.test.js; do
    [[ -f "$required" ]] || {
      git merge --abort || true
      fail "Required main compatibility file is missing after conflict resolution: $required"
    }
  done

  git commit --no-edit
fi

node - <<'NODE'
const pkg = require('./package.json');
const lock = require('./package-lock.json');
if (pkg.main !== 'src/server-v15.js') throw new Error('Main sync changed canonical runtime.');
if (!String(pkg.scripts.start || '').includes('server-v15.js')) throw new Error('Main sync changed npm start.');
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('Package versions differ after main sync.');
NODE

printf 'Main synchronization completed.\n'
printf 'HEAD=%s\n' "$(git rev-parse HEAD)"
printf 'Safety branch=%s\n' "$backup_branch"
printf 'Next: npm ci && npm test && git push %s %s\n' "$REMOTE" "$EXPECTED_BRANCH"
