#!/usr/bin/env bash
# Idempotent DNS record management on Netlify DNS (the domain is registered there).
#   netlify-dns.sh upsert <zone-name> <TYPE> <hostname> <value> [ttl]
#   netlify-dns.sh list   <zone-name>
# Needs NETLIFY_AUTH_TOKEN (a personal access token) and curl + jq.
set -euo pipefail

API="https://api.netlify.com/api/v1"
auth=(-H "Authorization: Bearer ${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN is required}" -H "Content-Type: application/json")

api() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  local out code
  if [ -n "$body" ]; then
    out="$(curl -sS -w '\n%{http_code}' -X "$method" "${auth[@]}" "$API$path" --data "$body")"
  else
    out="$(curl -sS -w '\n%{http_code}' -X "$method" "${auth[@]}" "$API$path")"
  fi
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  if [ "$code" -ge 300 ]; then echo "netlify $method $path -> HTTP $code: $out" >&2; return 1; fi
  printf '%s' "$out"
}

zone_id() {
  local name="$1"
  api GET /dns_zones | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' | head -n1
}

cmd="${1:-}"; shift || true
case "$cmd" in
  list)
    zone="$(zone_id "$1")"; [ -n "$zone" ] || { echo "no Netlify DNS zone named $1" >&2; exit 1; }
    api GET "/dns_zones/$zone/dns_records" | jq -r '.[] | "\(.type)\t\(.hostname)\t\(.value)\t\(.ttl)"'
    ;;
  upsert)
    zone_name="$1"; type="$2"; hostname="${3%.}"; value="${4%.}"; ttl="${5:-300}"
    zone="$(zone_id "$zone_name")"; [ -n "$zone" ] || { echo "no Netlify DNS zone named $zone_name (is the domain on Netlify DNS?)" >&2; exit 1; }
    records="$(api GET "/dns_zones/$zone/dns_records")"
    # Records of the same type + hostname that we would replace.
    existing="$(printf '%s' "$records" | jq -c --arg t "$type" --arg h "$hostname" '[.[] | select(.type == $t and (.hostname | rtrimstr(".")) == $h)]')"
    if printf '%s' "$existing" | jq -e --arg v "$value" 'any(.[]; (.value | rtrimstr(".")) == $v)' >/dev/null; then
      echo "ok      $type $hostname -> $value (unchanged)"
      exit 0
    fi
    for id in $(printf '%s' "$existing" | jq -r '.[].id'); do
      api DELETE "/dns_zones/$zone/dns_records/$id" >/dev/null
      echo "removed $type $hostname (old value)"
    done
    body="$(jq -nc --arg t "$type" --arg h "$hostname" --arg v "$value" --argjson ttl "$ttl" '{type:$t, hostname:$h, value:$v, ttl:$ttl}')"
    api POST "/dns_zones/$zone/dns_records" "$body" >/dev/null
    echo "created $type $hostname -> $value"
    ;;
  *)
    echo "usage: $0 upsert <zone-name> <TYPE> <hostname> <value> [ttl] | list <zone-name>" >&2; exit 2
    ;;
esac
