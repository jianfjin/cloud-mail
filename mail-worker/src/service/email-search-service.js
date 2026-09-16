import { and, eq, inArray, sql } from 'drizzle-orm';
import orm from '../entity/orm';
import email from '../entity/email';
import account from '../entity/account';
import { EMAIL_LIST_TEXT_LEN, emailListColumns } from '../lib/email-list-columns';
import { attConst, emailConst, isDel } from '../const/entity-const';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import emailService from './email-service';
import emailSearchIndexService from './email-search-index-service';

const MAX_PAGE_SIZE = 50;
const MAX_TEXT_BYTES = 512;
const MAX_TOKENS = 20;
const RATE_WINDOW_SECONDS = 60;
const INITIAL_RATE_LIMIT = 10;
const FOLLOWUP_RATE_LIMIT = 60;
const MAX_SIZE_BYTES = 999999 * 1024 * 1024 * 1024;
const TEXT_FIELDS = new Set(['query', 'from', 'to', 'subject', 'hasWords', 'doesntHave']);
const REQUEST_FIELDS = new Set(['generation', 'criteria', 'order', 'pageSize', 'cursor']);
const CRITERIA_FIELDS = new Set([
	...TEXT_FIELDS,
	'location',
	'hasAttachment',
	'size',
	'date',
]);
const DETAIL_FIELDS = new Set(['generation', 'emailIds']);
const LOCATION_TYPES = new Set(['all', 'inbox', 'sent', 'starred']);
const ORDERS = new Set(['newest', 'oldest']);
const encoder = new TextEncoder();

const STORED_SIZE_SQL = `(
	length(CAST(coalesce(e.send_email, '') AS BLOB)) +
	length(CAST(coalesce(e.name, '') AS BLOB)) +
	length(CAST(coalesce(e.to_email, '') AS BLOB)) +
	length(CAST(coalesce(e.to_name, '') AS BLOB)) +
	length(CAST(coalesce(e.recipient, '') AS BLOB)) +
	length(CAST(coalesce(e.cc, '') AS BLOB)) +
	length(CAST(coalesce(e.bcc, '') AS BLOB)) +
	length(CAST(coalesce(e.subject, '') AS BLOB)) +
	length(CAST(coalesce(e.text, '') AS BLOB)) +
	CASE WHEN trim(coalesce(e.text, '')) = ''
		THEN length(CAST(coalesce(e.content, '') AS BLOB)) ELSE 0 END +
	coalesce((SELECT sum(coalesce(stored_att.size, 0))
		FROM attachments stored_att WHERE stored_att.email_id = e.email_id), 0)
)`;

const BRIEF_COLUMNS_SQL = `
	e.email_id AS "emailId",
	e.send_email AS "sendEmail",
	e.name,
	e.subject,
	e.code,
	e.recipient,
	e.cc,
	e.bcc,
	e.to_email AS "toEmail",
	e.type,
	e.status,
	e.message,
	e.unread,
	e.create_time AS "createTime",
	e.is_del AS "isDel",
	CASE WHEN e.calendar_data IS NULL THEN 0 ELSE 1 END AS "hasCalendar",
	CASE WHEN trim(coalesce(e.text, '')) != '' THEN NULL ELSE trim(replace(replace(replace(replace(replace(replace(
		coalesce(e.content, ''), char(13), ''), char(10), ''), char(9), ' '), '  ', ' '), '  ', ' '), '> <', '><')) END AS content,
	substr(coalesce(e.text, ''), 1, ${EMAIL_LIST_TEXT_LEN}) AS text,
	CASE WHEN EXISTS (
		SELECT 1 FROM star result_star
		WHERE result_star.email_id = e.email_id AND result_star.user_id = ?
	) THEN 1 ELSE 0 END AS "isStar"
`;

function invalid() {
	throw new BizError(t('searchInvalid'), 400);
}

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value, allowed) {
	if (!isObject(value) || Object.keys(value).some(key => !allowed.has(key))) invalid();
}

function normalizeGeneration(value) {
	if (Number.isSafeInteger(value) && value >= 0) return value;
	if (typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value)) {
		return value;
	}
	invalid();
}

function normalizeText(value) {
	if (value === undefined) return '';
	if (typeof value !== 'string' || encoder.encode(value).byteLength > MAX_TEXT_BYTES || value.includes('\u0000')) invalid();
	return value.trim();
}

function literalTokens(value) {
	if (!value) return [];
	const tokens = value.normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) || [];
	if (!tokens.length) invalid();
	return tokens;
}

function quotedToken(token) {
	return `"${token.replace(/"/g, '""')}"`;
}

function tokenExpression(tokens, joiner = 'AND') {
	return tokens.map(quotedToken).join(` ${joiner} `);
}

function normalizeDate(value) {
	if (value === undefined) return null;
	exactFields(value, new Set(['start', 'end']));
	if (typeof value.start !== 'string' || typeof value.end !== 'string') invalid();
	const utcPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
	const startParts = utcPattern.exec(value.start);
	const endParts = utcPattern.exec(value.end);
	if (!startParts || !endParts) invalid();
	const start = new Date(value.start);
	const end = new Date(value.end);
	if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) invalid();
	const isExactUtc = (date, parts) => date.getUTCFullYear() === Number(parts[1])
		&& date.getUTCMonth() + 1 === Number(parts[2])
		&& date.getUTCDate() === Number(parts[3])
		&& date.getUTCHours() === Number(parts[4])
		&& date.getUTCMinutes() === Number(parts[5])
		&& date.getUTCSeconds() === Number(parts[6])
		&& date.getUTCMilliseconds() === Number((parts[7] || '').padEnd(3, '0'));
	if (!isExactUtc(start, startParts) || !isExactUtc(end, endParts)) invalid();
	const maximumEnd = new Date(start.getTime());
	const targetYear = start.getUTCFullYear() + 10;
	const lastTargetDay = new Date(Date.UTC(targetYear, start.getUTCMonth() + 1, 0)).getUTCDate();
	maximumEnd.setUTCFullYear(targetYear, start.getUTCMonth(), Math.min(start.getUTCDate(), lastTargetDay));
	if (end > maximumEnd) invalid();
	const sqliteUtc = date => {
		const iso = date.toISOString();
		const base = iso.slice(0, 19).replace('T', ' ');
		return date.getUTCMilliseconds() === 0 ? base : base + iso.slice(19, 23);
	};
	return {
		start: sqliteUtc(start),
		end: sqliteUtc(end),
	};
}

function normalizeSize(value) {
	if (value === undefined) return null;
	exactFields(value, new Set(['comparator', 'bytes']));
	if (!['gt', 'lt'].includes(value.comparator)
		|| !Number.isSafeInteger(value.bytes)
		|| value.bytes < 1
		|| value.bytes > MAX_SIZE_BYTES) invalid();
	return { comparator: value.comparator, bytes: value.bytes };
}

function normalizeCriteria(value) {
	exactFields(value, CRITERIA_FIELDS);
	const criteria = {};
	let totalTokens = 0;
	for (const field of TEXT_FIELDS) {
		const text = normalizeText(value[field]);
		const tokens = literalTokens(text);
		totalTokens += tokens.length;
		criteria[field] = tokens;
	}
	if (totalTokens > MAX_TOKENS) invalid();

	criteria.location = value.location ?? 'all';
	if (!LOCATION_TYPES.has(criteria.location)) invalid();
	if (value.hasAttachment !== undefined && value.hasAttachment !== true) invalid();
	criteria.hasAttachment = value.hasAttachment === true;
	criteria.size = normalizeSize(value.size);
	criteria.date = normalizeDate(value.date);
	return criteria;
}

function normalizePageRequest(value) {
	exactFields(value, REQUEST_FIELDS);
	const generation = normalizeGeneration(value.generation);
	const order = value.order ?? 'newest';
	if (!ORDERS.has(order)) invalid();
	const pageSize = value.pageSize ?? 50;
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) invalid();
	let cursor = null;
	if (value.cursor !== undefined) {
		if (!Number.isSafeInteger(value.cursor) || value.cursor < 1) invalid();
		cursor = value.cursor;
	}
	return {
		generation,
		order,
		pageSize,
		cursor,
		criteria: normalizeCriteria(value.criteria),
	};
}

function normalizeDetailRequest(value) {
	exactFields(value, DETAIL_FIELDS);
	const generation = normalizeGeneration(value.generation);
	if (!Array.isArray(value.emailIds) || value.emailIds.length < 1 || value.emailIds.length > MAX_PAGE_SIZE) invalid();
	if (value.emailIds.some(id => !Number.isSafeInteger(id) || id < 1)) invalid();
	return { generation, emailIds: [...new Set(value.emailIds)] };
}

async function consumeBudget(c, userId, scope, maximum) {
	const now = Math.floor(Date.now() / 1000);
	const expiresAt = now + RATE_WINDOW_SECONDS;
	const consumed = await c.env.db.prepare(`
		INSERT INTO email_search_rate_guard
			(user_id, scope, window_started, request_count, expires_at)
		VALUES (?, ?, ?, 1, ?)
		ON CONFLICT(user_id, scope) DO UPDATE SET
			request_count = CASE
				WHEN email_search_rate_guard.expires_at <= excluded.window_started THEN 1
				ELSE email_search_rate_guard.request_count + 1
			END,
			window_started = CASE
				WHEN email_search_rate_guard.expires_at <= excluded.window_started THEN excluded.window_started
				ELSE email_search_rate_guard.window_started
			END,
			expires_at = CASE
				WHEN email_search_rate_guard.expires_at <= excluded.window_started THEN excluded.expires_at
				ELSE email_search_rate_guard.expires_at
			END
		WHERE email_search_rate_guard.expires_at <= excluded.window_started
			OR email_search_rate_guard.request_count < ?
		RETURNING expires_at
	`).bind(userId, scope, now, expiresAt, maximum).first();

	if (consumed) {
		await c.env.db.prepare(`
			DELETE FROM email_search_rate_guard
			WHERE rowid IN (
				SELECT rowid FROM email_search_rate_guard
				WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
			)
		`).bind(now).run();
		return { allowed: true, retryAfter: 0 };
	}
	const guard = await c.env.db.prepare(`
		SELECT expires_at FROM email_search_rate_guard WHERE user_id = ? AND scope = ?
	`).bind(userId, scope).first();
	return { allowed: false, retryAfter: Math.max(1, Number(guard?.expires_at || expiresAt) - now) };
}

function positiveMatch(criteria) {
	const groups = [];
	const allColumns = '{sender recipients subject body_text body_html}';
	if (criteria.query.length) groups.push(`${allColumns} : (${tokenExpression(criteria.query)})`);
	if (criteria.from.length) groups.push(`sender : (${tokenExpression(criteria.from)})`);
	if (criteria.to.length) groups.push(`recipients : (${tokenExpression(criteria.to)})`);
	if (criteria.subject.length) groups.push(`subject : (${tokenExpression(criteria.subject)})`);
	if (criteria.hasWords.length) groups.push(`${allColumns} : (${tokenExpression(criteria.hasWords)})`);
	return groups.join(' AND ');
}

function compilePredicates(request, userId, { withCursor }) {
	const conditions = [
		'e.user_id = ?',
		`e.is_del = ${isDel.NORMAL}`,
		'a.user_id = ?',
		`a.is_del = ${isDel.NORMAL}`,
	];
	const bindings = [userId, userId];
	const positive = positiveMatch(request.criteria);
	let ftsJoin = '';
	if (positive) {
		ftsJoin = 'JOIN email_search_fts ON email_search_fts.rowid = e.email_id';
		conditions.push('email_search_fts MATCH ?');
		bindings.push(positive);
	}
	if (request.criteria.doesntHave.length) {
		conditions.push(`NOT EXISTS (
			SELECT 1 FROM email_search_fts excluded_search
			WHERE excluded_search.rowid = e.email_id AND email_search_fts MATCH ?
		)`);
		bindings.push(tokenExpression(request.criteria.doesntHave, 'OR'));
	}

	if (request.criteria.location === 'inbox') conditions.push(`e.type = ${emailConst.type.RECEIVE}`);
	if (request.criteria.location === 'sent') conditions.push(`e.type = ${emailConst.type.SEND}`);
	if (request.criteria.location === 'starred') {
		conditions.push(`EXISTS (
			SELECT 1 FROM star scope_star
			WHERE scope_star.email_id = e.email_id AND scope_star.user_id = ?
		)`);
		bindings.push(userId);
	}
	if (request.criteria.date) {
		conditions.push('e.create_time >= ?', 'e.create_time < ?');
		bindings.push(request.criteria.date.start, request.criteria.date.end);
	}
	if (request.criteria.hasAttachment) {
		conditions.push(`EXISTS (
			SELECT 1 FROM attachments downloadable_att
			WHERE downloadable_att.email_id = e.email_id
				AND downloadable_att.user_id = e.user_id
				AND downloadable_att.type = ${attConst.type.ATT}
				AND downloadable_att.content_id IS NULL
		)`);
	}
	if (request.criteria.size) {
		conditions.push(`${STORED_SIZE_SQL} ${request.criteria.size.comparator === 'gt' ? '>' : '<'} ?`);
		bindings.push(request.criteria.size.bytes);
	}
	if (withCursor && request.cursor !== null) {
		conditions.push(`e.email_id ${request.order === 'oldest' ? '>' : '<'} ?`);
		bindings.push(request.cursor);
	}
	return { ftsJoin, where: conditions.join('\n AND '), bindings };
}

async function page(c, rawRequest, userId) {
	const request = normalizePageRequest(rawRequest);
	const readiness = await emailSearchIndexService.userReadiness(c, userId);
	if (!readiness.ready) return { status: 'unavailable', reason: readiness.reason };

	const rate = await consumeBudget(
		c,
		userId,
		request.cursor === null ? 'initial' : 'followup',
		request.cursor === null ? INITIAL_RATE_LIMIT : FOLLOWUP_RATE_LIMIT,
	);
	if (!rate.allowed) return { status: 'rate_limited', retryAfter: rate.retryAfter };

	const rowPredicates = compilePredicates(request, userId, { withCursor: true });
	const direction = request.order === 'oldest' ? 'ASC' : 'DESC';
	const rowStatement = c.env.db.prepare(`
		SELECT ${BRIEF_COLUMNS_SQL}
		FROM email e
		JOIN account a ON a.account_id = e.account_id
		${rowPredicates.ftsJoin}
		WHERE ${rowPredicates.where}
		ORDER BY e.email_id ${direction}
		LIMIT ?
	`).bind(userId, ...rowPredicates.bindings, request.pageSize + 1);

	let rowsResult;
	let total;
	if (request.cursor === null) {
		const countPredicates = compilePredicates(request, userId, { withCursor: false });
		const countStatement = c.env.db.prepare(`
			SELECT count(*) AS total
			FROM email e
			JOIN account a ON a.account_id = e.account_id
			${countPredicates.ftsJoin}
			WHERE ${countPredicates.where}
		`).bind(...countPredicates.bindings);
		const snapshot = await c.env.db.batch([rowStatement, countStatement]);
		rowsResult = snapshot[0];
		total = Number(snapshot[1].results[0]?.total || 0);
	} else {
		rowsResult = await rowStatement.all();
	}

	const hasMore = rowsResult.results.length > request.pageSize;
	const list = rowsResult.results.slice(0, request.pageSize);
	emailService.applyListText(list);
	const data = {
		generation: request.generation,
		list,
		nextCursor: hasMore ? list.at(-1).emailId : null,
	};
	if (request.cursor === null) data.total = total;
	return { status: 'ok', data };
}

async function details(c, rawRequest, userId) {
	const request = normalizeDetailRequest(rawRequest);
	const readiness = await emailSearchIndexService.userReadiness(c, userId);
	if (!readiness.ready) return { status: 'unavailable', reason: readiness.reason };
	const rate = await consumeBudget(c, userId, 'followup', FOLLOWUP_RATE_LIMIT);
	if (!rate.allowed) return { status: 'rate_limited', retryAfter: rate.retryAfter };

	const rows = await orm(c).select({
		...emailListColumns,
		isStar: sql`CASE WHEN EXISTS (
			SELECT 1 FROM star authorized_star
			WHERE authorized_star.email_id = ${email.emailId}
				AND authorized_star.user_id = ${userId}
		) THEN 1 ELSE 0 END`.mapWith(Number),
	}).from(email)
		.innerJoin(account, eq(account.accountId, email.accountId))
		.where(and(
			inArray(email.emailId, request.emailIds),
			eq(email.userId, userId),
			eq(email.isDel, isDel.NORMAL),
			eq(account.userId, userId),
			eq(account.isDel, isDel.NORMAL),
		)).all();

	const byId = new Map(rows.map(row => [row.emailId, row]));
	const list = request.emailIds.map(id => byId.get(id)).filter(Boolean);
	await emailService.emailAddAtt(c, list);
	return { status: 'ok', data: { generation: request.generation, list } };
}

const emailSearchService = {
	MAX_PAGE_SIZE,
	INITIAL_RATE_LIMIT,
	FOLLOWUP_RATE_LIMIT,
	page,
	details,
};

export default emailSearchService;
