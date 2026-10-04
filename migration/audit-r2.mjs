#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const argv=Object.fromEntries(process.argv.slice(2).map(v=>{const i=v.indexOf('=');return i<0?[v.replace(/^--/,'') ,true]:[v.slice(2,i),v.slice(i+1)]}));
const accountsFile=argv.accounts||'input/accounts.json', emailsFile=argv.emails||'input/all-emails.json', attachmentsFile=argv.attachments||'input/all-attachments.json';
const r2Dir=argv.r2||'r2-all', outFile=argv.out||'output/r2-audit.json';
function unwrap(raw){const a=Array.isArray(raw)?raw:(raw.result||raw.results||[]);return a.flatMap(x=>Array.isArray(x?.results)?x.results:[x]);}
const load=async p=>unwrap(JSON.parse(await fs.readFile(p,'utf8')));
const [accounts,emails,atts]=await Promise.all([load(accountsFile),load(emailsFile),load(attachmentsFile)]);
const acct=new Map(accounts.map(a=>[Number(a.account_id),String(a.email||'')]));
acct.set(2,'[orphan account_id=2 → info@edmf.nl]');
const emailMap=new Map(emails.map(e=>[Number(e.email_id),e]));
const keyCache=new Map();
async function exists(key){if(keyCache.has(key))return keyCache.get(key);try{await fs.access(path.join(r2Dir,key));keyCache.set(key,true);return true}catch{keyCache.set(key,false);return false}}
const groups=new Map();
for(const a of atts){
 const e=emailMap.get(Number(a.email_id)); const accountId=Number(e?.account_id ?? a.account_id); const source=acct.get(accountId)||'[unknown]';
 const gkey=accountId+'|'+source;
 if(!groups.has(gkey))groups.set(gkey,{source_account_id:accountId,source_mailbox:source,attachment_refs:0,keys:new Set(),missingKeys:new Set(),affected:new Set()});
 const g=groups.get(gkey); g.attachment_refs++; if(!a.key)continue; g.keys.add(a.key);
 if(!(await exists(a.key))){g.missingKeys.add(a.key);g.affected.add(Number(a.email_id))}
}
const rows=[...groups.values()].map(g=>({source_account_id:g.source_account_id,source_mailbox:g.source_mailbox,attachment_refs:g.attachment_refs,unique_r2_keys:g.keys.size,existing_r2_keys:[...g.keys].filter(k=>keyCache.get(k)).length,missing_r2_keys:g.missingKeys.size,affected_messages:g.affected.size,missing_keys:[...g.missingKeys],affected_email_ids:[...g.affected].sort((a,b)=>a-b)})).sort((a,b)=>a.source_account_id-b.source_account_id);
const allKeys=new Set(atts.map(a=>a.key).filter(Boolean)), missing=[...allKeys].filter(k=>!keyCache.get(k));
const summary={generated_at:new Date().toISOString(),r2_dir:r2Dir,attachment_refs:atts.length,unique_r2_keys:allKeys.size,existing_r2_keys:allKeys.size-missing.length,missing_r2_keys:missing.length,affected_messages:new Set(rows.flatMap(r=>r.affected_email_ids)).size,rows};
await fs.mkdir(path.dirname(outFile),{recursive:true});await fs.writeFile(outFile,JSON.stringify(summary,null,2)+'\n');
console.table(rows.map(r=>({id:r.source_account_id,source:r.source_mailbox,refs:r.attachment_refs,keys:r.unique_r2_keys,existing:r.existing_r2_keys,missing:r.missing_r2_keys,affected:r.affected_messages})));
console.log(`TOTAL refs=${summary.attachment_refs}; unique keys=${summary.unique_r2_keys}; existing=${summary.existing_r2_keys}; missing=${summary.missing_r2_keys}; affected messages=${summary.affected_messages}`);
console.log(`Wrote ${outFile}`);
