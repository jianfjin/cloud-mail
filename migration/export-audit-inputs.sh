#!/usr/bin/env bash
set -euo pipefail
DB="${1:-cloud-mail-db}"
mkdir -p input
npx wrangler d1 execute "$DB" --remote --json --command "SELECT * FROM account ORDER BY account_id" > input/accounts.json
npx wrangler d1 execute "$DB" --remote --json --command "SELECT * FROM email ORDER BY email_id" > input/all-emails.json
npx wrangler d1 execute "$DB" --remote --json --command "SELECT * FROM attachments ORDER BY email_id, att_id" > input/all-attachments.json
echo "Exported read-only D1 audit inputs to migration/input/"
