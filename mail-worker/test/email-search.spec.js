import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/hono/webs';
import { dbInit } from '../src/init/init';
import jwtUtils from '../src/utils/jwt-utils';
import KvConst from '../src/const/kv-const';

const c = { env };

async function resetSchema() {
	await env.db.prepare('DROP TRIGGER IF EXISTS email_search_dirty_after_update').run();
	for (const table of [
		'email_search_fts', 'email_search_meta', 'email_search_rate_guard',
		'attachments', 'star', 'email', 'account',
	]) {
		await env.db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	}

	await env.db.prepare(`
		CREATE TABLE account (
			account_id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			status INTEGER NOT NULL DEFAULT 0, latest_email_time DATETIME, signature TEXT,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP, user_id INTEGER NOT NULL,
			all_receive INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
			is_del INTEGER NOT NULL DEFAULT 0
		)
	`).run();
	await env.db.prepare(`
		CREATE TABLE email (
			email_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			send_email TEXT, name TEXT, account_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
			subject TEXT, code TEXT NOT NULL DEFAULT '', text TEXT, content TEXT, calendar_data TEXT,
			cc TEXT DEFAULT '[]', bcc TEXT DEFAULT '[]', recipient TEXT,
			to_email TEXT NOT NULL DEFAULT '', to_name TEXT NOT NULL DEFAULT '',
			in_reply_to TEXT DEFAULT '', relation TEXT DEFAULT '', message_id TEXT DEFAULT '',
			type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0,
			resend_email_id TEXT, message TEXT, unread INTEGER NOT NULL DEFAULT 0,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			is_del INTEGER NOT NULL DEFAULT 0
		)
	`).run();
	await env.db.prepare(`
		CREATE TABLE attachments (
			att_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL, key TEXT NOT NULL, filename TEXT, mime_type TEXT,
			size INTEGER, status TEXT NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 0,
			disposition TEXT, related TEXT, content_id TEXT, encoding TEXT,
			calendar_method TEXT, create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
		)
	`).run();
	await env.db.prepare(`
		CREATE TABLE star (
			star_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
		)
	`).run();
}

async function authorizationHeader(userId) {
	const sessionToken = `search-session-${userId}`;
	const token = await jwtUtils.generateToken(c, { userId, token: sessionToken });
	await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({
		tokens: [sessionToken],
		user: { userId, email: `user-${userId}@example.com` },
		refreshTime: new Date().toISOString(),
	}));
	return { Authorization: token, 'Content-Type': 'application/json', 'Accept-Language': 'en' };
}

async function insertEmail({
	emailId,
	userId = 101,
	accountId = 10,
	sendEmail = 'sender@example.com',
	name = 'Sender',
	toEmail = 'owner@example.com',
	toName = 'Owner',
	recipient = '[{"address":"owner@example.com","name":"Owner"}]',
	cc = '[]',
	bcc = '[]',
	subject = '',
	text = '',
	content = '',
	type = 0,
	createTime = '2026-09-15 12:00:00',
	deleted = false,
}) {
	await env.db.prepare(`
		INSERT INTO email (
			email_id, send_email, name, account_id, user_id, subject, text, content,
			recipient, cc, bcc, to_email, to_name, type, create_time, is_del
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		emailId, sendEmail, name, accountId, userId, subject, text, content,
		recipient, cc, bcc, toEmail, toName, type, createTime, deleted ? 1 : 0,
	).run();
}

async function search(headers, body) {
	return app.request('/email/search', {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	}, env);
}

async function details(headers, body) {
	return app.request('/email/search/details', {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	}, env);
}

async function bodyOf(response) {
	return response.json();
}

async function addAccount(accountId = 10, userId = 101, { deleted = false } = {}) {
	await env.db.prepare('INSERT INTO account (account_id, email, user_id, is_del) VALUES (?, ?, ?, ?)')
		.bind(accountId, `account-${accountId}@example.com`, userId, deleted ? 1 : 0).run();
}

function request(criteria = {}, overrides = {}) {
	return { generation: 1, criteria, order: 'newest', pageSize: 50, ...overrides };
}

describe('owned mailbox search contracts', () => {
	beforeEach(resetSchema);

	it('binds the initial page and exact total to the authenticated user and active accounts', async () => {
		await env.db.prepare(`INSERT INTO account (account_id, email, user_id, is_del) VALUES
			(10, 'owner@example.com', 101, 0),
			(20, 'foreign@example.com', 202, 0),
			(30, 'deleted@example.com', 101, 1)
		`).run();
		await insertEmail({ emailId: 1, userId: 101, accountId: 10, subject: 'owned searchable', text: 'shared ownership token' });
		await insertEmail({ emailId: 2, userId: 202, accountId: 20, subject: 'foreign searchable', text: 'shared ownership token' });
		await insertEmail({ emailId: 3, userId: 101, accountId: 10, subject: 'deleted searchable', text: 'shared ownership token', deleted: true });
		await insertEmail({ emailId: 4, userId: 101, accountId: 30, subject: 'inactive searchable', text: 'shared ownership token' });
		await dbInit.v3_7DB(c);

		const headers = await authorizationHeader(101);
		const response = await search(headers, request({ query: 'shared ownership', location: 'all' }));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(body).toMatchObject({
			code: 200,
			data: { generation: 1, total: 1 },
		});
		expect(body.data.list.map(row => row.emailId)).toEqual([1]);

		const hydration = await details(headers, { generation: 1, emailIds: [4, 2, 1, 3, 1] });
		expect(await hydration.json()).toMatchObject({
			code: 200,
			data: { generation: 1, list: [{ emailId: 1, userId: 101, accountId: 10 }] },
		});
	});

	it('matches literal Unicode whole tokens across indexed fields with positive AND and separate exclusions', async () => {
		await addAccount();
		await insertEmail({
			emailId: 1,
			sendEmail: 'alice@example.com',
			name: 'Ålice Sender',
			toName: 'Bob Recipient',
			recipient: '[{"address":"bob@example.com","name":"Bob Recipient"}]',
			cc: '[{"address":"carol@example.com","name":"Carol CC"}]',
			bcc: '[{"address":"dan@example.com","name":"Dan BCC"}]',
			subject: 'Quarterly invoice quote"mark',
			text: 'Plain Café alpha-beta wild*card O\'Reilly literal OR token',
			content: '<p>hiddenonly must not be indexed when plain text exists</p>',
		});
		await insertEmail({
			emailId: 2,
			sendEmail: 'other@example.com',
			name: 'Other',
			subject: 'alphabet report',
			text: '',
			content: '<p>HTML fallback 项目更新</p>',
		});
		await insertEmail({ emailId: 3, subject: 'unrelated message', text: 'ordinary content' });
		await dbInit.v3_7DB(c);
		const headers = await authorizationHeader(101);
		const ids = async criteria => (await bodyOf(await search(headers, request(criteria)))).data.list.map(row => row.emailId);

		expect(await ids({ query: 'quarterly CAFÉ' })).toEqual([1]);
		expect(await ids({ from: 'alice sender', to: 'bob carol dan', subject: 'invoice', hasWords: 'café' })).toEqual([1]);
		expect(await ids({ query: 'html 项目更新' })).toEqual([2]);
		expect(await ids({ query: 'hiddenonly' })).toEqual([]);
		expect(await ids({ query: 'alph' })).toEqual([]);
		expect(await ids({ query: 'alpha*beta wild?card quote:mark O\'Reilly' })).toEqual([1]);
		expect(await ids({ query: 'alpha_beta' })).toEqual([1]);
		expect(await ids({ query: 'literal OR token' })).toEqual([1]);
		expect(await ids({ doesntHave: 'invoice' })).toEqual([3, 2]);
		expect(await ids({ hasWords: 'café', doesntHave: 'ordinary invoice' })).toEqual([]);
	});

	it('applies all mailbox scopes without duplicate starred rows', async () => {
		await addAccount();
		await insertEmail({ emailId: 1, subject: 'received one', type: 0 });
		await insertEmail({ emailId: 2, subject: 'sent one', type: 1 });
		await insertEmail({ emailId: 3, subject: 'received two', type: 0 });
		await env.db.prepare('INSERT INTO star (star_id, user_id, email_id) VALUES (1, 101, 1), (2, 101, 1), (3, 202, 2), (4, 101, 2)').run();
		await dbInit.v3_7DB(c);
		const headers = await authorizationHeader(101);
		const ids = async location => (await bodyOf(await search(headers, request({ location })))).data.list.map(row => row.emailId);

		expect(await ids('all')).toEqual([3, 2, 1]);
		expect(await ids('inbox')).toEqual([3, 1]);
		expect(await ids('sent')).toEqual([2]);
		expect(await ids('starred')).toEqual([2, 1]);
	});

	it('uses downloadable attachment presence but counts every recorded attachment byte in stored size', async () => {
		await addAccount();
		await insertEmail({
			emailId: 1,
			sendEmail: '', name: '', toEmail: '', toName: '', recipient: '', cc: '', bcc: '',
			subject: 'é', text: '', content: '',
		});
		await insertEmail({
			emailId: 2,
			sendEmail: '', name: '', toEmail: '', toName: '', recipient: '', cc: '', bcc: '',
			subject: '', text: '', content: '',
		});
		await env.db.prepare(`INSERT INTO attachments
			(att_id, user_id, email_id, account_id, key, size, type, content_id)
			VALUES
				(1, 101, 1, 10, 'attachments/regular', 10, 0, NULL),
				(2, 101, 1, 10, 'attachments/regular-two', 5, 0, NULL),
				(3, 101, 1, 10, 'attachments/inline', 20, 0, 'cid-one'),
				(4, 101, 1, 10, 'attachments/embed', 30, 1, 'cid-two'),
				(5, 101, 2, 10, 'attachments/inline-only', 100, 0, 'cid-three')
		`).run();
		await dbInit.v3_7DB(c);
		const headers = await authorizationHeader(101);
		const ids = async criteria => (await bodyOf(await search(headers, request(criteria)))).data.list.map(row => row.emailId);

		// UTF-8 subject bytes (2) plus every linked attachment size (65).
		expect(await ids({ size: { comparator: 'gt', bytes: 66 } })).toEqual([2, 1]);
		expect(await ids({ size: { comparator: 'gt', bytes: 67 } })).toEqual([2]);
		expect(await ids({ size: { comparator: 'lt', bytes: 67 } })).toEqual([]);
		expect(await ids({ size: { comparator: 'lt', bytes: 68 } })).toEqual([1]);
		expect(await ids({ hasAttachment: true })).toEqual([1]);
	});

	it('accepts canonical half-open UTC bounds', async () => {
		await addAccount();
		await insertEmail({ emailId: 1, createTime: '2026-09-14 21:59:59' });
		await insertEmail({ emailId: 2, createTime: '2026-09-14 22:00:00' });
		await insertEmail({ emailId: 3, createTime: '2026-09-15 21:59:59' });
		await insertEmail({ emailId: 4, createTime: '2026-09-15 22:00:00' });
		await dbInit.v3_7DB(c);
		const response = await search(await authorizationHeader(101), request({
			date: { start: '2026-09-14T22:00:00.000Z', end: '2026-09-15T22:00:00.000Z' },
		}));

		expect((await response.json()).data.list.map(row => row.emailId)).toEqual([3, 2]);
	});

	it('allows an exact leap-aware ten-year UTC range and rejects anything longer', async () => {
		await addAccount();
		await insertEmail({ emailId: 1, createTime: '2020-02-29 00:00:00' });
		await dbInit.v3_7DB(c);
		const headers = await authorizationHeader(101);

		const exactTenYears = await search(headers, request({
			date: { start: '2020-02-29T00:00:00.000Z', end: '2030-02-28T00:00:00.000Z' },
		}));
		const overTenYears = await search(headers, request({
			date: { start: '2020-02-29T00:00:00.000Z', end: '2030-03-01T00:00:00.000Z' },
		}));

		expect(exactTenYears.status).toBe(200);
		expect(overTenYears.status).toBe(400);
		expect(await overTenYears.json()).toMatchObject({ code: 400, message: 'Invalid search request' });
	});

	it('pages deterministically in both directions and counts only cursorless snapshots', async () => {
		await addAccount();
		for (let emailId = 1; emailId <= 5; emailId++) await insertEmail({ emailId, subject: `page ${emailId}` });
		await dbInit.v3_7DB(c);
		const headers = await authorizationHeader(101);

		const first = await bodyOf(await search(headers, request({}, { pageSize: 2 })));
		expect(first.data).toMatchObject({ total: 5, nextCursor: 4 });
		expect(first.data.list.map(row => row.emailId)).toEqual([5, 4]);

		await insertEmail({ emailId: 6, subject: 'inserted after snapshot' });
		await env.db.prepare('UPDATE email SET is_del = 1 WHERE email_id = 3').run();
		const later = await bodyOf(await search(headers, request({}, { pageSize: 2, cursor: first.data.nextCursor })));
		expect(later.data.list.map(row => row.emailId)).toEqual([2, 1]);
		expect(later.data).not.toHaveProperty('total');
		expect(later.data.nextCursor).toBeNull();

		const oldest = await bodyOf(await search(headers, request({}, { order: 'oldest', pageSize: 2 })));
		expect(oldest.data.total).toBe(5);
		expect(oldest.data.list.map(row => row.emailId)).toEqual([1, 2]);
		const oldestLater = await bodyOf(await search(headers, request({}, {
			order: 'oldest', pageSize: 2, cursor: oldest.data.nextCursor,
		})));
		expect(oldestLater.data.list.map(row => row.emailId)).toEqual([4, 5]);
		expect(oldestLater.data).not.toHaveProperty('total');
	});

	it('hydrates one deduplicated owned page in request order and rejects larger batches', async () => {
		await addAccount();
		for (let emailId = 1; emailId <= 50; emailId++) await insertEmail({ emailId, subject: `detail ${emailId}` });
		await dbInit.v3_7DB(c);
		const headers = await authorizationHeader(101);

		const response = await details(headers, { generation: 'detail-generation', emailIds: [3, 1, 3, 2] });
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(body.data.generation).toBe('detail-generation');
		expect(body.data.list.map(row => row.emailId)).toEqual([3, 1, 2]);
		expect(body.data.list.every(row => Array.isArray(row.attList))).toBe(true);
		expect(body.data.list.every(row => !Object.hasOwn(row, 'searchDirty'))).toBe(true);

		const tooMany = await details(headers, { generation: 2, emailIds: Array.from({ length: 51 }, (_, index) => index + 1) });
		expect(tooMany.status).toBe(400);
		expect(await tooMany.json()).toMatchObject({ code: 400 });
	});

	it('returns controlled unavailability until the owned index generation is reconciled', async () => {
		await addAccount();
		await insertEmail({ emailId: 1, subject: 'not installed' });
		const headers = await authorizationHeader(101);

		const unavailablePage = await search(headers, request({ query: 'installed' }));
		const unavailableDetails = await details(headers, { generation: 1, emailIds: [1] });
		expect(unavailablePage.status).toBe(503);
		expect(unavailableDetails.status).toBe(503);
		expect(await unavailablePage.json()).toMatchObject({ code: 503, message: 'Search is temporarily unavailable' });

		await dbInit.v3_7DB(c);
		for (let emailId = 2; emailId <= 27; emailId++) await insertEmail({ emailId, subject: `dirty ${emailId}` });
		const reconciling = await search(headers, request({ query: 'dirty' }));
		expect(reconciling.status).toBe(503);
		expect(await env.db.prepare('SELECT count(*) AS total FROM email WHERE user_id = 101 AND search_dirty = 1').first('total')).toBe(1);

		const ready = await search(headers, request({ query: 'dirty' }));
		expect(ready.status).toBe(200);
		expect((await ready.json()).data.total).toBe(26);
	});

	it('rejects malformed and unbounded contracts without compiling a search', async () => {
		await addAccount();
		await insertEmail({ emailId: 1, subject: 'valid' });
		await dbInit.v3_7DB(c);
		const headers = await authorizationHeader(101);
		const oversized = 'é'.repeat(257);
		const tooManyTokens = Array.from({ length: 21 }, (_, index) => `token${index}`).join(' ');
		const malformed = [
			{ ...request(), unknown: true },
			request({ unknown: true }),
			request({}, { order: 'ranked' }),
			request({}, { pageSize: 0 }),
			request({}, { pageSize: 51 }),
			request({}, { cursor: '1' }),
			{ ...request(), generation: null },
			request({ query: oversized }),
			request({ query: tooManyTokens }),
			request({ query: '***' }),
			request({ location: 'trash' }),
			request({ hasAttachment: false }),
			request({ size: { comparator: 'gte', bytes: 1 } }),
			request({ size: { comparator: 'gt', bytes: 0 } }),
			request({ size: { comparator: 'gt', bytes: 1, unit: 'MB' } }),
			request({ date: { start: '2026-09-15', end: '2026-09-16' } }),
			request({ date: { start: '2026-02-30T00:00:00.000Z', end: '2026-03-03T00:00:00.000Z' } }),
			request({ date: { start: '2026-09-16T00:00:00Z', end: '2026-09-15T00:00:00Z' } }),
		];

		for (const body of malformed) {
			const response = await search(headers, body);
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(await response.json()).toMatchObject({ code: 400, message: 'Invalid search request' });
		}
		const exactTextLimit = await search(headers, request({ query: 'é'.repeat(256) }));
		expect(exactTextLimit.status).toBe(200);

		const malformedJson = await app.request('/email/search', {
			method: 'POST', headers, body: '{',
		}, env);
		expect(malformedJson.status).toBe(400);
		const malformedDetails = await details(headers, { generation: 1, emailIds: [1], extra: true });
		expect(malformedDetails.status).toBe(400);
	});

	it('keeps initial and follow-up rolling budgets independent, user-scoped, and expiring', async () => {
		await addAccount();
		await addAccount(20, 202);
		await insertEmail({ emailId: 1, subject: 'rate guarded' });
		await insertEmail({ emailId: 2, userId: 202, accountId: 20, subject: 'other user' });
		await dbInit.v3_7DB(c);
		const headers = await authorizationHeader(101);
		const otherHeaders = await authorizationHeader(202);
		const now = Math.floor(Date.now() / 1000);
		await env.db.prepare(`INSERT INTO email_search_rate_guard
			(user_id, scope, window_started, request_count, expires_at)
			VALUES (101, 'initial', ?, 10, ?)
		`).bind(now, now + 60).run();

		const limitedInitial = await search(headers, request({ query: 'rate' }));
		expect(limitedInitial.status).toBe(429);
		expect(Number(limitedInitial.headers.get('Retry-After'))).toBeGreaterThan(0);
		expect(await limitedInitial.json()).toMatchObject({ code: 429 });
		expect((await search(headers, request({}, { cursor: 100 }))).status).toBe(200);
		expect((await search(otherHeaders, request({ query: 'other' }))).status).toBe(200);

		await env.db.prepare(`INSERT INTO email_search_rate_guard
			(user_id, scope, window_started, request_count, expires_at)
			VALUES (101, 'followup', ?, 60, ?)
			ON CONFLICT(user_id, scope) DO UPDATE SET request_count = 60, expires_at = excluded.expires_at
		`).bind(now, now + 60).run();
		const limitedDetails = await details(headers, { generation: 1, emailIds: [1] });
		expect(limitedDetails.status).toBe(429);

		await env.db.prepare("UPDATE email_search_rate_guard SET expires_at = ? WHERE user_id = 101 AND scope = 'initial'")
			.bind(now - 1).run();
		expect((await search(headers, request({ query: 'rate' }))).status).toBe(200);
		await env.db.prepare("UPDATE email_search_rate_guard SET expires_at = ? WHERE user_id = 101 AND scope = 'followup'")
			.bind(now - 1).run();
		expect((await details(headers, { generation: 1, emailIds: [1] })).status).toBe(200);
	});

	it('keeps unauthenticated failures private and echoes generations on maximum bounded requests', async () => {
		await addAccount();
		for (let emailId = 1; emailId <= 50; emailId++) await insertEmail({ emailId, subject: `bounded ${emailId}` });
		await dbInit.v3_7DB(c);

		const unauthorized = await search({ Authorization: 'invalid', 'Content-Type': 'application/json' }, request());
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toMatchObject({ code: 401 });
		expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store');
		const unauthorizedDetails = await details({ Authorization: 'invalid', 'Content-Type': 'application/json' }, {
			generation: 1, emailIds: [1],
		});
		expect(unauthorizedDetails.status).toBe(401);
		expect(unauthorizedDetails.headers.get('Cache-Control')).toBe('private, no-store');

		const headers = await authorizationHeader(101);
		const twentyTokens = Array.from({ length: 20 }, (_, index) => `bounded${index}`).join(' ');
		const maximumPage = await search(headers, request({ query: twentyTokens }, { generation: 'maximum', pageSize: 50 }));
		expect(maximumPage.status).toBe(200);
		expect((await maximumPage.json()).data.generation).toBe('maximum');
		const maximumDetails = await details(headers, {
			generation: 'maximum', emailIds: Array.from({ length: 50 }, (_, index) => 50 - index),
		});
		expect(maximumDetails.status).toBe(200);
		expect((await maximumDetails.json()).data.list.map(row => row.emailId)).toEqual(
			Array.from({ length: 50 }, (_, index) => 50 - index),
		);
	});
});
