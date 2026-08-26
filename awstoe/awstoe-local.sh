#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Local AWSTOE runner: validate and execute EC2 Image Builder component
# documents in seconds, without a pipeline build.
#
#   ./awstoe-local.sh validate <doc.yml> [more docs...]
#   ./awstoe-local.sh run <doc.yml> [--phases build,validate] [--parameters n=v,...]
#
# validate runs natively. run executes inside an Amazon Linux 2023 container:
# components execute with no sandbox, and a step that requests a reboot
# (exit code 194 or the Reboot action) makes AWSTOE modify your crontab and
# call shutdown - inside the container neither can touch your machine, and
# the filesystem the component mutates is thrown away. If you know exactly
# what a document does and want it to run on this host anyway, pass --host.
set -euo pipefail
# Without this, failures inside $( ) are invisible to set -e (bash 4.4+).
shopt -s inherit_errexit 2>/dev/null || true

REGION="${AWSTOE_REGION:-us-east-1}"
BASE_URL="https://awstoe-${REGION}.s3.${REGION}.amazonaws.com/latest"
# Key fingerprint from the AWSTOE download documentation.
AWSTOE_FINGERPRINT="F6DDE01C869FD63915E55742DEBDC156F5AEBC52"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/awstoe-local"
IMAGE_TAG="awstoe-local"

die() { echo "awstoe-local: $1" >&2; exit 1; }

fetch_binary() {
  local platform arch
  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    *) die "unsupported platform $(uname -s) - on Windows, download awstoe.exe per the AWSTOE documentation" ;;
  esac
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
  mkdir -p "$CACHE_DIR"
  local bin="$CACHE_DIR/awstoe"
  if [ ! -x "$bin" ]; then
    echo "Downloading awstoe (${platform}/${arch}, ${REGION})..." >&2
    curl -sSf "${BASE_URL}/${platform}/${arch}/awstoe" -o "$bin"
    curl -sSf "${BASE_URL}/${platform}/${arch}/awstoe.sig" -o "$bin.sig"
    curl -sSf "${BASE_URL}/assets/awstoe.gpg" -o "$CACHE_DIR/awstoe.gpg"
    GNUPGHOME="$(mktemp -d)" export GNUPGHOME
    # --no-autostart: verification needs no agent, and minimal gpg installs
    # (like the run container's) don't ship one.
    gpg --batch --no-autostart --quiet --import "$CACHE_DIR/awstoe.gpg"
    # Bind the check to the documented key fingerprint: a bare --verify exit
    # code passes with any key in the keyring.
    gpg --batch --no-autostart --status-fd 1 --verify "$bin.sig" "$bin" 2>/dev/null \
      | grep -q "VALIDSIG.*${AWSTOE_FINGERPRINT}" \
      || { rm -f "$bin"; die "signature verification failed"; }
    rm -rf "$GNUPGHOME"; unset GNUPGHOME
    chmod +x "$bin"
  fi
  "$bin" --version >&2
  echo "$bin"
}

run_in_docker() {
  command -v docker >/dev/null \
    || die "run executes in a container and needs docker - or pass --host to run directly on this machine"
  local here; here="$(cd "$(dirname "$0")" && pwd)"
  docker build -q -t "$IMAGE_TAG" "$here" >/dev/null
  # Mount the working directory read-write (run mode writes its logs here -
  # document paths must sit under the current directory) and a host cache so
  # containers don't re-download the binary. AWSTOE_CHOWN hands log ownership
  # back to the invoking user; AWS_* passes credentials through for documents
  # that call AWS.
  mkdir -p "$CACHE_DIR/docker"
  exec docker run --rm -v "$PWD:/work" -w /work \
    -v "$CACHE_DIR/docker:/root/.cache/awstoe-local" \
    -e AWSTOE_REGION="$REGION" -e AWSTOE_CHOWN="$(id -u):$(id -g)" \
    -e AWS_EC2_METADATA_DISABLED -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
    -e AWS_SESSION_TOKEN -e AWS_REGION \
    "$IMAGE_TAG" "$@"
}

cmd_validate() {
  [ "$#" -ge 1 ] || die "validate needs at least one document (awstoe exits 0 on an empty list)"
  local bin; bin="$(fetch_binary)"
  local docs; docs="$(IFS=,; echo "$*")"
  "$bin" validate --documents "$docs"
}

cmd_run() {
  [ "$#" -ge 1 ] || die "run needs a document"
  if [ "$(id -u)" = "0" ] && [ "${AWSTOE_IN_CONTAINER:-}" != "1" ]; then
    die "refusing to run as root on the host: a rebooting step would modify root's crontab and reboot this machine"
  fi
  local bin; bin="$(fetch_binary)"
  local logdir statedir
  logdir="./awstoe-logs/$(date -u +%Y%m%dT%H%M%SZ)"
  statedir="$(mktemp -d)"
  mkdir -p "$logdir"
  # Fresh state per run: stale reboot-tracker state in a reused directory
  # makes the next run resume the interrupted execution instead of running
  # the documents you passed.
  local out rc=0
  out="$("$bin" run --documents "$1" -l "$logdir" -s "$statedir" \
        --blocked-action-modules Reboot "${@:2}")" || rc=$?
  echo "$out"
  rm -rf "$statedir"
  [ -n "${AWSTOE_CHOWN:-}" ] && chown -R "$AWSTOE_CHOWN" ./awstoe-logs 2>/dev/null || true
  local executed
  executed="$(echo "$out" | grep -o '"executedStepCount": *[0-9]*' | grep -o '[0-9]*$' || echo 0)"
  if [ "$rc" -eq 0 ] && [ "${executed:-0}" -eq 0 ]; then
    die "0 steps executed - check --phases against the document's phase names (a phase that matches nothing reports success)"
  fi
  if [ "$rc" -ne 0 ]; then
    local console
    console="$(find "$logdir" -name console.log | head -1)"
    [ -n "$console" ] && { echo "--- console.log (tail) ---" >&2; tail -20 "$console" >&2; }
    echo "details: $(find "$logdir" -name detailedoutput.json | head -1)" >&2
  fi
  exit "$rc"
}

[ "$#" -ge 1 ] || die "usage: $0 validate <docs...> | run [--host] <doc> [args]"
sub="$1"; shift
case "$sub" in
  validate) cmd_validate "$@" ;;
  run)
    if [ "${1:-}" = "--host" ]; then
      shift
      cmd_run "$@"
    elif [ "${AWSTOE_IN_CONTAINER:-}" = "1" ]; then
      cmd_run "$@"
    else
      run_in_docker run "$@"
    fi
    ;;
  *) die "unknown subcommand '$sub' (validate|run)" ;;
esac
