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

// Build the expected byte sizes per R2 key from D1. A shared key can have many
// attachment references, but all non-zero D1 sizes for the same key should agree.
const expectedByKey=new Map();
for(const a of atts){
 if(!a.key)continue;
 const n=Number(a.size);
 if(!expectedByKey.has(a.key))expectedByKey.set(a.key,new Set());
 if(Number.isFinite(n)&&n>=0)expectedByKey.get(a.key).add(n);
}

const keyCache=new Map();
async function inspect(key){
 if(keyCache.has(key))return keyCache.get(key);
 const expected=[...(expectedByKey.get(key)||[])];
 let result;
 try{
   const st=await fs.stat(path.join(r2Dir,key));
   const actual=st.size;
   // Prefer an exact D1 size match. If D1 has no usable size, require a
   // non-zero file so failed-download placeholders are never treated as valid.
   const hasExpected=expected.length>0;
   const valid=hasExpected ? expected.includes(actual) : actual>0;
   result={status:valid?'valid':actual===0?'zero_byte':'size_mismatch',actual_bytes:actual,expected_bytes:expected};
 }catch(e){
   if(e.code==='ENOENT')result={status:'missing',actual_bytes:null,expected_bytes:expected};
   else throw e;
 }
 keyCache.set(key,result);return result;
}

const groups=new Map();
for(const a of atts){
 const e=emailMap.get(Number(a.email_id)); const accountId=Number(e?.account_id ?? a.account_id); const source=acct.get(accountId)||'[unknown]';
 const gkey=accountId+'|'+source;
 if(!groups.has(gkey))groups.set(gkey,{source_account_id:accountId,source_mailbox:source,attachment_refs:0,keys:new Set(),badKeys:new Map(),affected:new Set()});
 const g=groups.get(gkey);g.attachment_refs++;if(!a.key)continue;g.keys.add(a.key);
 const check=await inspect(a.key);
 if(check.status!=='valid'){g.badKeys.set(a.key,check);g.affected.add(Number(a.email_id))}
}

const rows=[...groups.values()].map(g=>{
 const keys=[...g.keys], bad=[...g.badKeys.entries()];
 return {
  source_account_id:g.source_account_id,source_mailbox:g.source_mailbox,attachment_refs:g.attachment_refs,
  unique_r2_keys:keys.length,valid_r2_keys:keys.filter(k=>keyCache.get(k)?.status==='valid').length,
  missing_r2_keys:bad.filter(([,v])=>v.status==='missing').length,
  zero_byte_r2_keys:bad.filter(([,v])=>v.status==='zero_byte').length,
  size_mismatch_r2_keys:bad.filter(([,v])=>v.status==='size_mismatch').length,
  affected_messages:g.affected.size,
  bad_keys:bad.map(([key,v])=>({key,...v})),affected_email_ids:[...g.affected].sort((a,b)=>a-b)
 };
}).sort((a,b)=>a.source_account_id-b.source_account_id);

const allKeys=[...new Set(atts.map(a=>a.key).filter(Boolean))];
for(const k of allKeys)await inspect(k);
const counts=status=>allKeys.filter(k=>keyCache.get(k)?.status===status).length;
const affected=new Set(rows.flatMap(r=>r.affected_email_ids));
const summary={generated_at:new Date().toISOString(),r2_dir:r2Dir,attachment_refs:atts.length,unique_r2_keys:allKeys.length,
 valid_r2_keys:counts('valid'),missing_r2_keys:counts('missing'),zero_byte_r2_keys:counts('zero_byte'),size_mismatch_r2_keys:counts('size_mismatch'),
 affected_messages:affected.size,rows};
await fs.mkdir(path.dirname(outFile),{recursive:true});await fs.writeFile(outFile,JSON.stringify(summary,null,2)+'\n');
console.table(rows.map(r=>({id:r.source_account_id,source:r.source_mailbox,refs:r.attachment_refs,keys:r.unique_r2_keys,valid:r.valid_r2_keys,missing:r.missing_r2_keys,zero:r.zero_byte_r2_keys,mismatch:r.size_mismatch_r2_keys,affected:r.affected_messages})));
console.log(`TOTAL refs=${summary.attachment_refs}; unique keys=${summary.unique_r2_keys}; valid=${summary.valid_r2_keys}; missing=${summary.missing_r2_keys}; zero-byte=${summary.zero_byte_r2_keys}; size-mismatch=${summary.size_mismatch_r2_keys}; affected messages=${summary.affected_messages}`);
console.log(`Wrote ${outFile}`);
