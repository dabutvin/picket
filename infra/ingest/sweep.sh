#!/usr/bin/env bash
# Retry any file left behind in the FTP home (hook failure, instance reboot mid-upload, ...).
set -euo pipefail
export PICKET_SWEEP=1
find /srv/ftp -type f ! -name '.*' -print0 | while IFS= read -r -d '' f; do
  /usr/local/bin/picket-upload.sh "$f" || true
done
