import { and, eq, isNull } from 'drizzle-orm';
import orm from '../entity/orm';
import email from '../entity/email';
import attService from './att-service';
import r2Service from './r2-service';
import {
	CALENDAR_LIMITS,
	createCalendarFallback,
	decodeCalendarEnvelope,
	isCurrentCalendarEnvelope,
	normalizeCalendarAttachments,
} from '../utils/calendar-utils';
import { isDel } from '../const/entity-const';
import calendarProviderService from './calendar-provider-service';

const MAX_ATTEMPTS_PER_MINUTE = 3;
const RETRY_COOLDOWN_SECONDS = 30;
const WINDOW_SECONDS = 60;

function ownedEmail(c, emailId, userId) {
	return orm(c).select({
		emailId: email.emailId,
		calendarData: email.calendarData,
	}).from(email).where(and(
		eq(email.emailId, emailId),
		eq(email.userId, userId),
		eq(email.isDel, isDel.NORMAL),
	)).get();
}

async function consumeBudget(c, emailId, userId) {
	const now = Math.floor(Date.now() / 1000);
	const row = await c.env.db.prepare(`
		INSERT INTO calendar_repair_guard (email_id, user_id, window_started, attempts, retry_after)
		VALUES (?, ?, ?, 1, 0)
		ON CONFLICT(email_id, user_id) DO UPDATE SET
			attempts = CASE
				WHEN calendar_repair_guard.window_started <= excluded.window_started - ${WINDOW_SECONDS} THEN 1
				ELSE calendar_repair_guard.attempts + 1
			END,
			window_started = CASE
				WHEN calendar_repair_guard.window_started <= excluded.window_started - ${WINDOW_SECONDS} THEN excluded.window_started
				ELSE calendar_repair_guard.window_started
			END,
			retry_after = 0
		WHERE calendar_repair_guard.retry_after <= excluded.window_started
			AND (
				calendar_repair_guard.window_started <= excluded.window_started - ${WINDOW_SECONDS}
				OR calendar_repair_guard.attempts < ${MAX_ATTEMPTS_PER_MINUTE}
			)
		RETURNING attempts
	`).bind(emailId, userId, now).first();
	return Boolean(row);
}

async function clearBudget(c, emailId, userId) {
	await c.env.db.prepare('DELETE FROM calendar_repair_guard WHERE email_id = ? AND user_id = ?')
		.bind(emailId, userId).run();
}

async function startCooldown(c, emailId, userId) {
	const retryAfter = Math.floor(Date.now() / 1000) + RETRY_COOLDOWN_SECONDS;
	await c.env.db.prepare(`
		UPDATE calendar_repair_guard SET retry_after = ?
		WHERE email_id = ? AND user_id = ?
	`).bind(retryAfter, emailId, userId).run();
}

async function readBoundedObject(object, maximumBytes) {
	if (object === null || object === undefined) throw new Error('object unavailable');
	if (object instanceof ArrayBuffer) return new Uint8Array(object).slice(0, maximumBytes);
	if (ArrayBuffer.isView(object)) {
		return new Uint8Array(object.buffer, object.byteOffset, Math.min(object.byteLength, maximumBytes));
	}

	const reader = object.body?.getReader?.();
	if (!reader) throw new Error('bounded stream unavailable');
	const chunks = [];
	let total = 0;
	try {
		while (total < maximumBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
			const selected = bytes.subarray(0, maximumBytes - total);
			chunks.push(selected);
			total += selected.byteLength;
			if (selected.byteLength < bytes.byteLength) break;
		}
	} finally {
		if (total >= maximumBytes) await reader.cancel().catch(() => {});
		else reader.releaseLock();
	}

	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function persistCanonical(c, row, userId, envelope) {
	const serialized = JSON.stringify(envelope);
	const previousCondition = row.calendarData === null
		? isNull(email.calendarData)
		: eq(email.calendarData, row.calendarData);

	await orm(c).update(email).set({ calendarData: serialized }).where(and(
		eq(email.emailId, row.emailId),
		eq(email.userId, userId),
		eq(email.isDel, isDel.NORMAL),
		previousCondition,
	)).run();

	const canonical = await ownedEmail(c, row.emailId, userId);
	if (!canonical) return null;
	return isCurrentCalendarEnvelope(canonical.calendarData)
		? decodeCalendarEnvelope(canonical.calendarData)
		: null;
}

async function presentEnvelope(c, envelope) {
	return calendarProviderService.applyTrust(c, envelope);
}

const calendarPreviewService = {
	async removeGuardsByEmailIds(c, emailIds) {
		if (!emailIds.length) return;
		const placeholders = emailIds.map(() => '?').join(',');
		await c.env.db.prepare(`DELETE FROM calendar_repair_guard WHERE email_id IN (${placeholders})`)
			.bind(...emailIds).run();
	},

	async removeGuardsByUserIds(c, userIds) {
		if (!userIds.length) return;
		const placeholders = userIds.map(() => '?').join(',');
		await c.env.db.prepare(`DELETE FROM calendar_repair_guard WHERE user_id IN (${placeholders})`)
			.bind(...userIds).run();
	},

	async getPreview(c, { emailId, userId, objectService = r2Service }) {
		emailId = Number(emailId);
		userId = Number(userId);
		if (!Number.isSafeInteger(emailId) || emailId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
			return { status: 'not_found' };
		}

		const row = await ownedEmail(c, emailId, userId);
		if (!row) return { status: 'not_found' };
		if (isCurrentCalendarEnvelope(row.calendarData)) {
			return { status: 'ok', envelope: await presentEnvelope(c, decodeCalendarEnvelope(row.calendarData)) };
		}
		if (!await consumeBudget(c, emailId, userId)) return { status: 'rate_limited' };

		try {
			const parts = await attService.calendarParts(c, emailId, userId);
			if (!parts.length) {
				const envelope = createCalendarFallback('calendar_attachment_unavailable', 'unsupported');
				const canonical = await persistCanonical(c, row, userId, envelope);
				await clearBudget(c, emailId, userId);
				return canonical ? { status: 'ok', envelope: await presentEnvelope(c, canonical) } : { status: 'not_found' };
			}
			if (parts.some(part => Number(part.size) > CALENDAR_LIMITS.contentBytes)) {
				const envelope = createCalendarFallback('calendar_content_too_large');
				const canonical = await persistCanonical(c, row, userId, envelope);
				await clearBudget(c, emailId, userId);
				return canonical ? { status: 'ok', envelope: await presentEnvelope(c, canonical) } : { status: 'not_found' };
			}

			const attachments = [];
			for (const part of parts) {
				const object = await objectService.getObj(c, part.key, { maxBytes: CALENDAR_LIMITS.contentBytes + 1 });
				const content = await readBoundedObject(object, CALENDAR_LIMITS.contentBytes + 1);
				if (content.byteLength > CALENDAR_LIMITS.contentBytes) {
					const envelope = createCalendarFallback('calendar_content_too_large');
					const canonical = await persistCanonical(c, row, userId, envelope);
					await clearBudget(c, emailId, userId);
					return canonical ? { status: 'ok', envelope: await presentEnvelope(c, canonical) } : { status: 'not_found' };
				}
				attachments.push({
					content,
					filename: part.filename,
					mimeType: part.mimeType,
					method: part.method,
				});
			}

			const envelope = await normalizeCalendarAttachments(attachments)
				|| createCalendarFallback('calendar_attachment_unavailable', 'unsupported');
			const canonical = await persistCanonical(c, row, userId, envelope);
			await clearBudget(c, emailId, userId);
			return canonical ? { status: 'ok', envelope: await presentEnvelope(c, canonical) } : { status: 'not_found' };
		} catch (_) {
			await startCooldown(c, emailId, userId);
			return {
				status: 'retryable',
				envelope: await presentEnvelope(c, createCalendarFallback('calendar_storage_unavailable')),
			};
		}
	},
};

export default calendarPreviewService;
