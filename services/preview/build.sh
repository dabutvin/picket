#!/usr/bin/env bash
# Build the Lambda bundle into $1 (default: ./dist) for Python 3.12 on arm64.
# Pure pip, no Docker: every dependency ships manylinux aarch64 wheels.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/dist}"
mkdir -p "${out:?}"

python3 -m pip install --quiet --disable-pip-version-check \
  --requirement "$here/requirements.txt" \
  --platform manylinux2014_aarch64 --only-binary=:all: \
  --python-version 3.12 --implementation cp \
  --target "${out:?}" --upgrade

cp "$here/handler.py" "${out:?}/"

# Trim what the function never imports (keeps the zip ~25 MB instead of ~45 MB).
find "${out:?}" -type d -name tests -prune -exec rm -rf {} + 2>/dev/null || true
find "${out:?}" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "${out:?}/numpy" -maxdepth 2 -type d \( -name include -o -name f2py \) -prune -exec rm -rf {} + 2>/dev/null || true
echo "preview bundle -> ${out} ($(du -sh "${out:?}" | cut -f1))"
