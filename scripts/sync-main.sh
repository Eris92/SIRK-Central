#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REMOTE="${SIRK_SYNC_REMOTE:-origin}"
BASE_BRANCH="${SIRK_SYNC_BASE_BRANCH:-main}"
EXPECTED_BRANCH="${SIRK_SYNC_EXPECTED_BRANCH:-}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail "git is required."
[[ -d .git ]] || fail "Run from a Git working tree."

current_branch="$(git branch --show-current)"
[[ -n "$current_branch" ]] || fail "Detached HEAD is not supported."
[[ "$current_branch" != "$BASE_BRANCH" ]] || fail "Refusing to merge $BASE_BRANCH into itself. Run this script on a feature or fix branch."
[[ -z "$EXPECTED_BRANCH" || "$current_branch" == "$EXPECTED_BRANCH" ]] || fail "Expected branch $EXPECTED_BRANCH, current branch is $current_branch."
[[ -z "$(git status --porcelain)" ]] || fail "Working tree must be clean."

git fetch --prune "$REMOTE" "$BASE_BRANCH"
base_ref="$REMOTE/$BASE_BRANCH"

if git merge-base --is-ancestor "$base_ref" HEAD; then
  printf '%s is already integrated into %s.\n' "$base_ref" "$current_branch"
  exit 0
fi

backup_branch="backup/${current_branch//\//-}-before-${BASE_BRANCH//\//-}-sync-$(date -u +%Y%m%dT%H%M%SZ)"
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

  for conflict in "${conflicts[@]}"; do
    case "$conflict" in
      package.json|package-lock.json) ;;
      *)
        printf 'Unexpected conflict: %s\n' "$conflict" >&2
        git merge --abort || true
        fail "Merge aborted. Only package.json and package-lock.json may be resolved automatically."
        ;;
    esac
  done

  git checkout --ours -- package.json package-lock.json
  git add package.json package-lock.json
  git commit --no-edit
fi

node - <<'NODE'
const pkg = require('./package.json');
const lock = require('./package-lock.json');
if (pkg.main !== 'src/server-v15.js') throw new Error('Main sync changed canonical runtime.');
if (!String(pkg.scripts.start || '').includes('src/server-v15.js')) throw new Error('Main sync changed npm start.');
if (pkg.scripts['start:legacy']) throw new Error('Main sync restored the legacy start entrypoint.');
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('Package versions differ after main sync.');
NODE

node scripts/validate-no-legacy-runtime.js

printf 'Main synchronization completed.\n'
printf 'HEAD=%s\n' "$(git rev-parse HEAD)"
printf 'Safety branch=%s\n' "$backup_branch"
printf 'Next: npm ci && npm run check:syntax && npm test && git push %s %s\n' "$REMOTE" "$current_branch"
