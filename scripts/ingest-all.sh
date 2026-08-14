#!/bin/zsh
# Retired 0.4.6 interim warehouse job target. Kept inert so a stale loaded
# ai.hermes.modeldeck.ingest job cannot run the legacy file-ingest path while
# release-day launchd retirement is being completed.
set -e
echo "ingest-all.sh: retired in ModelDeck 0.4.6; daemon ingestion is authoritative" >&2
exit 0
