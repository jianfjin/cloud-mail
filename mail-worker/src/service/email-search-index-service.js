const INDEX_TABLE = 'email_search_fts';
const META_TABLE = 'email_search_meta';
const TOKENIZER = 'unicode61';
const SCHEMA_FINGERPRINT = 'mailbox-search-v1:unicode61:no-prefix:contentful';
const OPPORTUNISTIC_LIMIT = 25;
const SCHEDULED_LIMIT = 250;

const SOURCE_COLUMNS = [
	'send_email',
	'name',
	'to_email',
	'to_name',
	'recipient',
	'cc',
	'bcc',
	'subject',
	'text',
	'content',
];

const SELECT_SOURCE_SQL = `
	SELECT email_id, send_email, name, to_email, to_name,
		recipient, cc, bcc, subject, text, content
	FROM email
`;

const CREATE_FTS_SQL = `
	CREATE VIRTUAL TABLE ${INDEX_TABLE} USING fts5(
		email_id UNINDEXED,
		sender,
		recipients,
		subject,
		body_text,
		body_html,
		tokenize='${TOKENIZER}'
	)
`;

function context(value) {
	return value?.env?.db ? value : { env: value };
}

function boundedLimit(limit, maximum) {
	const parsed = Number(limit);
	if (!Number.isInteger(parsed) || parsed < 1) return maximum;
	return Math.min(parsed, maximum);
}

function sourceValues(row) {
	const text = row.text || '';
	return [
		row.email_id,
		[row.send_email, row.name].filter(Boolean).join(' '),
		[row.to_email, row.to_name, row.recipient, row.cc, row.bcc].filter(Boolean).join(' '),
		row.subject || '',
		text,
		text.trim() ? '' : (row.content || ''),
	];
}

function insertStatement(db, row) {
	return db.prepare(`
		INSERT INTO ${INDEX_TABLE}
			(rowid, email_id, sender, recipients, subject, body_text, body_html)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).bind(row.email_id, ...sourceValues(row));
}

function sourceStillMatchesStatement(db, row) {
	return db.prepare(`
		UPDATE email
		SET search_dirty = 0
		WHERE email_id = ?
			AND search_dirty = 1
			AND send_email IS ?
			AND name IS ?
			AND to_email IS ?
			AND to_name IS ?
			AND recipient IS ?
			AND cc IS ?
			AND bcc IS ?
			AND subject IS ?
			AND text IS ?
			AND content IS ?
	`).bind(row.email_id, ...SOURCE_COLUMNS.map(column => row[column]));
}

async function tableSql(db, name) {
	return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
		.bind(name).first('sql');
}

function currentFtsSchema(sql) {
	if (!sql) return false;
	const normalized = sql.toLowerCase().replace(/\s+/g, ' ');
	return normalized.includes(`create virtual table ${INDEX_TABLE}`)
		&& normalized.includes('using fts5')
		&& normalized.includes('email_id unindexed')
		&& normalized.includes("tokenize='unicode61'")
		&& !normalized.includes('prefix=');
}

async function markState(c, state, lastError = '') {
	const { db } = context(c).env;
	await db.prepare(`
		UPDATE ${META_TABLE}
		SET state = ?, schema_fingerprint = ?, last_error = ?, update_time = CURRENT_TIMESTAMP
		WHERE id = 1
	`).bind(state, SCHEMA_FINGERPRINT, lastError).run();
}

async function markNotReadyBestEffort(c, reason = 'verification-failed') {
	try {
		await markState(c, 'NOT_READY', reason);
	} catch {
		// A missing metadata table is itself a not-ready generation.
	}
}

async function ensureSupportingSchema(c) {
	const { db } = context(c).env;
	const columns = await db.prepare('PRAGMA table_info(email)').all();
	if (!columns.results.some(column => column.name === 'search_dirty')) {
		await db.prepare('ALTER TABLE email ADD COLUMN search_dirty INTEGER NOT NULL DEFAULT 1').run();
	}

	await db.batch([
		db.prepare(`
			CREATE TABLE IF NOT EXISTS ${META_TABLE} (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				state TEXT NOT NULL CHECK (state IN ('NOT_READY', 'BUILDING', 'READY')),
				schema_fingerprint TEXT NOT NULL,
				generation INTEGER NOT NULL DEFAULT 0,
				last_error TEXT NOT NULL DEFAULT '',
				verified_time DATETIME,
				update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`),
		db.prepare(`
			INSERT OR IGNORE INTO ${META_TABLE} (id, state, schema_fingerprint)
			VALUES (1, 'NOT_READY', ?)
		`).bind(SCHEMA_FINGERPRINT),
		db.prepare(`
			CREATE TABLE IF NOT EXISTS email_search_rate_guard (
				user_id INTEGER NOT NULL,
				scope TEXT NOT NULL,
				window_started INTEGER NOT NULL,
				request_count INTEGER NOT NULL DEFAULT 1,
				expires_at INTEGER NOT NULL,
				PRIMARY KEY (user_id, scope)
			)
		`),
		db.prepare('CREATE INDEX IF NOT EXISTS idx_email_search_dirty_user ON email(user_id, search_dirty, email_id)'),
		db.prepare('CREATE INDEX IF NOT EXISTS idx_email_search_rate_expiry ON email_search_rate_guard(expires_at)'),
		db.prepare(`
			CREATE TRIGGER IF NOT EXISTS email_search_dirty_after_update
			AFTER UPDATE OF send_email, name, to_email, to_name, recipient, cc, bcc, subject, text, content ON email
			WHEN (
				OLD.send_email IS NOT NEW.send_email OR OLD.name IS NOT NEW.name OR
				OLD.to_email IS NOT NEW.to_email OR OLD.to_name IS NOT NEW.to_name OR
				OLD.recipient IS NOT NEW.recipient OR OLD.cc IS NOT NEW.cc OR
				OLD.bcc IS NOT NEW.bcc OR OLD.subject IS NOT NEW.subject OR
				OLD.text IS NOT NEW.text OR OLD.content IS NOT NEW.content
			) AND NEW.search_dirty != 1
			BEGIN
				UPDATE email SET search_dirty = 1 WHERE email_id = NEW.email_id;
			END
		`),
	]);
}

async function tokenizerMatches(db, query) {
	const result = await db.prepare(`
		SELECT rowid FROM email_search_token_probe
		WHERE email_search_token_probe MATCH ?
		ORDER BY rowid
	`).bind(query).all();
	return result.results.map(row => Number(row.rowid));
}

async function verifyTokenizerRuntime(c) {
	const { db } = context(c).env;
	await db.prepare('DROP TABLE IF EXISTS email_search_token_probe').run();
	try {
		await db.batch([
			db.prepare("CREATE VIRTUAL TABLE email_search_token_probe USING fts5(value, tokenize='unicode61')"),
			db.prepare(`INSERT INTO email_search_token_probe(rowid, value) VALUES
				(1, 'Café alphabet Привет'),
				(2, '项目更新 alice@example.com alpha-beta quote\"mark wild*card')`),
		]);
		const fixtures = [
			['"CAFÉ"', [1]],
			['"alph"', []],
			['"ПРИВЕТ"', [1]],
			['"项目更新"', [2]],
			['"项目"', []],
			['"alice" AND "example" AND "com"', [2]],
			['"alpha" AND "beta"', [2]],
			['"quote" AND "mark"', [2]],
			['"wild" AND "card"', [2]],
		];
		for (const [query, expected] of fixtures) {
			const actual = await tokenizerMatches(db, query);
			if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
				throw new Error('FTS5 tokenizer semantics do not satisfy mailbox search');
			}
		}
	} finally {
		await db.prepare('DROP TABLE IF EXISTS email_search_token_probe').run();
	}
}

async function verifyKnownSourceMatch(db) {
	const row = await db.prepare(`
		${SELECT_SOURCE_SQL}
		WHERE search_dirty = 0
		ORDER BY email_id
		LIMIT 20
	`).all();
	for (const source of row.results) {
		const searchable = sourceValues(source).slice(1).join(' ');
		const token = searchable.match(/[A-Za-z0-9_]{2,}/)?.[0];
		if (!token) continue;
		const match = await db.prepare(`
			SELECT rowid FROM ${INDEX_TABLE}
			WHERE ${INDEX_TABLE} MATCH ? AND rowid = ?
		`).bind(`"${token.replace(/"/g, '""')}"`, source.email_id).first();
		if (!match) throw new Error('FTS5 known-source MATCH verification failed');
		return;
	}
}

async function verifyGeneration(c, { requireClean = false } = {}) {
	const { db } = context(c).env;
	if (!currentFtsSchema(await tableSql(db, INDEX_TABLE))) {
		throw new Error('FTS5 schema fingerprint mismatch');
	}
	await db.prepare(`INSERT INTO ${INDEX_TABLE}(${INDEX_TABLE}) VALUES('integrity-check')`).run();

	const orphan = await db.prepare(`
		SELECT f.rowid
		FROM ${INDEX_TABLE} f
		LEFT JOIN email e ON e.email_id = f.rowid
		WHERE e.email_id IS NULL
		LIMIT 1
	`).first();
	if (orphan) throw new Error('FTS5 orphan detected');

	const missing = await db.prepare(`
		SELECT e.email_id
		FROM email e
		LEFT JOIN ${INDEX_TABLE} f ON f.rowid = e.email_id
		WHERE e.search_dirty = 0 AND f.rowid IS NULL
		LIMIT 1
	`).first();
	if (missing) throw new Error('FTS5 clean source row is missing');

	if (requireClean) {
		const dirty = await db.prepare('SELECT email_id FROM email WHERE search_dirty = 1 LIMIT 1').first();
		if (dirty) throw new Error('Source rows remain dirty');
	}

	await verifyKnownSourceMatch(db);
	return true;
}

async function rebuild(c) {
	const { db } = context(c).env;
	await db.prepare(`
		UPDATE ${META_TABLE}
		SET state = 'BUILDING', generation = generation + 1,
			schema_fingerprint = ?, last_error = '', update_time = CURRENT_TIMESTAMP
		WHERE id = 1
	`).bind(SCHEMA_FINGERPRINT).run();

	try {
		await verifyTokenizerRuntime(c);
		await db.batch([
			db.prepare(`DROP TABLE IF EXISTS ${INDEX_TABLE}`),
			db.prepare(CREATE_FTS_SQL),
			db.prepare(`
				INSERT INTO ${INDEX_TABLE}
					(rowid, email_id, sender, recipients, subject, body_text, body_html)
				SELECT email_id, email_id,
					coalesce(send_email, '') || ' ' || coalesce(name, ''),
					coalesce(to_email, '') || ' ' || coalesce(to_name, '') || ' ' ||
						coalesce(recipient, '') || ' ' || coalesce(cc, '') || ' ' || coalesce(bcc, ''),
					coalesce(subject, ''), coalesce(text, ''),
					CASE WHEN trim(coalesce(text, '')) = '' THEN coalesce(content, '') ELSE '' END
				FROM email
			`),
			db.prepare('UPDATE email SET search_dirty = 0'),
		]);
		await verifyGeneration(c, { requireClean: true });
		await db.prepare(`
			UPDATE ${META_TABLE}
			SET state = 'READY', schema_fingerprint = ?, last_error = '',
				verified_time = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
			WHERE id = 1
		`).bind(SCHEMA_FINGERPRINT).run();
	} catch (error) {
		await markNotReadyBestEffort(c, 'rebuild-or-verification-failed');
		throw error;
	}
}

async function upgrade(c) {
	c = context(c);
	await ensureSupportingSchema(c);
	const meta = await c.env.db.prepare(`SELECT state, schema_fingerprint FROM ${META_TABLE} WHERE id = 1`).first();
	if (meta?.state === 'READY' && meta.schema_fingerprint === SCHEMA_FINGERPRINT) {
		try {
			await verifyGeneration(c);
			return { rebuilt: false, state: 'READY' };
		} catch {
			await markNotReadyBestEffort(c, 'ready-generation-verification-failed');
		}
	}
	await rebuild(c);
	return { rebuilt: true, state: 'READY' };
}

async function reconcileChunk(c, rows) {
	const { db } = context(c).env;
	const statements = [];
	for (const row of rows) {
		statements.push(db.prepare(`DELETE FROM ${INDEX_TABLE} WHERE rowid = ?`).bind(row.email_id));
		statements.push(insertStatement(db, row));
		statements.push(sourceStillMatchesStatement(db, row));
	}
	await db.batch(statements);
}

async function reconcileDirty(c, { userId, limit = OPPORTUNISTIC_LIMIT } = {}) {
	c = context(c);
	const maximum = userId == null ? SCHEDULED_LIMIT : OPPORTUNISTIC_LIMIT;
	const bounded = boundedLimit(limit, maximum);
	const where = userId == null ? 'search_dirty = 1' : 'search_dirty = 1 AND user_id = ?';
	let query = c.env.db.prepare(`${SELECT_SOURCE_SQL} WHERE ${where} ORDER BY email_id LIMIT ?`);
	query = userId == null ? query.bind(bounded) : query.bind(userId, bounded);
	const dirty = await query.all();
	let processed = 0;
	try {
		for (let offset = 0; offset < dirty.results.length; offset += OPPORTUNISTIC_LIMIT) {
			const chunk = dirty.results.slice(offset, offset + OPPORTUNISTIC_LIMIT);
			await reconcileChunk(c, chunk);
			processed += chunk.length;
		}
		return { processed };
	} catch (error) {
		await markNotReadyBestEffort(c, 'reconciliation-failed');
		throw error;
	}
}

async function userReadiness(c, userId, { limit = OPPORTUNISTIC_LIMIT } = {}) {
	c = context(c);
	let meta;
	try {
		meta = await c.env.db.prepare(`SELECT state, schema_fingerprint FROM ${META_TABLE} WHERE id = 1`).first();
	} catch {
		return { ready: false, reason: 'INDEX_NOT_READY' };
	}
	if (meta?.state !== 'READY' || meta.schema_fingerprint !== SCHEMA_FINGERPRINT) {
		return { ready: false, reason: 'INDEX_NOT_READY' };
	}
	if (!currentFtsSchema(await tableSql(c.env.db, INDEX_TABLE))) {
		await markNotReadyBestEffort(c, 'schema-verification-failed');
		return { ready: false, reason: 'INDEX_NOT_READY' };
	}
	try {
		await reconcileDirty(c, { userId, limit });
	} catch {
		return { ready: false, reason: 'INDEX_NOT_READY' };
	}
	const dirty = await c.env.db.prepare('SELECT email_id FROM email WHERE user_id = ? AND search_dirty = 1 LIMIT 1')
		.bind(userId).first();
	return dirty
		? { ready: false, reason: 'USER_RECONCILING' }
		: { ready: true, reason: null };
}

async function removeDocumentsBestEffort(c, emailIds) {
	c = context(c);
	const ids = [...new Set((emailIds || []).map(Number).filter(Number.isSafeInteger))];
	if (!ids.length) return true;
	try {
		await c.env.db.batch(ids.map(emailId => c.env.db.prepare(`DELETE FROM ${INDEX_TABLE} WHERE rowid = ?`).bind(emailId)));
		return true;
	} catch {
		await markNotReadyBestEffort(c, 'delete-cleanup-failed');
		return false;
	}
}

async function cleanupOrphans(c, limit = SCHEDULED_LIMIT) {
	c = context(c);
	const orphans = await c.env.db.prepare(`
		SELECT f.rowid AS email_id
		FROM ${INDEX_TABLE} f
		LEFT JOIN email e ON e.email_id = f.rowid
		WHERE e.email_id IS NULL
		ORDER BY f.rowid
		LIMIT ?
	`).bind(boundedLimit(limit, SCHEDULED_LIMIT)).all();
	await removeDocumentsBestEffort(c, orphans.results.map(row => row.email_id));
	return orphans.results.length;
}

async function scheduledMaintenance(c) {
	c = context(c);
	try {
		await ensureSupportingSchema(c);
		const meta = await c.env.db.prepare(`SELECT state, schema_fingerprint FROM ${META_TABLE} WHERE id = 1`).first();
		if (meta?.state !== 'READY' || meta.schema_fingerprint !== SCHEMA_FINGERPRINT
			|| !currentFtsSchema(await tableSql(c.env.db, INDEX_TABLE))) {
			await upgrade(c);
		}
		await reconcileDirty(c, { limit: SCHEDULED_LIMIT });
		await cleanupOrphans(c);
		await verifyGeneration(c);
		await c.env.db.prepare(`
			UPDATE ${META_TABLE}
			SET state = 'READY', last_error = '', verified_time = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
			WHERE id = 1
		`).run();
		return true;
	} catch {
		await markNotReadyBestEffort(c, 'scheduled-maintenance-failed');
		return false;
	}
}

const emailSearchIndexService = {
	INDEX_TABLE,
	SCHEMA_FINGERPRINT,
	TOKENIZER,
	upgrade,
	rebuild,
	reconcileDirty,
	userReadiness,
	verifyGeneration,
	verifyTokenizerRuntime,
	removeDocumentsBestEffort,
	cleanupOrphans,
	scheduledMaintenance,
};

export {
	INDEX_TABLE,
	SCHEMA_FINGERPRINT,
	TOKENIZER,
	emailSearchIndexService,
};

export default emailSearchIndexService;
