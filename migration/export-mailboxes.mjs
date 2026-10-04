import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = Object.fromEntries(process.argv.slice(2).map(v => {
  const i=v.indexOf('='); return i<0?[v.replace(/^--/,'') ,true]:[v.slice(2,i),v.slice(i+1)];
}));
const input=argv.input||'input/emails.json', attachmentsInput=argv.attachments||'input/attachments.json';
const r2Dir=argv.r2||'r2', outDir=argv.out||'output', mailboxFilter=argv.mailbox?.toLowerCase();
const accountIdFilter=argv['account-id'] ? Number(argv['account-id']) : null;
const allowMissing=Boolean(argv['allow-missing-attachments']);
const afterId=Number(argv['after-id']||0), maxId=argv['max-id']?Number(argv['max-id']):Number.MAX_SAFE_INTEGER;

function unwrap(raw){ const a=Array.isArray(raw)?raw:(raw.result||raw.results||[]); return a.flatMap(x=>Array.isArray(x?.results)?x.results:[x]); }
function parse(v,f=[]){if(!v)return f;try{return typeof v==='string'?JSON.parse(v):v}catch{return f}}
function safe(v=''){return String(v).replace(/[\r\n]+/g,' ').trim()}
function q(v=''){return safe(v).replaceAll('"','')}
function addr(x){if(!x)return'';if(typeof x==='string')return safe(x);return x.name?`"${q(x.name)}" <${safe(x.address)}>`:safe(x.address)}
function list(v){return parse(v).map(addr).filter(Boolean).join(', ')}
function fold64(b){return b.toString('base64').match(/.{1,76}/g)?.join('\r\n')||''}
function encText(s){return fold64(Buffer.from(String(s||''),'utf8'))}
function boundary(label,id){return `=_cloudmail_migration_${label}_${id}_${crypto.randomBytes(6).toString('hex')}`}
function dateHeader(v){const d=new Date(String(v||'').replace(' ','T')+'Z');return Number.isNaN(d.valueOf())?new Date(0).toUTCString():d.toUTCString()}
function textPart(type,body){return `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encText(body)}`}
async function attachmentPart(a){
  const file=path.join(r2Dir,a.key);
  let data;
  try { data=await fs.readFile(file); }
  catch(e) {
    if(e.code==='ENOENT' && allowMissing) return {missing:true,meta:{att_id:a.att_id,key:a.key,filename:a.filename||null,mime_type:a.mime_type||null,content_id:a.content_id||null,expected_bytes:Number(a.size||0),source_attachment_missing:true}};
    throw e;
  }
  const type=safe(a.mime_type||'application/octet-stream');
  const name=q(a.filename||path.basename(a.key)||'attachment');
  const cid=a.content_id?safe(a.content_id).replace(/^<|>$/g,''):null;
  const disposition=cid||Number(a.type)===1?'inline':'attachment';
  return {missing:false,part:[`Content-Type: ${type}; name="${name}"`,'Content-Transfer-Encoding: base64',`Content-Disposition: ${disposition}; filename="${name}"`,cid?`Content-ID: <${cid}>`:null,'',fold64(data)].filter(x=>x!==null).join('\r\n'),meta:{att_id:a.att_id,key:a.key,filename:a.filename||null,mime_type:a.mime_type||null,content_id:a.content_id||null,bytes:data.length,source_attachment_missing:false}};
}
async function makeMime(row,atts){
  const id=Number(row.email_id), alt=boundary('alt',id), mixed=boundary('mixed',id), related=boundary('related',id);
  const from=row.name?`"${q(row.name)}" <${safe(row.send_email||'')}>`:safe(row.send_email||'');
  const to=list(row.recipient)||safe(row.to_email||'');
  const sourceMessageId=safe(row.message_id||'');
  const effectiveMessageId=sourceMessageId||`<cloudmail-${id}@migration.edmf.nl>`;
  const messageIdSource=sourceMessageId?'source':'generated';
  const headers=[`From: ${from}`,to?`To: ${to}`:null,parse(row.cc).length?`Cc: ${list(row.cc)}`:null,`Subject: ${encodeHeader(row.subject||'')}`,`Date: ${dateHeader(row.create_time)}`,`Message-ID: ${effectiveMessageId}`,row.in_reply_to?`In-Reply-To: ${safe(row.in_reply_to)}`:null,row.relation?`References: ${safe(row.relation)}`:null,'MIME-Version: 1.0'].filter(Boolean);
  const altBody=[`Content-Type: multipart/alternative; boundary="${alt}"`,'',`--${alt}`,textPart('text/plain',row.text||''),`--${alt}`,textPart('text/html',row.content||''),`--${alt}--`].join('\r\n');
  const inline=[], regular=[], meta=[], missing=[];
  for(const a of atts){
    const p=await attachmentPart(a); meta.push(p.meta);
    if(p.missing){missing.push(p.meta);continue}
    (a.content_id||Number(a.type)===1?inline:regular).push(p.part);
  }
  let body=altBody;
  if(inline.length){body=[`Content-Type: multipart/related; boundary="${related}"`,'',`--${related}`,body,...inline.flatMap(p=>[`--${related}`,p]),`--${related}--`].join('\r\n')}
  if(regular.length){body=[`Content-Type: multipart/mixed; boundary="${mixed}"`,'',`--${mixed}`,body,...regular.flatMap(p=>[`--${mixed}`,p]),`--${mixed}--`].join('\r\n')}
  return {eml:headers.join('\r\n')+'\r\n'+body+'\r\n',attachmentMeta:meta,missingAttachments:missing,messageId:effectiveMessageId,messageIdSource};
}

const rows=unwrap(JSON.parse(await fs.readFile(input,'utf8')));
let attRows=[];try{attRows=unwrap(JSON.parse(await fs.readFile(attachmentsInput,'utf8')))}catch(e){if(e.code!=='ENOENT')throw e}
const byEmail=new Map();for(const a of attRows){const k=Number(a.email_id);if(!byEmail.has(k))byEmail.set(k,[]);byEmail.get(k).push(a)}
if (mailboxFilter && !accountIdFilter && !rows.some(r => r.account_email)) throw new Error('--mailbox requires joined account_email data or --account-id. For direct email-table exports, pass both --mailbox and --account-id.');
const selected=rows.filter(r=>{const id=Number(r.email_id),mb=String(r.account_email||'').toLowerCase();return id>afterId&&id<=maxId&&(!accountIdFilter||Number(r.account_id)===accountIdFilter)&&(!mailboxFilter||accountIdFilter||mb===mailboxFilter)});
const manifest=[];let failed=0,missingAttachmentRefs=0,messagesWithMissing=0;
for(const row of selected){
  const id=Number(row.email_id), mailbox=mailboxFilter || String(row.account_email||'unknown').toLowerCase();
  const folder=Number(row.is_del)===1?'Deleted':Number(row.type)===1?'Sent':'Inbox';
  try{
    const {eml,attachmentMeta,missingAttachments,messageId,messageIdSource}=await makeMime(row,byEmail.get(id)||[]);
    const dir=path.join(outDir,mailbox,folder);await fs.mkdir(dir,{recursive:true});
    const file=path.join(dir,String(id).padStart(10,'0')+'.eml');await fs.writeFile(file,eml);
    missingAttachmentRefs+=missingAttachments.length;if(missingAttachments.length)messagesWithMissing++;
    manifest.push({email_id:id,mailbox,folder,message_id:messageId,message_id_source:messageIdSource,cloudmail_create_time:row.create_time||null,migration_date_source:'cloudmail_create_time',source_data_warning:missingAttachments.length?'missing_attachments':null,missing_attachments:missingAttachments,attachments:attachmentMeta,sha256:crypto.createHash('sha256').update(eml).digest('hex')});
  }catch(e){failed++;console.error(`FAILED email_id=${id}: ${e.message}`)}
}
await fs.mkdir(outDir,{recursive:true});
const summary={generated_at:new Date().toISOString(),after_email_id:afterId,max_email_id:selected.length?Math.max(...selected.map(x=>Number(x.email_id))):afterId,selected:selected.length,exported:manifest.length,failed,allow_missing_attachments:allowMissing,attachment_references:attRows.filter(a=>selected.some(r=>Number(r.email_id)===Number(a.email_id))).length,missing_attachment_references:missingAttachmentRefs,messages_with_missing_attachments:messagesWithMissing};
await fs.writeFile(path.join(outDir,'manifest.json'),JSON.stringify({...summary,messages:manifest},null,2));
console.log(`Selected ${selected.length}; exported ${manifest.length}; failed ${failed}; missing attachment refs ${missingAttachmentRefs}; affected messages ${messagesWithMissing}`);
if(failed)process.exitCode=1;
