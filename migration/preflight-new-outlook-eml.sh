#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-output/full-642}"
MAILBOX="${2:-jianfeng.jin@edmf.nl}"
ROOT="$BASE/$MAILBOX"
LIMIT=$((14*1024*1024))
test -d "$ROOT" || { echo "Missing mailbox directory: $ROOT" >&2; exit 2; }
total=0; oversize=0
echo "New Outlook EML pilot preflight"
echo "Mailbox: $MAILBOX"
for folder in Inbox Sent Deleted; do
  dir="$ROOT/$folder"; count=0; max=0; maxfile=""
  if [[ -d "$dir" ]]; then
    while IFS= read -r -d '' f; do
      size=$(stat -c %s "$f")
      ((count+=1)); ((total+=1))
      if (( size > max )); then max=$size; maxfile=$f; fi
      if (( size > LIMIT )); then echo "OVERSIZE (>14 MB): $f ($size bytes)"; ((oversize+=1)); fi
    done < <(find "$dir" -maxdepth 1 -type f -name '*.eml' -print0)
  fi
  printf '%-8s count=%-4d max_bytes=%-10d %s\n' "$folder" "$count" "$max" "$maxfile"
done
echo "Total: $total"
echo "Oversize: $oversize"
[[ "$MAILBOX" != "jianfeng.jin@edmf.nl" || "$total" -eq 83 ]] || { echo "Pilot count mismatch: expected 83" >&2; exit 3; }
[[ "$oversize" -eq 0 ]] || { echo "New Outlook cannot bulk-import EML files over 14 MB." >&2; exit 4; }
echo "PREFLIGHT OK"
