import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const manifestPath = process.argv[2] || 'output/manifest.json';
const manifest = JSON.parse(await fs.readFile(manifestPath,'utf8'));
const baseDir=path.dirname(path.resolve(manifestPath));
let errors=0,missingRefs=0,affected=0;
const folders={};
for(const m of manifest.messages){
  folders[m.folder]=(folders[m.folder]||0)+1;
  const p=path.join(baseDir,m.mailbox,m.folder,String(m.email_id).padStart(10,'0')+'.eml');
  try{
    const b=await fs.readFile(p);
    const hash=crypto.createHash('sha256').update(b).digest('hex');
    if(hash!==m.sha256){console.error('HASH MISMATCH',p);errors++}
  }catch(e){console.error('MISSING EML',p);errors++}
  const miss=(m.missing_attachments||[]).filter(a=>a.source_attachment_missing);
  missingRefs+=miss.length;if(miss.length)affected++;
}
if(manifest.exported!==manifest.messages.length){console.error('MANIFEST COUNT MISMATCH');errors++}
if(manifest.missing_attachment_references!==undefined && manifest.missing_attachment_references!==missingRefs){console.error('MISSING ATTACHMENT COUNT MISMATCH');errors++}
if(manifest.messages_with_missing_attachments!==undefined && manifest.messages_with_missing_attachments!==affected){console.error('AFFECTED MESSAGE COUNT MISMATCH');errors++}
console.log(`Validated ${manifest.messages.length} messages; errors=${errors}`);
console.log('Folders:',folders);
console.log(`Source missing attachment refs=${missingRefs}; affected messages=${affected}`);
process.exitCode=errors?1:0;
