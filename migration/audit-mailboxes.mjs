#!/usr/bin/env node
import fs from 'node:fs/promises';

const argv=Object.fromEntries(process.argv.slice(2).map(v=>{const i=v.indexOf('=');return i<0?[v.replace(/^--/,''),true]:[v.slice(2,i),v.slice(i+1)]}));
const accountsFile=argv.accounts||'input/accounts.json';
const emailsFile=argv.emails||'input/all-emails.json';
const attachmentsFile=argv.attachments||'input/all-attachments.json';
const mapFile=argv.map||'mailbox-map.json';
const outFile=argv.out||'output/mailbox-audit.json';

function unwrap(raw){const a=Array.isArray(raw)?raw:(raw.result||raw.results||[]);return a.flatMap(x=>Array.isArray(x?.results)?x.results:[x]);}
const load=async p=>unwrap(JSON.parse(await fs.readFile(p,'utf8')));
const accounts=await load(accountsFile), emails=await load(emailsFile), atts=await load(attachmentsFile);
const map=JSON.parse(await fs.readFile(mapFile,'utf8'));
const norm=s=>String(s||'').trim().toLowerCase();

const explicitAliases={
  'zhaolu@edmf.nl':'lu.zhao@edmf.nl',
  'information@edmf.nl':'info@edmf.nl'
};
function targetFor(source){
  const s=norm(source);
  const canonical=explicitAliases[s]||s;
  const m=map[canonical];
  return m?{target:m.target,kind:m.kind,action:s===canonical?'direct':'merge'}:{target:null,kind:null,action:'review'};
}
const attByEmail=new Map();
for(const a of atts){const id=Number(a.email_id);if(!attByEmail.has(id))attByEmail.set(id,[]);attByEmail.get(id).push(a)}
const rows=[];
for(const a of accounts){
  const id=Number(a.account_id), source=String(a.email||'');
  const es=emails.filter(e=>Number(e.account_id)===id);
  const folders={Inbox:0,Sent:0,Deleted:0};
  let attachmentRefs=0, expectedAttachmentBytes=0;
  for(const e of es){
    const folder=Number(e.is_del)===1?'Deleted':Number(e.type)===1?'Sent':'Inbox';
    folders[folder]++;
    for(const x of attByEmail.get(Number(e.email_id))||[]){attachmentRefs++;expectedAttachmentBytes+=Number(x.size||0)}
  }
  const ids=es.map(e=>Number(e.email_id)).filter(Number.isFinite);
  rows.push({source_account_id:id,source_mailbox:source,...targetFor(source),Inbox:folders.Inbox,Sent:folders.Sent,Deleted:folders.Deleted,total:es.length,min_email_id:ids.length?Math.min(...ids):null,max_email_id:ids.length?Math.max(...ids):null,attachment_refs:attachmentRefs,expected_attachment_bytes:expectedAttachmentBytes});
}
rows.sort((a,b)=>a.source_account_id-b.source_account_id);
const summary={generated_at:new Date().toISOString(),source_accounts:rows.length,total_messages:rows.reduce((n,r)=>n+r.total,0),review_accounts:rows.filter(r=>r.action==='review').length,rows};
await fs.mkdir(new URL('./output/',import.meta.url),{recursive:true});
await fs.writeFile(outFile,JSON.stringify(summary,null,2)+'\n');
console.table(rows.map(r=>({id:r.source_account_id,source:r.source_mailbox,target:r.target||'REVIEW',action:r.action,Inbox:r.Inbox,Sent:r.Sent,Deleted:r.Deleted,total:r.total,min:r.min_email_id,max:r.max_email_id,atts:r.attachment_refs})));
console.log(`Wrote ${outFile}; source accounts=${summary.source_accounts}; messages=${summary.total_messages}; review=${summary.review_accounts}`);
