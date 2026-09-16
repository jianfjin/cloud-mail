import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbInit } from '../src/init/init';
import emailSearchIndexService from '../src/service/email-search-index-service';
import emailService from '../src/service/email-service';
import mailboxSearchMigration from '../migrations/20260915_v3_7_mailbox_search.sql?raw';

const c = { env };

async function resetLegacyEmailSchema() {
	await env.db.prepare('DROP TRIGGER IF EXISTS email_search_dirty_after_update').run();
	await env.db.prepare('DROP TABLE IF EXISTS email_search_token_fixture').run();
	await env.db.prepare('DROP TABLE IF EXISTS email_search_token_probe').run();
	await env.db.prepare('DROP TABLE IF EXISTS email_search_fts').run();
	await env.db.prepare('DROP TABLE IF EXISTS email_search_meta').run();
	await env.db.prepare('DROP TABLE IF EXISTS email_search_rate_guard').run();
	await env.db.prepare('DROP TABLE IF EXISTS calendar_response').run();
	await env.db.prepare('DROP TABLE IF EXISTS calendar_repair_guard').run();
	await env.db.prepare('DROP TABLE IF EXISTS attachments').run();
	await env.db.prepare('DROP TABLE IF EXISTS star').run();
	await env.db.prepare('DROP TABLE IF EXISTS email').run();
	await env.db.prepare(`
		CREATE TABLE email (
			email_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			send_email TEXT,
			name TEXT,
			account_id INTEGER NOT NULL,
			user_id INTEGER NOT NULL,
			subject TEXT,
			code TEXT NOT NULL DEFAULT '',
			text TEXT,
			content TEXT,
			calendar_data TEXT,
			cc TEXT DEFAULT '[]',
			bcc TEXT DEFAULT '[]',
			recipient TEXT,
			to_email TEXT NOT NULL DEFAULT '',
			to_name TEXT NOT NULL DEFAULT '',
			in_reply_to TEXT DEFAULT '',
			relation TEXT DEFAULT '',
			message_id TEXT DEFAULT '',
			type INTEGER NOT NULL DEFAULT 0,
			status INTEGER NOT NULL DEFAULT 0,
			resend_email_id TEXT,
			message TEXT,
			unread INTEGER NOT NULL DEFAULT 0,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			is_del INTEGER NOT NULL DEFAULT 0
		)
	`).run();
}

async function insertEmail({
	emailId,
	userId = 100,
	accountId = 10,
	subject = '',
	text = '',
	content = '',
	type = 0,
} = {}) {
	return env.db.prepare(`
		INSERT INTO email (
			email_id, account_id, user_id, send_email, name, to_email, to_name,
			recipient, subject, text, content, type
		) VALUES (?, ?, ?, 'sender@example.com', 'Sender', 'owner@example.com', 'Owner',
			'[{"address":"owner@example.com"}]', ?, ?, ?, ?)
	`).bind(emailId, accountId, userId, subject, text, content, type).run();
}

async function ftsIds(query) {
	const result = await env.db.prepare(`
		SELECT CAST(email_id AS INTEGER) AS email_id
		FROM email_search_fts
		WHERE email_search_fts MATCH ?
		ORDER BY rowid
	`).bind(query).all();
	return result.results.map(row => row.email_id);
}

async function createDeleteDependencies() {
	await env.db.prepare(`
		CREATE TABLE calendar_repair_guard (
			email_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
			window_started INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
			retry_after INTEGER NOT NULL DEFAULT 0
		)
	`).run();
	await dbInit.v3_6DB(c);
	await env.db.prepare(`
		CREATE TABLE attachments (
			att_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL, key TEXT NOT NULL, type INTEGER NOT NULL DEFAULT 0
		)
	`).run();
	await env.db.prepare(`
		CREATE TABLE star (
			star_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
		)
	`).run();
}

function migrationStatements(sql) {
	const statements = [];
	let current = [];
	let trigger = false;
	for (const sourceLine of sql.split('\n')) {
		const line = sourceLine.trim();
		if (!line || line.startsWith('--')) continue;
		if (/^CREATE TRIGGER\b/i.test(line)) trigger = true;
		current.push(sourceLine);
		const complete = line.endsWith(';') && (!trigger || /^END;$/i.test(line));
		if (!complete) continue;
		statements.push(current.join('\n'));
		current = [];
		trigger = false;
	}
	if (current.some(line => line.trim())) statements.push(current.join('\n'));
	return statements;
}

describe('source-first mailbox search index', () => {
	beforeEach(resetLegacyEmailSchema);

	it('reports controlled unavailability before any generation is installed', async () => {
		expect(await emailSearchIndexService.userReadiness(c, 100)).toEqual({
			ready: false,
			reason: 'INDEX_NOT_READY',
		});
	});

	it('uses unicode61 whole-token semantics and treats punctuation as token boundaries', async () => {
		await env.db.prepare("CREATE VIRTUAL TABLE email_search_token_fixture USING fts5(value, tokenize='unicode61')").run();
		try {
			await env.db.prepare(`INSERT INTO email_search_token_fixture(rowid, value) VALUES
				(1, 'Café alphabet Привет'),
				(2, '项目更新 alice@example.com alpha-beta quote\"mark wild*card')
			`).run();

			const matches = async (query) => {
				const result = await env.db.prepare('SELECT rowid FROM email_search_token_fixture WHERE email_search_token_fixture MATCH ? ORDER BY rowid')
					.bind(query).all();
				return result.results.map(({ rowid }) => rowid);
			};

			expect(await matches('"CAFÉ"')).toEqual([1]);
			expect(await matches('"alpha"')).toEqual([2]);
			expect(await matches('"alphabet"')).toEqual([1]);
			expect(await matches('"alph"')).toEqual([]);
			expect(await matches('"ПРИВЕТ"')).toEqual([1]);
			expect(await matches('"项目更新"')).toEqual([2]);
			expect(await matches('"项目"')).toEqual([]);
			expect(await matches('"alice" AND "example" AND "com"')).toEqual([2]);
			expect(await matches('"alpha" AND "beta"')).toEqual([2]);
			expect(await matches('"quote" AND "mark"')).toEqual([2]);
			expect(await matches('"wild" AND "card"')).toEqual([2]);
		} finally {
			await env.db.prepare('DROP TABLE IF EXISTS email_search_token_fixture').run();
		}
	});

	it('upgrades a populated legacy schema into a verified searchable generation', async () => {
		await env.db.prepare(`
			INSERT INTO email (email_id, account_id, user_id, send_email, name, to_email, to_name, recipient, subject, text, content)
			VALUES
				(1, 10, 100, 'sender@example.com', 'Sender', 'owner@example.com', 'Owner', '[{"address":"owner@example.com"}]', 'Plain subject', 'plain needle', '<p>ignored fallback</p>'),
				(2, 10, 100, 'sender@example.com', 'Sender', 'owner@example.com', 'Owner', '[{"address":"owner@example.com"}]', 'HTML subject', '', '<p>html fallback needle</p>')
		`).run();

		await dbInit.v3_7DB(c);

		const columns = await env.db.prepare('PRAGMA table_info(email)').all();
		const meta = await env.db.prepare('SELECT state, schema_fingerprint FROM email_search_meta WHERE id = 1').first();
		const dirty = await env.db.prepare('SELECT email_id, search_dirty FROM email ORDER BY email_id').all();
		const indexes = await env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_email_search_%' ORDER BY name").all();
		const rateColumns = await env.db.prepare('PRAGMA table_info(email_search_rate_guard)').all();
		const textHit = await env.db.prepare("SELECT email_id FROM email_search_fts WHERE email_search_fts MATCH '\"plain\" AND \"needle\"'").all();
		const htmlHit = await env.db.prepare("SELECT email_id FROM email_search_fts WHERE email_search_fts MATCH '\"html\" AND \"fallback\" AND \"needle\"'").all();

		expect(columns.results.some(column => column.name === 'search_dirty' && column.dflt_value === '1')).toBe(true);
		expect(meta).toMatchObject({ state: 'READY' });
		expect(meta.schema_fingerprint).toContain('unicode61');
		expect(dirty.results).toEqual([
			{ email_id: 1, search_dirty: 0 },
			{ email_id: 2, search_dirty: 0 },
		]);
		expect(textHit.results).toEqual([{ email_id: 1 }]);
		expect(htmlHit.results).toEqual([{ email_id: 2 }]);
		expect(indexes.results.map(row => row.name)).toEqual([
			'idx_email_search_dirty_user',
			'idx_email_search_rate_expiry',
		]);
		expect(rateColumns.results.map(column => column.name)).toEqual([
			'user_id', 'scope', 'window_started', 'request_count', 'expires_at',
		]);
	});

	it('keeps the checked-in schema-first migration executable in the target runtime', async () => {
		await insertEmail({ emailId: 1, subject: 'migration fixture', content: '<p>migration html fallback</p>' });

		for (const statement of migrationStatements(mailboxSearchMigration)) {
			await env.db.prepare(statement).run();
		}

		expect(await ftsIds('"migration" AND "fallback"')).toEqual([1]);
		expect(await env.db.prepare('SELECT search_dirty FROM email WHERE email_id = 1').first('search_dirty')).toBe(0);
		expect(await env.db.prepare('SELECT state FROM email_search_meta WHERE id = 1').first('state')).toBe('READY');
	});

	it('re-runs a healthy upgrade without rebuilding or changing the generation', async () => {
		await insertEmail({ emailId: 1, subject: 'stable generation' });
		const first = await dbInit.v3_7DB(c);
		const before = await env.db.prepare('SELECT generation, verified_time FROM email_search_meta WHERE id = 1').first();

		const second = await dbInit.v3_7DB(c);
		const after = await env.db.prepare('SELECT generation, verified_time FROM email_search_meta WHERE id = 1').first();

		expect(first).toMatchObject({ rebuilt: true, state: 'READY' });
		expect(second).toMatchObject({ rebuilt: false, state: 'READY' });
		expect(after).toEqual(before);
		expect(await ftsIds('"stable" AND "generation"')).toEqual([1]);
	});

	it('reconciles only the requested user in bounded chunks and never exposes partial readiness', async () => {
		await dbInit.v3_7DB(c);
		for (let emailId = 1; emailId <= 26; emailId++) {
			await insertEmail({ emailId, userId: 100, subject: `bounded token${emailId}` });
		}
		await insertEmail({ emailId: 1000, userId: 200, subject: 'other owner' });

		const otherUser = await emailSearchIndexService.userReadiness(c, 200);
		const firstPass = await emailSearchIndexService.userReadiness(c, 100);
		const remaining = await env.db.prepare('SELECT email_id FROM email WHERE user_id = 100 AND search_dirty = 1 ORDER BY email_id').all();

		expect(otherUser).toEqual({ ready: true, reason: null });
		expect(firstPass).toEqual({ ready: false, reason: 'USER_RECONCILING' });
		expect(remaining.results).toEqual([{ email_id: 26 }]);
		expect(await ftsIds('"other" AND "owner"')).toEqual([1000]);

		expect(await emailSearchIndexService.userReadiness(c, 100)).toEqual({ ready: true, reason: null });
		expect(await ftsIds('"bounded"')).toHaveLength(26);
	});

	it('keeps new source writes durable while FTS is missing, then rebuilds deterministically', async () => {
		await dbInit.v3_7DB(c);
		await env.db.prepare('DROP TABLE email_search_fts').run();

		await emailService.receive(c, {
			emailId: 1, accountId: 10, userId: 100, toEmail: 'owner@example.com',
			sendEmail: 'outside@example.com', subject: 'received durable', text: 'receive body', type: 0,
		}, [], null);
		await emailService.receive(c, {
			emailId: 2, accountId: 10, userId: 100, toEmail: 'outside@example.com',
			sendEmail: 'owner@example.com', subject: 'sent durable', text: 'send body', type: 1,
		}, [], null);
		await emailService.receive(c, {
			emailId: 3, accountId: 11, userId: 200, toEmail: 'local@example.com',
			sendEmail: 'owner@example.com', subject: 'internal durable', text: 'internal body', type: 0,
		}, [], null);

		const source = await env.db.prepare('SELECT email_id, search_dirty FROM email ORDER BY email_id').all();
		expect(source.results).toEqual([
			{ email_id: 1, search_dirty: 1 },
			{ email_id: 2, search_dirty: 1 },
			{ email_id: 3, search_dirty: 1 },
		]);
		expect(await emailSearchIndexService.userReadiness(c, 100)).toEqual({ ready: false, reason: 'INDEX_NOT_READY' });

		await dbInit.v3_7DB(c);
		expect(await ftsIds('"durable"')).toEqual([1, 2, 3]);
		expect(await env.db.prepare('SELECT COUNT(*) AS total FROM email WHERE search_dirty = 1').first('total')).toBe(0);
		expect((await env.db.prepare('SELECT state FROM email_search_meta WHERE id = 1').first()).state).toBe('READY');
	});

	it('marks searchable updates dirty atomically but leaves status-only updates clean', async () => {
		await insertEmail({ emailId: 1, subject: 'old phrase', text: 'old body' });
		await dbInit.v3_7DB(c);

		await env.db.prepare("UPDATE email SET subject = 'new phrase', text = 'new body' WHERE email_id = 1").run();
		expect(await env.db.prepare('SELECT search_dirty FROM email WHERE email_id = 1').first('search_dirty')).toBe(1);
		expect(await emailSearchIndexService.userReadiness(c, 100)).toEqual({ ready: true, reason: null });
		expect(await ftsIds('"old"')).toEqual([]);
		expect(await ftsIds('"new"')).toEqual([1]);

		await env.db.prepare('UPDATE email SET status = 3, unread = 1 WHERE email_id = 1').run();
		expect(await env.db.prepare('SELECT search_dirty FROM email WHERE email_id = 1').first('search_dirty')).toBe(0);
		expect(await ftsIds('"new"')).toEqual([1]);
	});

	it('clears dirty markers only when the replacement batch succeeds and retries idempotently', async () => {
		await dbInit.v3_7DB(c);
		await insertEmail({ emailId: 1, subject: 'retryable replacement' });
		const batch = vi.spyOn(env.db, 'batch').mockRejectedValueOnce(new Error('injected batch failure'));

		await expect(emailSearchIndexService.reconcileDirty(c, { userId: 100 })).rejects.toThrow('injected batch failure');
		expect(await env.db.prepare('SELECT search_dirty FROM email WHERE email_id = 1').first('search_dirty')).toBe(1);
		expect(await ftsIds('"retryable"')).toEqual([]);
		batch.mockRestore();

		await dbInit.v3_7DB(c);
		await emailSearchIndexService.reconcileDirty(c, { userId: 100 });
		await emailSearchIndexService.reconcileDirty(c, { userId: 100 });
		expect(await env.db.prepare('SELECT search_dirty FROM email WHERE email_id = 1').first('search_dirty')).toBe(0);
		expect(await ftsIds('"retryable"')).toEqual([1]);
	});

	it('never marks an interrupted rebuild ready and recovers again from source', async () => {
		await dbInit.v3_7DB(c);
		await insertEmail({ emailId: 1, subject: 'rebuild recovery' });
		const originalBatch = env.db.batch.bind(env.db);
		const batch = vi.spyOn(env.db, 'batch')
			.mockImplementationOnce(statements => originalBatch(statements))
			.mockRejectedValueOnce(new Error('injected rebuild interruption'));

		await expect(emailSearchIndexService.rebuild(c)).rejects.toThrow('injected rebuild interruption');
		expect(await env.db.prepare('SELECT state FROM email_search_meta WHERE id = 1').first('state')).toBe('NOT_READY');
		expect(await env.db.prepare('SELECT subject, search_dirty FROM email WHERE email_id = 1').first()).toEqual({
			subject: 'rebuild recovery',
			search_dirty: 1,
		});
		batch.mockRestore();

		await dbInit.v3_7DB(c);
		expect(await env.db.prepare('SELECT state FROM email_search_meta WHERE id = 1').first('state')).toBe('READY');
		expect(await ftsIds('"rebuild" AND "recovery"')).toEqual([1]);
	});

	it('keeps physical deletion authoritative when index cleanup fails and later removes the orphan', async () => {
		await createDeleteDependencies();
		await insertEmail({ emailId: 1, subject: 'delete survivor' });
		await dbInit.v3_7DB(c);
		const cleanup = vi.spyOn(emailSearchIndexService, 'removeDocumentsBestEffort')
			.mockRejectedValueOnce(new Error('injected cleanup failure'));

		await expect(emailService.physicsDelete(c, { emailIds: '1' })).resolves.toBeUndefined();
		expect(await env.db.prepare('SELECT email_id FROM email WHERE email_id = 1').first()).toBeNull();
		expect(await ftsIds('"survivor"')).toEqual([1]);
		cleanup.mockRestore();

		expect(await emailSearchIndexService.scheduledMaintenance(c)).toBe(true);
		expect(await ftsIds('"survivor"')).toEqual([]);
	});

	it('leaves bulk user and account FTS cleanup to bounded scheduled maintenance', async () => {
		await createDeleteDependencies();
		await insertEmail({ emailId: 1, userId: 100, accountId: 10, subject: 'bulk user delete' });
		await insertEmail({ emailId: 2, userId: 200, accountId: 20, subject: 'bulk account delete' });
		const prepare = vi.spyOn(env.db, 'prepare');
		const cleanup = vi.spyOn(emailSearchIndexService, 'removeDocumentsBestEffort').mockResolvedValue(true);

		try {
			await emailService.physicsDeleteUserIds(c, [100]);
			await emailService.physicsDeleteByAccountId(c, 20);

			const eagerIdQueries = prepare.mock.calls
				.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim())
				.filter(sql => /^select "email_id" from "email" where /i.test(sql));
			expect(eagerIdQueries).toEqual([]);
			expect(cleanup).not.toHaveBeenCalled();
			expect(await env.db.prepare('SELECT email_id FROM email ORDER BY email_id').all()).toMatchObject({ results: [] });
		} finally {
			prepare.mockRestore();
			cleanup.mockRestore();
		}
	});

	it('never indexes attachment rows or their object metadata', async () => {
		await env.db.prepare(`
			CREATE TABLE attachments (
				att_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL,
				account_id INTEGER NOT NULL, key TEXT NOT NULL, filename TEXT, type INTEGER NOT NULL DEFAULT 0
			)
		`).run();
		await insertEmail({ emailId: 1, subject: 'ordinary message' });
		await env.db.prepare(`
			INSERT INTO attachments (att_id, user_id, email_id, account_id, key, filename)
			VALUES (1, 100, 1, 10, 'objects/attachment-secret-token', 'attachment-secret-token.txt')
		`).run();

		await dbInit.v3_7DB(c);
		expect(await ftsIds('"attachment" OR "secret" OR "token"')).toEqual([]);
	});
});
