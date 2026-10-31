#!/usr/bin/env bash
# Called by pure-uploadscript with the path of a *completed* upload as $1.
# Moves the file into s3://$PICKET_BUCKET/raw/YYYY/MM/DD/<name> and deletes it locally.
# Also used by the sweep timer to retry anything the hook missed.
set -euo pipefail

# pure-uploadscript is started by the pure-ftpd init script with PATH=/sbin:/bin:/usr/sbin:/usr/bin,
# which does not include /usr/local/bin where the AWS CLI is installed.
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
source /etc/picket.env   # PICKET_BUCKET, PICKET_RAW_PREFIX, AWS_DEFAULT_REGION

file="$1"
[ -f "$file" ] || exit 0
name="$(basename -- "$file")"

# pure-ftpd writes to the final name, so a file still open for writing could be
# handed to us by the sweep. Skip anything modified in the last 60 seconds.
if [ -n "${PICKET_SWEEP:-}" ]; then
  age=$(( $(date +%s) - $(stat -c %Y -- "$file") ))
  [ "$age" -ge 60 ] || exit 0
fi

# Upload date is good enough for the key; the Lambda reads the real capture time from EXIF.
day="$(date -u +%Y/%m/%d)"
key="${PICKET_RAW_PREFIX}${day}/${name}"

for attempt in 1 2 3 4 5; do
  if err="$(aws s3 mv --only-show-errors --no-progress -- "$file" "s3://${PICKET_BUCKET}/${key}" 2>&1)"; then
    logger -t picket-upload "uploaded ${name} -> s3://${PICKET_BUCKET}/${key}"
    exit 0
  fi
  logger -t picket-upload "attempt ${attempt} failed for ${name}: ${err:-no output}; retrying"
  sleep $(( attempt * 5 ))
done

logger -t picket-upload "giving up on ${name}; the sweep timer will retry"
exit 1
