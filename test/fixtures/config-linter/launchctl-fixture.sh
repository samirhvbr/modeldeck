#!/bin/sh

fixture_directory=${0%/*}
case "${MODELDECK_LAUNCHCTL_FIXTURE_STATE:-healthy}" in
  healthy) fixture_dump=launchctl-healthy.txt ;;
  spawn-failed) fixture_dump=launchctl-spawn-failed.txt ;;
  cli-sentinel) fixture_dump=launchctl-cli-sentinel.txt ;;
  *) exit 64 ;;
esac

/bin/cat "$fixture_directory/$fixture_dump"
