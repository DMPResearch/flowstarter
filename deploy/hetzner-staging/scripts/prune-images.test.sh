#!/usr/bin/env bash
# Unit-style tests for prune-images.sh, the image-retention pass
# deploy-slot.sh runs as a preflight and again after every successful
# deploy (2026-09-15 incident: the root disk filled to 100% because nothing
# ever removed an old per-commit image — see prune-images.sh's header).
#
#   bash deploy/hetzner-staging/scripts/prune-images.test.sh
#
# `docker` is replaced by a stub on PATH that reads its fake fleet (running
# containers, images, which `rmi` calls should fail) from plain
# tab-separated files under a throwaway root, so nothing here talks to a
# real daemon. What it proves is the retention rule itself: a running
# container's image survives regardless of age, the N most recent survive
# beyond that, everything else is removed with a non-forced `docker rmi`,
# `--dry-run` removes nothing, and both knobs are readable from
# FLOWSTARTER_OPS_ENV_FILE as well as the real environment.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUNE="${HERE}/prune-images.sh"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  echo "  ok   $1"
}

no() {
  fail=$((fail + 1))
  echo "  FAIL $1"
  [ $# -gt 1 ] && echo "       $2"
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    ok "$label"
  else
    no "$label" "expected to find: ${needle}"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    no "$label" "did not expect to find: ${needle}"
  else
    ok "$label"
  fi
}

# ── A throwaway fleet ────────────────────────────────────────────────────
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/bin" "$ROOT/state"
STATE="$ROOT/state"

# running.txt: containerID<TAB>imageID, one running container per line.
# images.txt:  created<TAB>repo:tag<TAB>imageID, one image per line, any
#              order (the script itself sorts by created).
# rmi_fail.txt: repo:tag values `docker rmi` should refuse (simulates "the
#              daemon says something still needs it").
: >"$STATE/running.txt"
: >"$STATE/images.txt"
: >"$STATE/rmi_fail.txt"
: >"$STATE/rmi_removed.txt"
: >"$STATE/builder_pruned.txt"

cat >"$ROOT/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
if [ "$1" = "ps" ] && [ "$2" = "-q" ]; then
  cut -f1 "$STATE/running.txt"
  exit 0
fi
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  cid="${*: -1}"
  awk -F'\t' -v c="$cid" '$1==c{print $2}' "$STATE/running.txt"
  exit 0
fi
if [ "$1" = "images" ]; then
  # {{.Repository}}:{{.Tag}}\t{{.ID}}, matching the real docker CLI's
  # column order for the format prune-images.sh actually asks for.
  awk -F'\t' '{print $2"\t"$3}' "$STATE/images.txt"
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  id="${*: -1}"
  awk -F'\t' -v i="$id" '$3==i{print $1}' "$STATE/images.txt"
  exit 0
fi
if [ "$1" = "rmi" ]; then
  ref="$2"
  if grep -qxF "$ref" "$STATE/rmi_fail.txt" 2>/dev/null; then
    exit 1
  fi
  echo "$ref" >>"$STATE/rmi_removed.txt"
  exit 0
fi
if [ "$1" = "builder" ] && [ "$2" = "prune" ]; then
  echo "pruned" >>"$STATE/builder_pruned.txt"
  exit 0
fi
exit 0
STUB
chmod +x "$ROOT/bin/docker"

export PATH="$ROOT/bin:$PATH"
export STUB_LOG="$ROOT/stub.log"
export STATE

seed_fleet() {
  # seed_fleet <images-heredoc-content> <running-heredoc-content>
  printf '%s\n' "$1" >"$STATE/images.txt"
  printf '%s\n' "$2" >"$STATE/running.txt"
  : >"$STATE/rmi_fail.txt"
  : >"$STATE/rmi_removed.txt"
  : >"$STATE/builder_pruned.txt"
  : >"$STUB_LOG"
}

# A six-image fleet: sha1 is oldest but backs a running container; sha2..sha6
# are progressively older with nothing running them.
FLEET_IMAGES='2026-09-10T00:00:00.000000000Z	ghcr.io/dmpresearch/flowstarter-main:sha1	sha256:img1
2026-09-15T00:00:00.000000000Z	ghcr.io/dmpresearch/flowstarter-main:sha2	sha256:img2
2026-09-14T00:00:00.000000000Z	ghcr.io/dmpresearch/flowstarter-main:sha3	sha256:img3
2026-09-13T00:00:00.000000000Z	ghcr.io/dmpresearch/flowstarter-main:sha4	sha256:img4
2026-09-12T00:00:00.000000000Z	ghcr.io/dmpresearch/flowstarter-main:sha5	sha256:img5
2026-09-11T00:00:00.000000000Z	ghcr.io/dmpresearch/flowstarter-main:sha6	sha256:img6
2026-09-09T00:00:00.000000000Z	ghcr.io/dmpresearch/flowstarter-main:<none>	sha256:imgnone'
FLEET_RUNNING='c1	sha256:img1'

# ── The retention rule ───────────────────────────────────────────────────
echo "prune-images.sh: keeps the running container's image and the N most recent, removes the rest"
seed_fleet "$FLEET_IMAGES" "$FLEET_RUNNING"
out="$(FLOWSTARTER_IMAGE_KEEP_COUNT=2 bash "$PRUNE" 2>&1)"
rc=$?
removed="$(cat "$STATE/rmi_removed.txt" 2>/dev/null)"

if [ "$rc" -eq 0 ]; then
  ok "exits 0 on a normal pass"
else
  no "exits 0 on a normal pass" "$out"
fi
assert_contains "$out" "keep   (running container)" "the running container's image is called out as kept"
assert_not_contains "$removed" "sha1" "the running container's image (sha1) is never removed, despite being the oldest"
assert_contains "$removed" "sha4" "the 3rd-most-recent unused image (sha4) is removed"
assert_contains "$removed" "sha5" "sha5 is removed"
assert_contains "$removed" "sha6" "the oldest unused image (sha6) is removed"
assert_not_contains "$removed" "sha2" "the most recent unused image (sha2) survives the keep window"
assert_not_contains "$removed" "sha3" "the 2nd-most-recent unused image (sha3) survives the keep window"
assert_not_contains "$removed" ":<none>" "a dangling/untagged row is never handed to docker rmi by reference"
assert_contains "$(cat "$STATE/builder_pruned.txt" 2>/dev/null)" "pruned" "dangling build cache is pruned on a real run"
assert_contains "$(cat "$STUB_LOG")" "docker builder prune -f" "build cache is pruned without -a (dangling only)"
assert_not_contains "$(cat "$STUB_LOG")" "docker rmi sha256" "docker rmi is called by reference (repo:tag), never a bare image ID"

# ── --dry-run removes nothing ────────────────────────────────────────────
echo "prune-images.sh: --dry-run"
seed_fleet "$FLEET_IMAGES" "$FLEET_RUNNING"
out="$(FLOWSTARTER_IMAGE_KEEP_COUNT=2 bash "$PRUNE" --dry-run 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "--dry-run exits 0"
else
  no "--dry-run exits 0" "$out"
fi
assert_contains "$out" "would remove" "--dry-run reports what it would remove"
if [ ! -s "$STATE/rmi_removed.txt" ]; then
  ok "--dry-run never calls docker rmi"
else
  no "--dry-run never calls docker rmi" "$(cat "$STATE/rmi_removed.txt")"
fi
if [ ! -s "$STATE/builder_pruned.txt" ]; then
  ok "--dry-run never prunes build cache"
else
  no "--dry-run never prunes build cache"
fi
assert_not_contains "$out" "[dry-run] [dry-run]" "the dry-run header is not printed twice"
assert_not_contains "$(FLOWSTARTER_IMAGE_KEEP_COUNT=2 bash "$PRUNE" 2>&1)" "[dry-run]" "a real run's header never says [dry-run]"

# ── The keep count is a named, overridable knob ─────────────────────────
echo "prune-images.sh: FLOWSTARTER_IMAGE_KEEP_COUNT"
seed_fleet "$FLEET_IMAGES" "$FLEET_RUNNING"
out="$(bash "$PRUNE" --dry-run 2>&1)"
assert_contains "$out" "keep count: 5" "defaults to 5 with no override (DEFAULT_IMAGE_KEEP_COUNT)"

seed_fleet "$FLEET_IMAGES" "$FLEET_RUNNING"
out="$(FLOWSTARTER_IMAGE_KEEP_COUNT=1 bash "$PRUNE" 2>&1)"
removed="$(cat "$STATE/rmi_removed.txt" 2>/dev/null)"
assert_contains "$removed" "sha3" "a smaller keep count removes more (sha3 now removed too)"

echo "prune-images.sh: rejects a non-numeric keep count"
out="$(FLOWSTARTER_IMAGE_KEEP_COUNT=nope bash "$PRUNE" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "a non-numeric FLOWSTARTER_IMAGE_KEEP_COUNT is rejected"
else
  no "a non-numeric FLOWSTARTER_IMAGE_KEEP_COUNT is rejected" "exited 0"
fi

# ── Overridable through the env file, without touching CI ──────────────
echo "prune-images.sh: FLOWSTARTER_OPS_ENV_FILE"
seed_fleet "$FLEET_IMAGES" "$FLEET_RUNNING"
OPS_ENV="$ROOT/staging-ops.env"
printf 'FLOWSTARTER_IMAGE_KEEP_COUNT=1\n' >"$OPS_ENV"
out="$(FLOWSTARTER_OPS_ENV_FILE="$OPS_ENV" bash "$PRUNE" 2>&1)"
removed="$(cat "$STATE/rmi_removed.txt" 2>/dev/null)"
assert_contains "$out" "keep count: 1" "a keep-count override in the ops env file takes effect"
assert_contains "$removed" "sha3" "the ops-env-file override actually changes what gets removed"
rm -f "$OPS_ENV"

echo "prune-images.sh: a missing ops env file is not an error"
seed_fleet "$FLEET_IMAGES" "$FLEET_RUNNING"
out="$(FLOWSTARTER_OPS_ENV_FILE="$ROOT/does-not-exist.env" bash "$PRUNE" --dry-run 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a missing FLOWSTARTER_OPS_ENV_FILE is silently fine"
else
  no "a missing FLOWSTARTER_OPS_ENV_FILE is silently fine" "$out"
fi

# ── A docker rmi refusal is a soft skip, not a hard failure ─────────────
echo "prune-images.sh: docker refuses to remove an image still in use"
seed_fleet "$FLEET_IMAGES" "$FLEET_RUNNING"
printf 'ghcr.io/dmpresearch/flowstarter-main:sha4\n' >"$STATE/rmi_fail.txt"
out="$(FLOWSTARTER_IMAGE_KEEP_COUNT=2 bash "$PRUNE" 2>&1)"
rc=$?
removed="$(cat "$STATE/rmi_removed.txt" 2>/dev/null)"
if [ "$rc" -eq 0 ]; then
  ok "a single docker rmi refusal does not fail the whole run"
else
  no "a single docker rmi refusal does not fail the whole run" "$out"
fi
assert_contains "$out" "skip" "the refusal is reported as a skip"
assert_not_contains "$removed" "sha4" "the refused image is not recorded as removed"
assert_contains "$removed" "sha5" "the run continues past the refusal and still removes the rest"
assert_contains "$(cat "$STATE/builder_pruned.txt" 2>/dev/null)" "pruned" "build cache is still pruned after a docker rmi refusal"

# ── Bad arguments ─────────────────────────────────────────────────────────
echo "prune-images.sh: argument parsing"
out="$(bash "$PRUNE" --bogus 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "an unknown flag is rejected"
else
  no "an unknown flag is rejected" "exited 0"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
