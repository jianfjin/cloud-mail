import {and, eq, inArray} from 'drizzle-orm';
import BizError from '../error/biz-error';
import calendarResponse from '../entity/calendar-response';
import email from '../entity/email';
import orm from '../entity/orm';
import {isDel} from '../const/entity-const';
import accountService from './account-service';
import emailService from './email-service';

const PARTICIPATION_STATUSES = new Set(['ACCEPTED', 'TENTATIVE', 'DECLINED']);
const DISPATCH_UNKNOWN_AFTER_MS = 5 * 60 * 1000;

function normalizedAddress(value) {
	if (typeof value !== 'string') return null;
	const address = value.trim().replace(/^mailto:/i, '');
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
	return address.toLowerCase();
}

function calendarText(value) {
	return String(value || '')
		.replace(/\\/g, '\\\\')
		.replace(/\r\n|\r|\n/g, '\\n')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,');
}

function calendarTimestamp() {
	return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function serializeCalendarReply(event, accountEmail, participationStatus, organizer) {
	const lines = [
		'BEGIN:VCALENDAR',
		'PRODID:-//Cloud Mail//Calendar RSVP//EN',
		'VERSION:2.0',
		'CALSCALE:GREGORIAN',
		'METHOD:REPLY',
		'BEGIN:VEVENT',
		'UID:' + calendarText(event.uid),
		'SEQUENCE:' + (Number.isInteger(event.sequence) && event.sequence >= 0 ? event.sequence : 0),
		'DTSTAMP:' + calendarTimestamp(),
		'ORGANIZER:mailto:' + organizer,
		'ATTENDEE;PARTSTAT=' + participationStatus + ':mailto:' + accountEmail,
	];

	if (event.recurrenceId) lines.push('RECURRENCE-ID:' + calendarText(event.recurrenceId));
	lines.push('END:VEVENT', 'END:VCALENDAR', '');
	return lines.join('\r\n');
}

function normalizedParticipationStatus(value) {
	const status = typeof value === 'string' ? value.trim().toUpperCase() : '';
	if (!PARTICIPATION_STATUSES.has(status)) {
		throw new BizError('Calendar response status must be ACCEPTED, TENTATIVE, or DECLINED.', 400);
	}
	return status;
}

function eventFromEnvelope(calendarData, eventUid, recurrenceId, accountEmail) {
	let envelope;
	try {
		envelope = JSON.parse(calendarData || '');
	} catch (_) {
		throw new BizError('The invitation calendar data is invalid.', 400);
	}

	if (envelope?.state !== 'parsed' || !Array.isArray(envelope.events)) {
		throw new BizError('The invitation does not contain a supported calendar event.', 400);
	}

	const canonicalRecurrenceId = recurrenceId || '';
	const event = envelope.events.find(item => item?.uid === eventUid && (item.recurrenceId || '') === canonicalRecurrenceId);
	if (!event || event.action !== 'invitation') {
		throw new BizError('The selected calendar event is not eligible for a response.', 400);
	}

	const organizer = normalizedAddress(event.organizer?.address);
	if (!organizer) {
		throw new BizError('The invitation organizer address is invalid.', 400);
	}

	const attendeeMatches = Array.isArray(event.attendees)
		&& event.attendees.some(attendee => normalizedAddress(attendee?.address) === accountEmail);
	if (!attendeeMatches) {
		throw new BizError('The selected account is not an eligible attendee for this event.', 403);
	}

	return {event, organizer, recurrenceId: canonicalRecurrenceId};
}

async function resolveEligibleInvitation(c, params, userId) {
	const emailId = Number(params.emailId);
	const accountId = Number(params.accountId);
	const eventUid = typeof params.eventUid === 'string' ? params.eventUid : '';
	const recurrenceId = typeof params.recurrenceId === 'string' ? params.recurrenceId : '';
	if (!Number.isInteger(emailId) || emailId <= 0 || !Number.isInteger(accountId) || accountId <= 0 || !eventUid) {
		throw new BizError('Calendar response identity is invalid.', 400);
	}

	const [emailRow, accountRow] = await Promise.all([
		orm(c).select().from(email).where(and(
			eq(email.emailId, emailId),
			eq(email.userId, userId),
			eq(email.isDel, isDel.NORMAL),
		)).get(),
		accountService.selectById(c, accountId),
	]);
	if (!emailRow) throw new BizError('The invitation does not belong to the current user.', 404);
	if (!accountRow || accountRow.userId !== userId) throw new BizError('The selected sending account does not belong to the current user.', 403);

	const accountEmail = normalizedAddress(accountRow.email);
	if (!accountEmail) throw new BizError('The selected sending account address is invalid.', 400);
	const eventData = eventFromEnvelope(emailRow.calendarData, eventUid, recurrenceId, accountEmail);

	return {
		emailId,
		accountId,
		userId,
		eventUid,
		recurrenceId: eventData.recurrenceId,
		accountEmail,
		...eventData,
	};
}

function responseIdentity(criteria, participationStatus) {
	return and(
		eq(calendarResponse.emailId, criteria.emailId),
		eq(calendarResponse.eventUid, criteria.eventUid),
		eq(calendarResponse.recurrenceId, criteria.recurrenceId),
		eq(calendarResponse.accountId, criteria.accountId),
		eq(calendarResponse.participationStatus, participationStatus),
	);
}

async function findResponse(c, criteria, participationStatus) {
	const response = await orm(c).select().from(calendarResponse).where(responseIdentity(criteria, participationStatus)).get();
	return reconcileStaleDispatch(c, response);
}

function responseTimestamp(response) {
	const value = response?.dispatchedTime || response?.updateTime || response?.createTime;
	if (typeof value !== 'string') return Number.NaN;
	const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
	return Date.parse(normalized);
}

async function reconcileStaleDispatch(c, response) {
	if (!response || response.deliveryState !== 'dispatching') return response;
	const timestamp = responseTimestamp(response);
	if (!Number.isFinite(timestamp) || Date.now() - timestamp < DISPATCH_UNKNOWN_AFTER_MS) return response;
	const reconciled = await orm(c).update(calendarResponse).set({
		deliveryState: 'delivery_unknown',
		updateTime: new Date().toISOString(),
	}).where(and(
		eq(calendarResponse.responseId, response.responseId),
		eq(calendarResponse.deliveryState, 'dispatching'),
	)).returning().get();
	if (reconciled) return reconciled;
	return orm(c).select().from(calendarResponse)
		.where(eq(calendarResponse.responseId, response.responseId)).get();
}

async function dispatch(c, response, invitation) {
	try {
		const reply = serializeCalendarReply(
			invitation.event,
			invitation.accountEmail,
			response.participationStatus,
			invitation.organizer,
		);
		const sent = await emailService.send(c, {
			accountId: invitation.accountId,
			name: 'Cloud Mail',
			sendType: 'calendar-response',
			receiveEmail: [invitation.organizer],
			subject: 'Calendar response: ' + calendarText(invitation.event.summary || 'Invitation'),
			text: reply,
			content: '',
			attachments: [{
				filename: 'calendar-response.ics',
				mimeType: 'text/calendar; charset=UTF-8; method=REPLY',
				content: reply,
			}],
		}, invitation.userId);
		const providerReceipt = sent?.[0]?.resendEmailId || '';
		return orm(c).update(calendarResponse).set({
			deliveryState: 'delivered',
			providerReceipt,
			updateTime: new Date().toISOString(),
			deliveredTime: new Date().toISOString(),
		}).where(eq(calendarResponse.responseId, response.responseId)).returning().get();
	} catch (error) {
		const deliveryState = error instanceof BizError ? 'retryable_no_send' : 'delivery_unknown';
		return orm(c).update(calendarResponse).set({
			deliveryState,
			updateTime: new Date().toISOString(),
		}).where(eq(calendarResponse.responseId, response.responseId)).returning().get();
	}
}

const calendarResponseService = {
	async respond(c, params, userId) {
		const participationStatus = normalizedParticipationStatus(params.participationStatus);
		const invitation = await resolveEligibleInvitation(c, params, userId);
		const existing = await findResponse(c, invitation, participationStatus);
		if (existing) return existing;

		let response;
		try {
			response = await orm(c).insert(calendarResponse).values({
				emailId: invitation.emailId,
				eventUid: invitation.eventUid,
				recurrenceId: invitation.recurrenceId,
				accountId: invitation.accountId,
				userId,
				participationStatus,
				organizer: invitation.organizer,
				deliveryState: 'dispatching',
			}).returning().get();
		} catch (error) {
			response = await findResponse(c, invitation, participationStatus);
			if (response) return response;
			throw error;
		}

		response = await orm(c).update(calendarResponse).set({
			dispatchedTime: new Date().toISOString(),
			updateTime: new Date().toISOString(),
		}).where(eq(calendarResponse.responseId, response.responseId)).returning().get();
		return dispatch(c, response, invitation);
	},

	async retry(c, params, userId) {
		const responseId = Number(params.responseId);
		if (!Number.isInteger(responseId) || responseId <= 0) throw new BizError('Calendar response identity is invalid.', 400);
		let response = await orm(c).select().from(calendarResponse).where(and(
			eq(calendarResponse.responseId, responseId),
			eq(calendarResponse.userId, userId),
		)).get();
		response = await reconcileStaleDispatch(c, response);
		if (!response) throw new BizError('Calendar response not found.', 404);
		if (response.deliveryState !== 'retryable_no_send') return response;

		const invitation = await resolveEligibleInvitation(c, response, userId);
		const dispatching = await orm(c).update(calendarResponse).set({
			deliveryState: 'dispatching',
			dispatchedTime: new Date().toISOString(),
			updateTime: new Date().toISOString(),
		}).where(and(
			eq(calendarResponse.responseId, response.responseId),
			eq(calendarResponse.deliveryState, 'retryable_no_send'),
		)).returning().get();
		if (!dispatching) return orm(c).select().from(calendarResponse).where(eq(calendarResponse.responseId, response.responseId)).get();
		return dispatch(c, dispatching, invitation);
	},

	async eligibility(c, params, userId) {
		try {
			const invitation = await resolveEligibleInvitation(c, params, userId);
			const storedResponses = await orm(c).select().from(calendarResponse).where(and(
				eq(calendarResponse.emailId, invitation.emailId),
				eq(calendarResponse.eventUid, invitation.eventUid),
				eq(calendarResponse.recurrenceId, invitation.recurrenceId),
				eq(calendarResponse.accountId, invitation.accountId),
				eq(calendarResponse.userId, userId),
			)).all();
			const responses = await Promise.all(storedResponses.map(response => reconcileStaleDispatch(c, response)));
			return {
				eligible: true,
				organizer: {
					name: invitation.event.organizer?.name || '',
					address: invitation.organizer,
				},
				account: {accountId: invitation.accountId, email: invitation.accountEmail},
				responses,
			};
		} catch (error) {
			if (error instanceof BizError) return {eligible: false};
			throw error;
		}
	},

	async removeByEmailIds(c, emailIds) {
		const ids = [...new Set(emailIds.map(Number).filter(Number.isInteger))];
		if (ids.length) await orm(c).delete(calendarResponse).where(inArray(calendarResponse.emailId, ids)).run();
	},

	async removeByUserIds(c, userIds) {
		const ids = [...new Set(userIds.map(Number).filter(Number.isInteger))];
		if (ids.length) await orm(c).delete(calendarResponse).where(inArray(calendarResponse.userId, ids)).run();
	},

	removeByAccountId(c, accountId) {
		return orm(c).delete(calendarResponse).where(eq(calendarResponse.accountId, Number(accountId))).run();
	},
};

export default calendarResponseService;
