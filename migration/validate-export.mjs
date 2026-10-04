import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const manifestPath = process.argv[2] || 'output/manifest.json';
const manifest = JSON.parse(await fs.readFile(manifestPath,'utf8'));
const baseDir=path.dirname(path.resolve(manifestPath));
let errors=0,missingRefs=0,affected=0,generatedMessageIds=0,legacyHtmlCharsets=0;
const folders={};
for(const m of manifest.messages){
  folders[m.folder]=(folders[m.folder]||0)+1;
  const p=path.join(baseDir,m.mailbox,m.folder,String(m.email_id).padStart(10,'0')+'.eml');
  try{
    const b=await fs.readFile(p);
    const hash=crypto.createHash('sha256').update(b).digest('hex');
    if(hash!==m.sha256){console.error('HASH MISMATCH',p);errors++}
    const s=b.toString('utf8');
    if(!/^Message-ID:\\s*<[^>]+>/mi.test(s)){console.error('MISSING MESSAGE-ID',p);errors++}
    if(m.message_id_source==='generated')generatedMessageIds++;
    const encoded=[...s.matchAll(/Content-Type: text\\/html[^\\r\\n]*[\\r\\n]+Content-Transfer-Encoding: base64[\\r\\n]+[\\r\\n]+([A-Za-z0-9+/=\\r\\n]+)/gi)];
    for(const x of encoded){
      const html=Buffer.from(x[1].replace(/\\s/g,''),'base64').toString('utf8');
      if(/charset\\s*=\\s*["']?(?:gb2312|gbk|big5|iso-8859-[0-9]+)/i.test(html)){console.error('LEGACY HTML CHARSET',p);legacyHtmlCharsets++;errors++;break}
    }
  }catch(e){console.error('MISSING EML',p);errors++}
  const miss=(m.missing_attachments||[]).filter(a=>a.source_attachment_missing);
  missingRefs+=miss.length;if(miss.length)affected++;
}
if(manifest.exported!==manifest.messages.length){console.error('MANIFEST COUNT MISMATCH');errors++}
if(manifest.missing_attachment_references!==undefined && manifest.missing_attachment_references!==missingRefs){console.error('MISSING ATTACHMENT COUNT MISMATCH');errors++}
if(manifest.messages_with_missing_attachments!==undefined && manifest.messages_with_missing_attachments!==affected){console.error('AFFECTED MESSAGE COUNT MISMATCH');errors++}
console.log(`Validated ${manifest.messages.length} messages; errors=${errors}`);
console.log('Folders:',folders);
console.log(`Source missing attachment refs=${missingRefs}; affected messages=${affected}`);\nconsole.log(`Generated Message-IDs=${generatedMessageIds}; legacy HTML charsets=${legacyHtmlCharsets}`);
process.exitCode=errors?1:0;
