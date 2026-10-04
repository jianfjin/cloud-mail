#!/usr/bin/env bash
set -euo pipefail
WATERMARK="${1:-642}"
INPUT="${2:-input/all-emails.json}"
ATTS="${3:-input/all-attachments.json}"
R2="${4:-r2-all}"
OUT="${5:-output/full-${WATERMARK}}"
EXPECTED="${EXPECTED_FULL_COUNT:-622}"

rm -rf "$OUT"
mkdir -p "$OUT/manifests"
parts=()

run() {
  local account_id="$1" mailbox="$2" tag="$3"
  node export-mailboxes.mjs \
    --input="$INPUT" --attachments="$ATTS" --r2="$R2" --out="$OUT" \
    --mailbox="$mailbox" --account-id="$account_id" --max-id="$WATERMARK" \
    --allow-missing-attachments
  mv "$OUT/manifest.json" "$OUT/manifests/$tag.json"
  parts+=("$OUT/manifests/$tag.json")
}

run 1  admin@edmf.nl        account-1
run 3  jianfeng.jin@edmf.nl account-3
run 5  lynn.qin@edmf.nl     account-5
run 7  ge_yu@edmf.nl        account-7
run 8  bin.qu@edmf.nl       account-8
run 9  lifang.liu@edmf.nl   account-9
run 10 lu.zhao@edmf.nl      account-10
run 11 info@edmf.nl         account-11
run 12 xiaohui.ge@edmf.nl   account-12
run 13 ilse.custers@edmf.nl account-13
run 2  info@edmf.nl         account-2-orphan

node - "$OUT" "$WATERMARK" "$EXPECTED" "${parts[@]}" <<'NODE'
const fs=require('fs'),path=require('path');
const [out,watermark,expected,...files]=process.argv.slice(2);
const parts=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
const messages=parts.flatMap(p=>p.messages||[]).sort((a,b)=>a.email_id-b.email_id);
const ids=messages.map(m=>Number(m.email_id));
const dup=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];
const sum=k=>parts.reduce((n,p)=>n+Number(p[k]||0),0);
const combined={
 generated_at:new Date().toISOString(),migration_type:'full',after_email_id:0,max_email_id:Number(watermark),
 expected_source_messages:Number(expected),selected:sum('selected'),exported:sum('exported'),failed:sum('failed'),
 allow_missing_attachments:true,attachment_references:sum('attachment_references'),
 missing_attachment_references:sum('missing_attachment_references'),
 messages_with_missing_attachments:sum('messages_with_missing_attachments'),duplicate_email_ids:dup,messages
};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(combined,null,2)+'\n');
if(combined.exported!==combined.expected_source_messages||combined.selected!==combined.expected_source_messages||combined.failed!==0||dup.length){
 console.error('FULL EXPORT COUNT CHECK FAILED', {expected:combined.expected_source_messages,selected:combined.selected,exported:combined.exported,failed:combined.failed,duplicate_email_ids:dup});
 process.exit(2);
}
console.log('Combined manifest OK:',{expected:combined.expected_source_messages,selected:combined.selected,exported:combined.exported,failed:combined.failed});
NODE

node validate-export.mjs "$OUT/manifest.json"
echo "Full export + validation complete: $OUT"
