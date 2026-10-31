#!/usr/bin/env bash
# Issue a one-time app pairing code: store {code, expiresAt} in the pairing secret and print
#   PAIRING_CODE=XXXX-XXXX
#   PAIRING_EXPIRES=<UTC ISO time>
# so a workflow can append the output to $GITHUB_ENV or eval it.
#   pairing-code.sh <pairing-secret-id> [valid-minutes]
# Needs the AWS CLI with credentials for secretsmanager:PutSecretValue on that secret.
set -euo pipefail

secret="${1:?usage: pairing-code.sh <pairing-secret-id> [valid-minutes]}"
minutes="${2:-30}"

# 32 symbols (no 0/O or 1/I), so one random byte mod 32 is uniform. Built byte by byte
# instead of `tr </dev/urandom | head`, which dies with "Broken pipe" under pipefail.
alphabet=ABCDEFGHJKLMNPQRSTUVWXYZ23456789
raw=""
for b in $(od -An -tu1 -N8 /dev/urandom); do raw+="${alphabet:$((b % 32)):1}"; done
[ "${#raw}" -eq 8 ] || { echo "could not read 8 random bytes" >&2; exit 1; }
code="${raw:0:4}-${raw:4:4}"
expires="$(date -u -d "+${minutes} minutes" +%Y-%m-%dT%H:%M:%SZ)"

aws secretsmanager put-secret-value --secret-id "$secret" \
  --secret-string "{\"code\":\"$code\",\"expiresAt\":\"$expires\"}" >/dev/null

printf 'PAIRING_CODE=%s\nPAIRING_EXPIRES=%s\n' "$code" "$expires"
