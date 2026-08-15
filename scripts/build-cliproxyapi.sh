#!/usr/bin/env bash
# build-cliproxyapi.sh — build, sign, and smoke-check pinned stock CLIProxyAPI.
#
# Usage: scripts/build-cliproxyapi.sh [--check-only] [--fetch-go]
#                                      [--allow-unpinned-go]
#                                      [--handshake-port <port>]
#        scripts/build-cliproxyapi.sh --handshake-only <binary>
#                                      [--handshake-port <port>]
#
# The build ALWAYS uses the checksum-verified official Go toolchain from the
# pin (fetched, or reused from .cache/go-toolchain) — MD_GO_BINARY or a
# PATH-installed go, even at the pinned version, cannot feed a signing build
# unless --allow-unpinned-go is passed explicitly (dev iteration only; never
# for a release artifact).
#
# Produces dist/cliproxyapi/cliproxyapi and manifest.json. Source, release tag,
# Go toolchain, official toolchain checksum, and in-app destination all come
# from scripts/cliproxyapi-pin.json. The current release target is darwin/arm64;
# a universal binary is a deliberate follow-up, not silently synthesized here.
#
# The normal build signs with MD_SIGN_IDENTITY (the same Developer ID setting
# as release-dmg.sh), hardened runtime, secure timestamp, and NO entitlements.
# It then launches the signed binary on an isolated test port and verifies both
# /healthz and an authenticated /v0/management/config handshake.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN_FILE="$REPO_ROOT/scripts/cliproxyapi-pin.json"
PIN_HELPER="$REPO_ROOT/scripts/cliproxyapi-pin.mjs"
OUTPUT_DIR="$REPO_ROOT/dist/cliproxyapi"
OUTPUT_BINARY="$OUTPUT_DIR/cliproxyapi"
OUTPUT_MANIFEST="$OUTPUT_DIR/manifest.json"
DEFAULT_IDENTITY="Developer ID Application: EXAMPLE DEVELOPER (TEAMID1234)"
IDENTITY="${MD_SIGN_IDENTITY:-$DEFAULT_IDENTITY}"

fail() { echo "build-cliproxyapi.sh: ERROR: $*" >&2; exit 1; }
argument_error() { echo "build-cliproxyapi.sh: $*" >&2; exit 2; }

CHECK_ONLY=0
FETCH_GO=0
ALLOW_UNPINNED_GO=0
HANDSHAKE_ONLY=""
HANDSHAKE_PORT=18317
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --fetch-go) FETCH_GO=1 ;;
    --allow-unpinned-go) ALLOW_UNPINNED_GO=1 ;;
    --handshake-only)
      [[ $# -ge 2 ]] || argument_error "--handshake-only requires a binary path"
      HANDSHAKE_ONLY="$2"
      shift
      ;;
    --handshake-port)
      [[ $# -ge 2 ]] || argument_error "--handshake-port requires a port"
      HANDSHAKE_PORT="$2"
      shift
      ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) argument_error "unknown argument: $1" ;;
  esac
  shift
done

[[ "$HANDSHAKE_PORT" =~ ^[1-9][0-9]{3,4}$ ]] \
  || argument_error "--handshake-port must be an integer from 1024 to 65535"
(( HANDSHAKE_PORT >= 1024 && HANDSHAKE_PORT <= 65535 )) \
  || argument_error "--handshake-port must be an integer from 1024 to 65535"
[[ "$HANDSHAKE_PORT" != 8317 ]] \
  || argument_error "--handshake-port must not use CLIProxyAPI's live default port 8317"
if [[ -n "$HANDSHAKE_ONLY" && ( "$CHECK_ONLY" == 1 || "$FETCH_GO" == 1 || "$ALLOW_UNPINNED_GO" == 1 ) ]]; then
  argument_error "--handshake-only cannot be combined with --check-only, --fetch-go, or --allow-unpinned-go"
fi
if [[ "$ALLOW_UNPINNED_GO" == 1 && "$FETCH_GO" == 1 ]]; then
  argument_error "--allow-unpinned-go and --fetch-go are contradictory; pick one"
fi

[[ -f "$PIN_FILE" ]] || fail "pin file missing: $PIN_FILE"
[[ -f "$PIN_HELPER" ]] || fail "pin validator missing: $PIN_HELPER"
PIN_VALUES="$(node "$PIN_HELPER" values "$PIN_FILE")" \
  || fail "CLIProxyAPI pin validation failed"
IFS=$'\t' read -r UPSTREAM_REPOSITORY PIN_TAG PIN_COMMIT GO_VERSION GO_ARCHIVE_SHA256 BUNDLE_PATH <<< "$PIN_VALUES"
[[ -n "$UPSTREAM_REPOSITORY" && -n "$PIN_TAG" && -n "$PIN_COMMIT" \
   && -n "$GO_VERSION" && -n "$GO_ARCHIVE_SHA256" && -n "$BUNDLE_PATH" ]] \
  || fail "pin validator returned incomplete values"
PIN_VERSION="${PIN_TAG#v}"

echo "==> CLIProxyAPI pinned-source build"
echo "    source:      $UPSTREAM_REPOSITORY"
echo "    pin:         $PIN_TAG ($PIN_COMMIT)"
echo "    Go:          $GO_VERSION (official darwin/arm64 archive)"
echo "    target:      darwin/arm64"
echo "    output:      $OUTPUT_BINARY"
echo "    manifest:    $OUTPUT_MANIFEST"
echo "    app path:    $BUNDLE_PATH"
echo "    handshake:   http://127.0.0.1:$HANDSHAKE_PORT"

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo "==> check-only: pin and arguments are valid; would fetch the exact source commit + tag, verify a clean tag/SHA match, build with the pinned Go toolchain, sign with no entitlements, and run the health/management handshake"
  exit 0
fi

[[ "$(uname -s)" == Darwin ]] || fail "the darwin/arm64 release build requires macOS"
[[ "$(uname -m)" == arm64 ]] \
  || fail "the CGO-enabled darwin/arm64 build currently requires an Apple Silicon Mac (universal support is a follow-up)"
command -v git >/dev/null 2>&1 || fail "git is required to fetch pinned source"
command -v curl >/dev/null 2>&1 || fail "curl is required for the live handshake"
command -v node >/dev/null 2>&1 || fail "Node is required to validate the pin"

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/modeldeck-cliproxyapi-build.XXXXXX")"
SOURCE_DIR="$BUILD_DIR/source"
HANDSHAKE_PID=""
cleanup() {
  if [[ -n "$HANDSHAKE_PID" ]]; then
    kill "$HANDSHAKE_PID" >/dev/null 2>&1 || true
    wait "$HANDSHAKE_PID" >/dev/null 2>&1 || true
  fi
  # Go's module cache is extracted read-only; without the chmod the rm fails
  # and, as the EXIT trap's last command, would overwrite a successful build's
  # exit status with 1 (observed on the first live run).
  chmod -R u+w "$BUILD_DIR" 2>/dev/null || true
  rm -rf "$BUILD_DIR" || true
}
trap cleanup EXIT

assert_no_entitlements() {
  local binary="$1" entitlements
  entitlements="$(codesign -d --entitlements :- "$binary" 2>/dev/null || true)"
  if grep -q '<key>' <<< "$entitlements"; then
    fail "signed CLIProxyAPI unexpectedly carries entitlements; #403 requires none until a launch failure and recorded reason prove one necessary"
  fi
}

header_value() {
  local headers="$1" key="$2"
  awk -v key="$key" 'BEGIN { FS = ":[[:space:]]*" } tolower($1) == tolower(key) { gsub(/\r/, "", $2); print $2; exit }' "$headers"
}

run_handshake() {
  local binary="$1" handshake_dir config log headers body ready reported_commit reported_version
  [[ -f "$binary" && -x "$binary" ]] || fail "handshake binary is not executable: $binary"
  # The binary launches from an isolated config dir, so a relative path would
  # resolve against that dir and die with a misleading "no such file".
  binary="$(realpath "$binary")" || fail "could not resolve handshake binary path"
  command -v codesign >/dev/null 2>&1 || fail "codesign is required to verify the handshake binary"
  codesign --verify --strict --verbose=2 "$binary" \
    || fail "handshake binary does not have a valid code signature: $binary"
  assert_no_entitlements "$binary"

  handshake_dir="$BUILD_DIR/handshake"
  config="$handshake_dir/config.yaml"
  log="$handshake_dir/cliproxyapi.log"
  headers="$handshake_dir/management.headers"
  body="$handshake_dir/management.body"
  mkdir -p "$handshake_dir/auth" "$handshake_dir/home" "$handshake_dir/tmp"
  cat > "$config" <<EOF
host: "127.0.0.1"
port: $HANDSHAKE_PORT
remote-management:
  allow-remote: false
  secret-key: "modeldeck-build-management-placeholder"
  disable-control-panel: true
  disable-auto-update-panel: true
auth-dir: "$handshake_dir/auth"
api-keys:
  - "modeldeck-build-client-placeholder"
debug: false
logging-to-file: false
usage-statistics-enabled: false
plugins:
  enabled: false
EOF

  echo "==> launching signed CLIProxyAPI for isolated handshake"
  (
    cd "$handshake_dir"
    exec /usr/bin/env -i \
      HOME="$handshake_dir/home" \
      PATH=/usr/bin:/bin \
      TMPDIR="$handshake_dir/tmp" \
      LC_ALL=C \
      "$binary" -config "$config" -local-model
  ) >"$log" 2>&1 &
  HANDSHAKE_PID=$!
  ready=0
  for _ in {1..100}; do
    if curl --fail --silent --show-error --max-time 1 \
      "http://127.0.0.1:$HANDSHAKE_PORT/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    kill -0 "$HANDSHAKE_PID" >/dev/null 2>&1 || {
      sed 's/^/    /' "$log" >&2
      fail "CLIProxyAPI exited before /healthz became ready"
    }
    sleep 0.1
  done
  [[ "$ready" == 1 ]] || {
    sed 's/^/    /' "$log" >&2
    fail "timed out waiting for CLIProxyAPI /healthz on port $HANDSHAKE_PORT"
  }

  curl --fail --silent --show-error --max-time 5 \
    --header "Authorization: Bearer modeldeck-build-management-placeholder" \
    --dump-header "$headers" --output "$body" \
    "http://127.0.0.1:$HANDSHAKE_PORT/v0/management/config" \
    || fail "authenticated CLIProxyAPI management handshake failed"
  [[ -s "$body" ]] || fail "management handshake returned an empty body"
  reported_commit="$(header_value "$headers" X-CPA-COMMIT)"
  reported_version="$(header_value "$headers" X-CPA-VERSION)"
  [[ "$reported_commit" == "$PIN_COMMIT" ]] \
    || fail "management handshake reported commit '${reported_commit:-missing}', expected $PIN_COMMIT"
  [[ "$reported_version" == "$PIN_VERSION" ]] \
    || fail "management handshake reported version '${reported_version:-missing}', expected $PIN_VERSION"

  kill "$HANDSHAKE_PID"
  wait "$HANDSHAKE_PID" >/dev/null 2>&1 || true
  HANDSHAKE_PID=""
  echo "==> handshake OK: /healthz + authenticated /v0/management/config ($PIN_VERSION, $PIN_COMMIT)"
}

if [[ -n "$HANDSHAKE_ONLY" ]]; then
  run_handshake "$HANDSHAKE_ONLY"
  exit 0
fi

GO_BINARY="${MD_GO_BINARY:-}"
validate_go() {
  local binary="$1" version
  [[ -f "$binary" && -x "$binary" ]] || fail "Go binary is not executable: $binary"
  version="$("$binary" version 2>/dev/null)" || fail "could not run Go binary: $binary"
  [[ "$version" == "go version go$GO_VERSION darwin/arm64" ]] \
    || fail "Go $GO_VERSION for darwin/arm64 is required (found '$version' at $binary)"
  GO_BINARY="$binary"
}

fetch_official_go() {
  local archive_name cache_dir archive download actual toolchain_dir
  archive_name="go${GO_VERSION}.darwin-arm64.tar.gz"
  cache_dir="$REPO_ROOT/.cache/go-toolchain"
  archive="$cache_dir/$archive_name"
  mkdir -p "$cache_dir"

  if [[ -f "$archive" ]]; then
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
    [[ "$actual" == "$GO_ARCHIVE_SHA256" ]] \
      || fail "cached official Go archive checksum mismatch: $archive (expected $GO_ARCHIVE_SHA256, got $actual)"
  else
    download="$BUILD_DIR/$archive_name"
    echo "==> fetching pinned official Go toolchain $archive_name"
    curl --fail --location --proto '=https' --tlsv1.2 \
      "https://go.dev/dl/$archive_name" -o "$download"
    actual="$(shasum -a 256 "$download" | awk '{print $1}')"
    [[ "$actual" == "$GO_ARCHIVE_SHA256" ]] \
      || fail "official Go archive checksum mismatch (expected $GO_ARCHIVE_SHA256, got $actual)"
    mv "$download" "$archive"
  fi

  toolchain_dir="$BUILD_DIR/toolchain"
  mkdir -p "$toolchain_dir"
  tar -xzf "$archive" -C "$toolchain_dir"
  validate_go "$toolchain_dir/go/bin/go"
}

# A signing build only ever trusts the checksum-verified official archive:
# MD_GO_BINARY or a PATH go at the pinned VERSION could still be a modified
# toolchain (version strings are not attestation), so those paths require the
# explicit dev-only escape hatch and never feed a release artifact silently.
if [[ "$ALLOW_UNPINNED_GO" == 1 ]]; then
  echo "==> WARNING: --allow-unpinned-go bypasses the checksum-verified toolchain; dev iteration only, NEVER a release artifact"
  if [[ -n "$GO_BINARY" ]]; then
    validate_go "$GO_BINARY"
  elif command -v go >/dev/null 2>&1; then
    validate_go "$(command -v go)"
  else
    fail "--allow-unpinned-go was passed but no Go toolchain was found (MD_GO_BINARY or PATH)"
  fi
else
  [[ -z "$GO_BINARY" ]] \
    || fail "MD_GO_BINARY bypasses the checksum-verified official toolchain; a signing build refuses it (pass --allow-unpinned-go only for dev iteration)"
  fetch_official_go
fi

echo "==> fetching exact pinned source commit and release tag"
git init -q "$SOURCE_DIR"
git -C "$SOURCE_DIR" remote add origin "$UPSTREAM_REPOSITORY"
git -C "$SOURCE_DIR" fetch --quiet --no-tags --depth=1 origin "$PIN_COMMIT"
git -C "$SOURCE_DIR" fetch --quiet --no-tags --depth=1 origin \
  "refs/tags/$PIN_TAG:refs/tags/$PIN_TAG"
TAG_COMMIT="$(git -C "$SOURCE_DIR" rev-parse --verify "$PIN_TAG^{commit}" 2>/dev/null)" \
  || fail "fetched tag $PIN_TAG does not resolve to a commit"
git -C "$SOURCE_DIR" checkout --quiet --detach "$PIN_COMMIT"
HEAD_COMMIT="$(git -C "$SOURCE_DIR" rev-parse --verify HEAD)"
SOURCE_STATUS="$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)"
SOURCE_CLEANLINESS=clean
[[ -z "$SOURCE_STATUS" ]] || SOURCE_CLEANLINESS=dirty
node "$PIN_HELPER" verify-source "$TAG_COMMIT" "$HEAD_COMMIT" "$SOURCE_CLEANLINESS" "$PIN_FILE" \
  || fail "fetched source failed pin verification"

BUILD_DATE="$(git -C "$SOURCE_DIR" show -s --format=%cI "$PIN_COMMIT")"
SOURCE_DATE_EPOCH="$(git -C "$SOURCE_DIR" show -s --format=%ct "$PIN_COMMIT")"
STAGED_BINARY="$BUILD_DIR/cliproxyapi"
LDFLAGS="-s -w -buildid= -X main.Version=$PIN_VERSION -X main.Commit=$PIN_COMMIT -X main.BuildDate=$BUILD_DATE"

echo "==> building pinned CLIProxyAPI source (darwin/arm64, CGO enabled)"
(
  cd "$SOURCE_DIR"
  env \
    CGO_ENABLED=1 \
    GOOS=darwin \
    GOARCH=arm64 \
    GOTOOLCHAIN=local \
    GOCACHE="$BUILD_DIR/go-build-cache" \
    GOMODCACHE="$BUILD_DIR/go-mod-cache" \
    SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    TZ=UTC \
    LC_ALL=C \
    "$GO_BINARY" build -mod=readonly -trimpath -buildvcs=false \
      -ldflags "$LDFLAGS" -o "$STAGED_BINARY" ./cmd/server/
)
chmod 755 "$STAGED_BINARY"
[[ "$(lipo -archs "$STAGED_BINARY")" == arm64 ]] \
  || fail "built binary is not a thin arm64 Mach-O: $STAGED_BINARY"

POST_BUILD_HEAD="$(git -C "$SOURCE_DIR" rev-parse --verify HEAD)"
POST_BUILD_STATUS="$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)"
POST_BUILD_CLEANLINESS=clean
[[ -z "$POST_BUILD_STATUS" ]] || POST_BUILD_CLEANLINESS=dirty
node "$PIN_HELPER" verify-source "$TAG_COMMIT" "$POST_BUILD_HEAD" "$POST_BUILD_CLEANLINESS" "$PIN_FILE" \
  || fail "source changed during the build"

[[ "$IDENTITY" != "$DEFAULT_IDENTITY" ]] \
  || fail "the signing identity is still the placeholder; set MD_SIGN_IDENTITY before signing"
command -v codesign >/dev/null 2>&1 || fail "codesign is required"
security find-identity -v -p codesigning | grep -Fq "$IDENTITY" \
  || fail "signing identity not found in keychain: $IDENTITY"

# #403 binding: deliberately NO --entitlements flag. Any entitlement addition
# requires a demonstrated hardened-runtime launch failure and a recorded reason.
echo "==> signing CLIProxyAPI (hardened runtime, timestamp, no entitlements)"
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$STAGED_BINARY"
codesign --verify --strict --verbose=2 "$STAGED_BINARY"
assert_no_entitlements "$STAGED_BINARY"

run_handshake "$STAGED_BINARY"

mkdir -p "$OUTPUT_DIR"
cp "$STAGED_BINARY" "$OUTPUT_BINARY"
chmod 755 "$OUTPUT_BINARY"
node "$PIN_HELPER" write-manifest "$OUTPUT_BINARY" "$OUTPUT_MANIFEST" "$PIN_FILE" \
  || fail "could not write CLIProxyAPI artifact manifest"
node "$PIN_HELPER" verify-artifact "$OUTPUT_BINARY" "$OUTPUT_MANIFEST" "$PIN_FILE" \
  || fail "written CLIProxyAPI artifact does not match the pin"
echo "==> built $OUTPUT_BINARY"
echo "    sha256: $(shasum -a 256 "$OUTPUT_BINARY" | awk '{print $1}')"
