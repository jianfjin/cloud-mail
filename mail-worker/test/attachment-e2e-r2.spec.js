import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import worker from '../src/index';
import { dbInit } from '../src/init/init';
import orm from '../src/entity/orm';
import account from '../src/entity/account';
import { att } from '../src/entity/att';

// Local E2E for the 0-byte attachment download bug (production: R2 storage).
// Pipeline: raw MIME email (with binary attachment) to local-tester@example.com
//   -> worker.email()  [real handler: parse, lookup, store to R2]
//   -> worker.fetch(/attachments/<key>)  [real route the browser download hits]
// Asserts the downloaded body is byte-identical to the sent payload (non-empty).

const c = { env };

const USER_ID = 999;
const TESTER_EMAIL = 'local-tester@example.com';
const FILENAME = 'report.pdf';

function makePayload(n = 2048) {
	const bytes = new Uint8Array(n);
	bytes.set(new TextEncoder().encode('%PDF-1.4\n'), 0);
	for (let i = 9; i < n; i++) {
		bytes[i] = (i * 31 + 7) & 0xff;
	}
	return bytes;
}

function toBase64(bytes) {
	let s = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(s);
}

function wrapBase64(b64, width = 76) {
	const lines = [];
	for (let i = 0; i < b64.length; i += width) {
		lines.push(b64.slice(i, i + width));
	}
	return lines.join('\r\n');
}

function buildMime(to, subject, bodyText, filename, payload) {
	return [
		'From: Sender <sender@example.test>',
		`To: ${to}`,
		`Subject: ${subject}`,
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="E2EBOUNDARY"',
		'',
		'--E2EBOUNDARY',
		'Content-Type: text/plain; charset=UTF-8',
		'',
		bodyText,
		'--E2EBOUNDARY',
		`Content-Type: application/pdf; name="${filename}"`,
		`Content-Disposition: attachment; filename="${filename}"`,
		'Content-Transfer-Encoding: base64',
		'',
		wrapBase64(toBase64(payload)),
		'--E2EBOUNDARY--',
		'',
	].join('\r\n');
}

function makeMessage(mime, to) {
	const state = { rejected: null, forwarded: [] };
	return {
		state,
		to,
		raw: new Response(mime).body,
		setReject: (reason) => { state.rejected = reason; },
		forward: async (addr) => { state.forwarded.push(addr); },
	};
}

beforeAll(async () => {
	// Production-style bootstrap: full schema migrations + default setting row
	// (which is also pushed to KV by settingService.refresh).
	const initCtx = {
		env,
		req: { param: () => env.jwt_secret },
		set: () => {},
		text: (s) => new Response(s),
	};
	await dbInit.init(initCtx);

	// User whose email matches env.admin so the receive path skips the role
	// permission checks (we only care about storage + download here).
	await env.db.prepare(`
		INSERT OR REPLACE INTO user (user_id, email, type, password, salt, status, is_del)
		VALUES (?, ?, 0, 'password', 'salt', 0, 0)
	`).bind(USER_ID, env.admin).run();

	const existing = await env.db.prepare(
		`SELECT account_id FROM account WHERE email = ? COLLATE NOCASE`
	).bind(TESTER_EMAIL).first();
	if (!existing) {
		await orm(c).insert(account).values({
			email: TESTER_EMAIL,
			name: 'Local Tester',
			userId: USER_ID,
		}).run();
	}
});

describe('attachment download end-to-end (R2 storage)', () => {
	it('stores the attachment in R2 and serves it byte-identical from /attachments/', async () => {
		const payload = makePayload();
		const mime = buildMime(TESTER_EMAIL, 'E2E attachment download test', 'Here is your file.', FILENAME, payload);
		const message = makeMessage(mime, TESTER_EMAIL);

		await worker.email(message, env, {});

		expect(message.state.rejected).toBeNull();

		// Attachment row persisted with the expected key shape.
		const attRows = await orm(c).select().from(att).where(eq(att.filename, FILENAME)).all();
		expect(attRows.length).toBeGreaterThan(0);
		const attRow = attRows[attRows.length - 1];
		expect(attRow.key).toMatch(/^attachments\//);

		// The bytes actually landed in R2 (production storage backend).
		const r2Obj = await env.r2.get(attRow.key);
		expect(r2Obj).not.toBeNull();
		const stored = new Uint8Array(await r2Obj.arrayBuffer());
		expect(Array.from(stored)).toEqual(Array.from(payload));

		// Download through the same route the browser <a download> uses.
		const resp = await worker.fetch(new Request(`http://local-test/${attRow.key}`), env, {});
		expect(resp).toBeInstanceOf(Response);
		expect(resp.status).toBe(200);

		const body = new Uint8Array(await resp.arrayBuffer());
		expect(body.length).toBe(payload.length); // the 0-byte regression
		expect(Array.from(body)).toEqual(Array.from(payload));
		expect(resp.headers.get('content-disposition')).toContain(FILENAME);
	});

	it('returns 404 (not an empty response) for a missing attachment', async () => {
		const resp = await worker.fetch(new Request('http://local-test/attachments/does-not-exist.bin'), env, {});
		expect(resp).toBeInstanceOf(Response);
		expect(resp.status).toBe(404);
	});
});
