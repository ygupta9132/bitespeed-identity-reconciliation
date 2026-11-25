#!/usr/bin/env bash
# Replays the two worked examples from the brief against a running service.
#
#   ./smoke.sh                               # localhost:3000
#   ./smoke.sh https://your-app.onrender.com # a deployed instance
set -euo pipefail

BASE="${1:-http://localhost:3000}"

call() {
  echo "--> POST /identify $1"
  curl -sS -X POST "$BASE/identify" -H 'Content-Type: application/json' -d "$1"
  echo
}

echo "== health =="
curl -sS "$BASE/health"; echo

echo
echo "== example 1: a known phone number arrives with a new email =="
call '{"email":"lorraine@hillvalley.edu","phoneNumber":"123456"}'
call '{"email":"mcfly@hillvalley.edu","phoneNumber":"123456"}'
echo "the three single-field variations, all returning the same contact:"
call '{"email":null,"phoneNumber":"123456"}'
call '{"email":"lorraine@hillvalley.edu","phoneNumber":null}'
call '{"email":"mcfly@hillvalley.edu","phoneNumber":null}'

echo
echo "== example 2: two primaries merge, the older one survives =="
call '{"email":"george@hillvalley.edu","phoneNumber":"919191"}'
call '{"email":"biffsucks@hillvalley.edu","phoneNumber":"717171"}'
call '{"email":"george@hillvalley.edu","phoneNumber":"717171"}'

echo
echo "== a request with neither identifier is a 400 =="
curl -sS -o /dev/null -w 'status %{http_code}\n' -X POST "$BASE/identify" \
  -H 'Content-Type: application/json' -d '{}'
