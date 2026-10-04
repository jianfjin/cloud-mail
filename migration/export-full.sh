#!/usr/bin/env bash
set -euo pipefail
WATERMARK="${1:-642}"
INPUT="${2:-input/all-emails.json}"
ATTS="${3:-input/all-attachments.json}"
R2="${4:-r2-all}"
OUT="${5:-output/full-${WATERMARK}}"

rm -rf "$OUT"
mkdir -p "$OUT"

run() {
  local account_id="$1" mailbox="$2"
  node export-mailboxes.mjs \
    --input="$INPUT" --attachments="$ATTS" --r2="$R2" --out="$OUT" \
    --mailbox="$mailbox" --account-id="$account_id" --max-id="$WATERMARK" \
    --allow-missing-attachments
}

run 1  admin@edmf.nl
run 3  jianfeng.jin@edmf.nl
run 5  lynn.qin@edmf.nl
run 7  ge_yu@edmf.nl
run 8  bin.qu@edmf.nl
run 9  lifang.liu@edmf.nl
run 10 lu.zhao@edmf.nl
run 11 info@edmf.nl
run 12 xiaohui.ge@edmf.nl
run 13 ilse.custers@edmf.nl

# Historical orphan account_id=2 belonged to info@edmf.nl. Export it into the
# same target mailbox without deleting the direct account_id=11 export.
node export-mailboxes.mjs \
  --input="$INPUT" --attachments="$ATTS" --r2="$R2" --out="$OUT" \
  --mailbox=info@edmf.nl --account-id=2 --max-id="$WATERMARK" \
  --allow-missing-attachments

echo "Bulk EML export complete: $OUT"
echo "NOTE: each exporter invocation writes $OUT/manifest.json; build a combined manifest before validation."
