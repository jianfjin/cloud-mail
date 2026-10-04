import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map(v => {
  const i = v.indexOf('=');
  return i < 0 ? [v.replace(/^--/, ''), true] : [v.slice(2, i), v.slice(i + 1)];
}));

const input = args.input || 'input/emails.json';
const outDir = args.out || 'output';
const mailboxFilter = args.mailbox?.toLowerCase();
const afterId = Number(args['after-id'] || 0);
const maxId = args['max-id'] ? Number(args['max-id']) : Number.MAX_SAFE_INTEGER;

const raw = JSON.parse(await fs.readFile(input, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.result || raw.results || []);
const normalized = rows.flatMap(x => Array.isArray(x?.results) ? x.results : [x]);

function parseJson(value, fallback=[]) {
  if (!value) return fallback;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return fallback; }
}
function escHeader(v='') { return String(v).replace(/[\r\n]+/g, ' ').trim(); }
function addr(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  return x.name ? `"${escHeader(x.name).replaceAll('"', '\\"')}" <${x.address}>` : x.address;
}
function listHeader(v) { return parseJson(v).map(addr).filter(Boolean).join(', '); }
function mime(row) {
  const boundary = 'cloudmail-' + crypto.randomUUID();
  const from = row.name ? `"${escHeader(row.name).replaceAll('"', '\\"')}" <${row.send_email || ''}>` : (row.send_email || '');
  const to = listHeader(row.recipient) || row.to_email || '';
  const headers = [
    `From: ${from}`, `To: ${to}`,
    row.cc && parseJson(row.cc).length ? `Cc: ${listHeader(row.cc)}` : null,
    `Subject: ${escHeader(row.subject || '')}`,
    `Date: ${new Date((row.create_time || '').replace(' ', 'T') + 'Z').toUTCString()}`,
    row.message_id ? `Message-ID: ${escHeader(row.message_id)}` : null,
    row.in_reply_to ? `In-Reply-To: ${escHeader(row.in_reply_to)}` : null,
    row.relation ? `References: ${escHeader(row.relation)}` : null,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean);
  const text = row.text || '';
  const html = row.content || '';
  return headers.join('\r\n') + '\r\n\r\n' +
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n` +
    `--${boundary}--\r\n`;
}

const selected = normalized.filter(r => {
  const id = Number(r.email_id);
  const mailbox = String(r.account_email || r.to_email || '').toLowerCase();
  return id > afterId && id <= maxId && (!mailboxFilter || mailbox === mailboxFilter);
});

const manifest = [];
for (const row of selected) {
  const mailbox = String(row.account_email || row.to_email || 'unknown').toLowerCase();
  const folder = Number(row.is_del) === 1 ? 'Deleted' : Number(row.type) === 1 ? 'Sent' : 'Inbox';
  const eml = mime(row);
  const dir = path.join(outDir, mailbox, folder);
  await fs.mkdir(dir, {recursive:true});
  const file = path.join(dir, String(row.email_id).padStart(10,'0') + '.eml');
  await fs.writeFile(file, eml);
  manifest.push({
    email_id: Number(row.email_id), mailbox, folder,
    message_id: row.message_id || null,
    cloudmail_create_time: row.create_time || null,
    migration_date_source: 'cloudmail_create_time',
    sha256: crypto.createHash('sha256').update(eml).digest('hex')
  });
}
await fs.mkdir(outDir, {recursive:true});
await fs.writeFile(path.join(outDir,'manifest.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  after_email_id: afterId,
  max_email_id: selected.length ? Math.max(...selected.map(x=>Number(x.email_id))) : afterId,
  count: manifest.length,
  messages: manifest
}, null, 2));
console.log(`Exported ${manifest.length} messages to ${outDir}`);
