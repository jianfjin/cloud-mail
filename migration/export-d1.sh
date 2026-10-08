#!/usr/bin/env bash
set -euo pipefail
DB_NAME="${1:?usage: ./export-d1.sh <D1_DATABASE_NAME>}"
mkdir -p input
npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT e.*, a.email AS account_email FROM email e JOIN account a ON a.account_id=e.account_id ORDER BY e.email_id" --json > input/emails.json
npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT * FROM attachments ORDER BY email_id, att_id" --json > input/attachments.json
echo "Read-only D1 snapshot written to migration/input/"
