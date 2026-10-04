#!/usr/bin/env bash
set -euo pipefail
META="${1:-input/attachments.json}"
DEST="${2:-r2}"
mkdir -p "$DEST"
node - "$META" <<'NODE' > /tmp/cloudmail-r2-keys.txt
const fs=require('fs'); const raw=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const a=Array.isArray(raw)?raw:(raw.result||raw.results||[]);
for(const x of a.flatMap(v=>Array.isArray(v?.results)?v.results:[v])) if(x?.key) console.log(x.key);
NODE
echo "R2 keys listed in /tmp/cloudmail-r2-keys.txt"
echo "Download each key preserving its relative path under $DEST."
echo "Example with Wrangler:"
echo '  while IFS= read -r key; do mkdir -p "'"$DEST"'/$(dirname "$key")"; npx wrangler r2 object get "<BUCKET>/$key" --remote --file "'"$DEST"'/$key"; done < /tmp/cloudmail-r2-keys.txt'
echo "Replace <BUCKET> with the configured production bucket name. This command only reads objects."
