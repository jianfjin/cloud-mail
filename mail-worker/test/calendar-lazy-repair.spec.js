import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbInit } from '../src/init/init';
import calendarPreviewService from '../src/service/calendar-preview-service';
import { CALENDAR_LIMITS } from '../src/utils/calendar-utils';
import kvObjService from '../src/service/kv-obj-service';
import r2Service from '../src/service/r2-service';
import s3Service from '../src/service/s3-service';
import settingService from '../src/service/setting-service';
import app from '../src/hono/webs';
import jwtUtils from '../src/utils/jwt-utils';
import KvConst from '../src/const/kv-const';
import calendarResponseService from '../src/service/calendar-response-service';

const c = { env };
const encode = value => new TextEncoder().encode(value);
const invitation = [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'METHOD:REQUEST',
	'BEGIN:VEVENT',
	'UID:legacy@example.com',
	'DTSTART:20260901T080000Z',
	'DTEND:20260901T090000Z',
	'SUMMARY:Legacy planning call',
	'CONFERENCE:https://meet.google.com/legacy-room',
	'END:VEVENT',
	'END:VCALENDAR',
].join('\r\n');

async function resetSchema() {
	await env.db.prepare('DROP TABLE IF EXISTS role_perm').run();
	await env.db.prepare('DROP TABLE IF EXISTS perm').run();
	await env.db.prepare('DROP TABLE IF EXISTS role').run();
	await env.db.prepare('DROP TABLE IF EXISTS user').run();
	await env.db.prepare('DROP TABLE IF EXISTS calendar_response').run();
	await env.db.prepare('DROP TABLE IF EXISTS calendar_provider').run();
	await env.db.prepare('DROP TABLE IF EXISTS calendar_repair_guard').run();
	await env.db.prepare('DROP TABLE IF EXISTS attachments').run();
	await env.db.prepare('DROP TABLE IF EXISTS email').run();
	await env.db.prepare(`
		CREATE TABLE email (
			email_id INTEGER PRIMARY KEY,
			user_id INTEGER NOT NULL,
			is_del INTEGER NOT NULL DEFAULT 0
		)
	`).run();
	await env.db.prepare(`
		CREATE TABLE attachments (
			att_id INTEGER PRIMARY KEY,
			user_id INTEGER NOT NULL,
			email_id INTEGER NOT NULL,
			key TEXT NOT NULL,
			filename TEXT,
			mime_type TEXT,
			size INTEGER,
			type INTEGER NOT NULL DEFAULT 0,
			content_id TEXT
		)
	`).run();
	await dbInit.v3_5DB(c);
	await dbInit.v3_6DB(c);
	await env.db.prepare('CREATE TABLE user (user_id INTEGER PRIMARY KEY, type INTEGER NOT NULL)').run();
	await env.db.prepare('CREATE TABLE role (role_id INTEGER PRIMARY KEY)').run();
	await env.db.prepare('CREATE TABLE role_perm (role_id INTEGER, perm_id INTEGER)').run();
	await env.db.prepare('CREATE TABLE perm (perm_id INTEGER PRIMARY KEY, perm_key TEXT, type INTEGER)').run();
}

async function insertEmail(emailId, userId, { deleted = false, calendarData = null } = {}) {
	await env.db.prepare('INSERT INTO email (email_id, user_id, is_del, calendar_data) VALUES (?, ?, ?, ?)')
		.bind(emailId, userId, deleted ? 1 : 0, calendarData).run();
}

async function insertAttachment(emailId, userId, {
	key = `attachments/${emailId}.ics`,
	filename = 'invite.ics',
	mimeType = 'text/calendar',
	size = encode(invitation).byteLength,
	method = 'REQUEST',
} = {}) {
	await env.db.prepare(`
		INSERT INTO attachments
			(att_id, user_id, email_id, key, filename, mime_type, size, type, content_id, calendar_method)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
	`).bind(emailId, userId, emailId, key, filename, mimeType, size, method).run();
}

function objectService(value = invitation) {
	return {
		getObj: vi.fn(async (_c, _key, options) => {
			const bytes = typeof value === 'string' ? encode(value) : value;
			return new Response(bytes.slice(0, options.maxBytes));
		}),
	};
}

async function authorizationHeader(userId = 101) {
	const sessionToken = `session-${userId}`;
	const token = await jwtUtils.generateToken(c, { userId, token: sessionToken });
	await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({
		tokens: [sessionToken],
		user: { userId, email: `user-${userId}@example.com` },
		refreshTime: new Date().toISOString(),
	}));
	return { Authorization: token, 'Content-Type': 'application/json' };
}

async function adminAuthorizationHeader() {
	const userId = 1;
	const sessionToken = 'admin-session';
	const token = await jwtUtils.generateToken(c, {userId, token: sessionToken});
	await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({
		tokens: [sessionToken],
		user: {userId, email: 'admin@example.com'},
		refreshTime: new Date().toISOString(),
	}));
	return {Authorization: token, 'Content-Type': 'application/json'};
}

describe('historical calendar invitation repair', () => {
	beforeEach(resetSchema);

	it('authorizes the owner, persists one canonical preview, and makes repeat opens storage-free', async () => {
		await insertEmail(1, 101);
		await insertAttachment(1, 101);
		const storage = objectService();

		const first = await calendarPreviewService.getPreview(c, { emailId: 1, userId: 101, objectService: storage });
		const second = await calendarPreviewService.getPreview(c, { emailId: 1, userId: 101, objectService: storage });

		expect(first).toMatchObject({ status: 'ok', envelope: { events: [{ summary: 'Legacy planning call', meetingLink: {trust: 'trusted', provider: 'google-meet'} }] } });
		expect(second).toEqual(first);
		expect(storage.getObj).toHaveBeenCalledTimes(1);
		expect(storage.getObj).toHaveBeenCalledWith(c, 'attachments/1.ics', { maxBytes: CALENDAR_LIMITS.contentBytes + 1 });
		const stored = await env.db.prepare('SELECT calendar_data FROM email WHERE email_id = 1').first();
		expect(JSON.parse(stored.calendar_data)).toMatchObject({events: [{meetingLink: {trust: 'unverified', provider: 'google-meet'}}]});
	});

	it('returns the same not-found result for missing, foreign, and deleted messages without reading objects', async () => {
		await insertEmail(2, 202);
		await insertAttachment(2, 202);
		await insertEmail(3, 101, { deleted: true });
		await insertAttachment(3, 101);
		const storage = objectService();

		const missing = await calendarPreviewService.getPreview(c, { emailId: 999, userId: 101, objectService: storage });
		const foreign = await calendarPreviewService.getPreview(c, { emailId: 2, userId: 101, objectService: storage });
		const deleted = await calendarPreviewService.getPreview(c, { emailId: 3, userId: 101, objectService: storage });

		expect(missing).toEqual({ status: 'not_found' });
		expect(foreign).toEqual(missing);
		expect(deleted).toEqual(missing);
		expect(storage.getObj).not.toHaveBeenCalled();
	});

	it('rejects oversized metadata before retrieval and caps forged-small object reads', async () => {
		await insertEmail(4, 101);
		await insertAttachment(4, 101, { size: CALENDAR_LIMITS.contentBytes + 1 });
		const untouchedStorage = objectService();
		const metadataResult = await calendarPreviewService.getPreview(c, { emailId: 4, userId: 101, objectService: untouchedStorage });

		expect(metadataResult).toMatchObject({ status: 'ok', envelope: { state: 'failed' } });
		expect(untouchedStorage.getObj).not.toHaveBeenCalled();

		await insertEmail(5, 101);
		await insertAttachment(5, 101, { size: 1 });
		const largeStorage = objectService(new Uint8Array(CALENDAR_LIMITS.contentBytes + 1));
		const bodyResult = await calendarPreviewService.getPreview(c, { emailId: 5, userId: 101, objectService: largeStorage });

		expect(bodyResult).toMatchObject({ status: 'ok', envelope: { state: 'failed' } });
		expect(largeStorage.getObj).toHaveBeenCalledWith(c, 'attachments/5.ics', { maxBytes: CALENDAR_LIMITS.contentBytes + 1 });
	});

	it('keeps transient failures retryable but enforces a durable retry cooldown', async () => {
		await insertEmail(6, 101);
		await insertAttachment(6, 101);
		const storage = { getObj: vi.fn(async () => { throw new Error('private storage detail'); }) };

		const first = await calendarPreviewService.getPreview(c, { emailId: 6, userId: 101, objectService: storage });
		const second = await calendarPreviewService.getPreview(c, { emailId: 6, userId: 101, objectService: storage });

		expect(first).toMatchObject({ status: 'retryable', envelope: { state: 'failed' } });
		expect(JSON.stringify(first)).not.toContain('private storage detail');
		expect(second).toEqual({ status: 'rate_limited' });
		expect(storage.getObj).toHaveBeenCalledTimes(1);
		const stored = await env.db.prepare('SELECT calendar_data FROM email WHERE email_id = 6').first();
		expect(stored.calendar_data).toBeNull();
	});

	it('reparses incompatible envelopes and concurrent requests converge on the canonical stored result', async () => {
		const stale = JSON.stringify({ schemaVersion: 1, parserVersion: 'old', state: 'failed', sources: [], events: [], warnings: [] });
		await insertEmail(7, 101, { calendarData: stale });
		await insertAttachment(7, 101);
		const storage = objectService();

		const [left, right] = await Promise.all([
			calendarPreviewService.getPreview(c, { emailId: 7, userId: 101, objectService: storage }),
			calendarPreviewService.getPreview(c, { emailId: 7, userId: 101, objectService: storage }),
		]);

		expect(left.status).toBe('ok');
		expect(right).toEqual(left);
		expect(left.envelope.parserVersion).not.toBe('old');
	});

	it('does not publish a preview when ownership changes during the object read', async () => {
		await insertEmail(8, 101);
		await insertAttachment(8, 101);
		const storage = {
			getObj: vi.fn(async (_c, _key, options) => {
				await env.db.prepare('UPDATE email SET user_id = 202 WHERE email_id = 8').run();
				return new Response(encode(invitation).slice(0, options.maxBytes));
			}),
		};

		const result = await calendarPreviewService.getPreview(c, { emailId: 8, userId: 101, objectService: storage });

		expect(result).toEqual({ status: 'not_found' });
		const stored = await env.db.prepare('SELECT calendar_data FROM email WHERE email_id = 8').first();
		expect(stored.calendar_data).toBeNull();
	});

	it('normalizes all owned calendar parts and ignores non-calendar attachment rows', async () => {
		await insertEmail(9, 101);
		await insertAttachment(9, 101, { key: 'attachments/first.ics', filename: null });
		await env.db.prepare(`
			INSERT INTO attachments
				(att_id, user_id, email_id, key, filename, mime_type, size, type, content_id, calendar_method)
			VALUES (90, 101, 9, 'attachments/notes.txt', 'notes.txt', 'text/plain', 5, 0, NULL, NULL)
		`).run();
		const second = invitation.replace('legacy@example.com', 'legacy-2@example.com').replace('Legacy planning call', 'Second call');
		await env.db.prepare(`
			INSERT INTO attachments
				(att_id, user_id, email_id, key, filename, mime_type, size, type, content_id, calendar_method)
			VALUES (91, 101, 9, 'attachments/second.ics', NULL, 'application/ics', ?, 0, NULL, 'REQUEST')
		`).bind(encode(second).byteLength).run();
		const storage = {
			getObj: vi.fn(async (_c, key, options) => new Response(encode(key.includes('second') ? second : invitation).slice(0, options.maxBytes))),
		};

		const result = await calendarPreviewService.getPreview(c, { emailId: 9, userId: 101, objectService: storage });

		expect(result.envelope.events.map(event => event.summary)).toEqual(['Legacy planning call', 'Second call']);
		expect(storage.getObj).toHaveBeenCalledTimes(2);
	});

	it('requests bounded reads from KV, R2, and S3 adapters', async () => {
		const bytes = encode(invitation);
		const kvGet = vi.fn(async () => ({ value: new Response(bytes).body, metadata: {} }));
		await kvObjService.getObj({ env: { kv: { getWithMetadata: kvGet } } }, 'calendar.ics', { maxBytes: 100 });
		expect(kvGet).toHaveBeenCalledWith('calendar.ics', { type: 'stream' });

		const r2Get = vi.fn(async () => ({ body: new Response(bytes).body, httpMetadata: {} }));
		const storageTypeSpy = vi.spyOn(r2Service, 'storageType').mockResolvedValue('R2');
		await r2Service.getObj({ env: { r2: { get: r2Get } } }, 'calendar.ics', { maxBytes: 100 });
		expect(r2Get).toHaveBeenCalledWith('calendar.ics', { range: { offset: 0, length: 100 } });
		storageTypeSpy.mockRestore();

		const send = vi.fn(async () => ({ Body: new Response(bytes).body }));
		const clientSpy = vi.spyOn(s3Service, 'client').mockResolvedValue({ send });
		const settingSpy = vi.spyOn(settingService, 'query').mockResolvedValue({ bucket: 'mail' });
		await s3Service.getObj({}, 'calendar.ics', { maxBytes: 100 });
		expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: 'mail', Key: 'calendar.ics', Range: 'bytes=0-99' });
		clientSpy.mockRestore();
		settingSpy.mockRestore();
	});

	it('keeps unauthenticated, malformed, and not-found API responses non-cacheable and generic', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const unauthorized = await app.request('/email/calendar-preview', {
			method: 'POST',
			headers: { Authorization: 'invalid', 'Content-Type': 'application/json' },
			body: JSON.stringify({ emailId: 1 }),
		}, env);
		expect((await unauthorized.json()).code).toBe(401);
		expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store');

		const headers = await authorizationHeader();
		const malformed = await app.request('/email/calendar-preview', {
			method: 'POST',
			headers,
			body: JSON.stringify({ emailId: 1, key: 'attacker-selected' }),
		}, env);
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ code: 400, message: 'Invalid request' });
		expect(malformed.headers.get('Cache-Control')).toBe('private, no-store');

		const missing = await app.request('/email/calendar-preview', {
			method: 'POST',
			headers,
			body: JSON.stringify({ emailId: 999 }),
		}, env);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ code: 404, message: 'Not found' });
		expect(missing.headers.get('Cache-Control')).toBe('private, no-store');
		logSpy.mockRestore();
	});

	it('binds RSVP mutations to the authenticated user and restricts provider administration', async () => {
		const respond = vi.spyOn(calendarResponseService, 'respond').mockResolvedValue({responseId: 7, deliveryState: 'delivered'});
		const recipientHeaders = await authorizationHeader(202);
		const response = await app.request('/email/calendar-response', {
			method: 'POST',
			headers: recipientHeaders,
			body: JSON.stringify({emailId: 1, eventUid: 'event-1', accountId: 11, participationStatus: 'ACCEPTED'}),
		}, env);
		expect(await response.json()).toMatchObject({code: 200, data: {responseId: 7}});
		expect(respond).toHaveBeenCalledWith(expect.anything(), {
			emailId: 1, eventUid: 'event-1', accountId: 11, participationStatus: 'ACCEPTED',
		}, 202);

		await env.db.prepare('INSERT INTO user (user_id, type) VALUES (202, 1)').run();
		const denied = await app.request('/calendar/providers', {headers: recipientHeaders}, env);
		expect((await denied.json()).code).toBe(403);

		const adminHeaders = await adminAuthorizationHeader();
		const created = await app.request('/calendar/providers', {
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({host: 'video.example.net', label: 'Example Video'}),
		}, env);
		const createdBody = await created.json();
		expect(createdBody).toMatchObject({code: 200, data: {host: 'video.example.net', enabled: 1}});

		const updated = await app.request('/calendar/providers/' + createdBody.data.providerId, {
			method: 'PUT',
			headers: adminHeaders,
			body: JSON.stringify({enabled: false}),
		}, env);
		expect(await updated.json()).toMatchObject({code: 200, data: {enabled: 0}});
	});
});
