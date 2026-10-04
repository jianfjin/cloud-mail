import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const manifestPath = process.argv[2] || 'output/manifest.json';
const manifest = JSON.parse(await fs.readFile(manifestPath,'utf8'));
let errors = 0;
for (const m of manifest.messages) {
  const p = `output/${m.mailbox}/${m.folder}/${String(m.email_id).padStart(10,'0')}.eml`;
  try {
    const b = await fs.readFile(p);
    const hash = crypto.createHash('sha256').update(b).digest('hex');
    if (hash !== m.sha256) { console.error('HASH MISMATCH', p); errors++; }
  } catch (e) { console.error('MISSING', p); errors++; }
}
console.log(`Validated ${manifest.messages.length} messages; errors=${errors}`);
process.exitCode = errors ? 1 : 0;
