#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ARTIFACTS_DIR=${TEST_ARTIFACTS_DIR:-"$ROOT/test-artifacts"}
case "$ARTIFACTS_DIR" in
  /*) ;;
  *) ARTIFACTS_DIR="$ROOT/$ARTIFACTS_DIR" ;;
esac
MODE=fast
case "${1-}" in
  "") ;;
  --showcase) MODE=showcase ;;
  *) echo "Usage: $0 [--showcase]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [--showcase]" >&2
  exit 2
fi
mkdir -p "$ARTIFACTS_DIR"
docker build -t lokarta-browser-test:local "$ROOT/test-runner"
docker run --rm --init --name lokarta-browser-test \
  -e WORKSPACE_DIR="/game" \
  -e ARTIFACTS_DIR="/artifacts" \
  -v "$ROOT:/game:ro" -v "$ARTIFACTS_DIR:/artifacts" \
  lokarta-browser-test:local $([ "$MODE" = showcase ] && echo "--showcase" || echo "")
