#!/bin/bash
# Sets the latency toxiproxy adds to every response from PostgreSQL, in milliseconds.
# 0 removes it. Needs `docker compose up -d` first.
#   ./scripts/latency.sh 20
set -euo pipefail
latency="${1:-0}"
api="${TOXIPROXY_URL:-http://localhost:8474}"

if ! curl -fs "$api/proxies/postgres" >/dev/null; then
  curl -fs -X POST "$api/proxies" \
    -d '{"name":"postgres","listen":"0.0.0.0:15432","upstream":"postgres:5432"}' >/dev/null
fi
curl -fs -X DELETE "$api/proxies/postgres/toxics/latency" >/dev/null 2>&1 || true
if [ "$latency" != "0" ]; then
  curl -fs -X POST "$api/proxies/postgres/toxics" \
    -d "{\"name\":\"latency\",\"type\":\"latency\",\"stream\":\"downstream\",\"attributes\":{\"latency\":$latency}}" >/dev/null
fi
echo "PostgreSQL on localhost:15432 now has ${latency} ms added to each response."
