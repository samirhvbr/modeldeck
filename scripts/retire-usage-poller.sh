#!/bin/bash
# Retire both pre-0.4.6 usage consumers in one operation.
#
# Boots the legacy CLIProxyAPI poller and interim warehouse ingest job out of
# the current GUI login session and removes their LaunchAgent plists.
# Idempotent: safe when either job or plist is already absent.
#
# Usage: scripts/retire-usage-poller.sh
set -euo pipefail

LAUNCHCTL_BIN="${MODELDECK_LAUNCHCTL_BIN:-/bin/launchctl}"
GUI_TARGET="gui/$(id -u)"
failed=0

for LABEL in com.cliproxyapi.poller ai.hermes.modeldeck.ingest; do
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if "$LAUNCHCTL_BIN" print "$GUI_TARGET/$LABEL" >/dev/null 2>&1; then
    if "$LAUNCHCTL_BIN" bootout "$GUI_TARGET/$LABEL" 2>/dev/null; then
      echo "Unloaded $LABEL"
    else
      status=$?
      echo "$LABEL: could not confirm unload (launchctl exit $status); plist retained" >&2
      failed=1
      continue
    fi
  else
    status=$?
    case "$status" in
      3|113) echo "$LABEL was not loaded" ;;
      *)
        echo "$LABEL: could not determine launchd state (launchctl exit $status); plist retained" >&2
        failed=1
        continue
        ;;
    esac
  fi

  if [[ -f "$PLIST" ]]; then
    if rm "$PLIST" 2>/dev/null; then
      echo "Removed LaunchAgent plist for $LABEL"
    else
      echo "$LABEL: could not remove LaunchAgent plist" >&2
      failed=1
    fi
  else
    echo "No LaunchAgent plist present for $LABEL"
  fi
done

exit "$failed"
