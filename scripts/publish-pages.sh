#!/usr/bin/env bash
# One-shot: publish the current SingVaza code to Cloudflare Pages and make sure
# the D1 database stays attached. Nothing needs to exist first - the script
# creates the project with the same name, so the address stays
# https://singvaza.pages.dev .
#
#   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... ./scripts/publish-pages.sh [project]
#
# Token permissions: Account > Cloudflare Pages > Edit  +  Account > D1 > Edit
set -euo pipefail

PROJECT="${1:-singvaza}"
ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
TOKEN="${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT"
DB_ID="${D1_DATABASE_ID:-88b28623-1da8-42ff-8b52-479097f44650}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

say "1/5  Building the bundle (public/ + compiled _worker.js)"
rm -rf "$ROOT/.publish" && mkdir -p "$ROOT/.publish"
cp -r "$ROOT/public/." "$ROOT/.publish/"
( cd "$ROOT" && CF_PAGES=1 CF_PAGES_BRANCH=main \
    npx --yes wrangler@4.86.0 pages functions build --outfile="$ROOT/.publish/_worker.js" )
test -s "$ROOT/.publish/_worker.js"

say "2/5  Verifying the API token"
api "$API" | tee /tmp/sv-acct.json | grep -q '"success":true' || { cat /tmp/sv-acct.json; exit 1; }
echo "     token OK"

say "3/5  Checking the Pages project '$PROJECT'"
if api "$API/pages/projects/$PROJECT" | grep -q '"success":true'; then
  echo "     project exists - adding a new production deployment"
else
  echo "     creating project"
  api -X POST "$API/pages/projects" -d "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}" > /tmp/sv-project.json
  grep -q '"success":true' /tmp/sv-project.json || { cat /tmp/sv-project.json; exit 1; }
fi

say "4/5  Attaching D1 (binding DB) to production + preview"
api -X PATCH "$API/pages/projects/$PROJECT" -d "$(cat <<JSON
{"deployment_configs":{"production":{"d1_databases":{"DB":{"id":"$DB_ID"}}},"preview":{"d1_databases":{"DB":{"id":"$DB_ID"}}}}}
JSON
)" | grep -q '"success":true' && echo "     D1 attached" || echo "     D1 unchanged (check the token's D1 permission)"

say "5/5  Uploading the deployment"
( cd "$ROOT" && CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" \
    npx --yes wrangler@4.86.0 pages deploy "$ROOT/.publish" \
      --project-name="$PROJECT" --branch=main --commit-dirty=true )

echo
echo "Live: https://$PROJECT.pages.dev"
