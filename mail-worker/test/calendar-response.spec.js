import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import BizError from '../src/error/biz-error';
import {dbInit} from '../src/init/init';
import calendarResponseService from '../src/service/calendar-response-service';
import emailService from '../src/service/email-service';

const c = {env};

const invitation = {
	uid: 'calendar-response-1@example.test',
	recurrenceId: null,
	sequence: 3,
	action: 'invitation',
	summary: 'Planning call',
	description: 'Do not include this description in a reply.',
	meetingLink: {url: 'https://meet.google.com/private-link'},
	organizer: {name: 'Organizer', address: 'organizer@example.test'},
	attendees: [{name: 'Local Tester', address: 'LOCAL-TESTER@EXAMPLE.COM'}],
};

async function resetSchema() {
	await env.db.prepare('DROP TABLE IF EXISTS calendar_response').run();
	await env.db.prepare('DROP TABLE IF EXISTS calendar_provider').run();
	await env.db.prepare('DROP TABLE IF EXISTS calendar_repair_guard').run();
	await env.db.prepare('DROP TABLE IF EXISTS attachments').run();
	await env.db.prepare('DROP TABLE IF EXISTS star').run();
	await env.db.prepare('DROP TABLE IF EXISTS email').run();
	await env.db.prepare('DROP TABLE IF EXISTS account').run();
	await env.db.prepare([
		'CREATE TABLE email (',
		'email_id INTEGER PRIMARY KEY, send_email TEXT, name TEXT, account_id INTEGER NOT NULL, user_id INTEGER NOT NULL,',
		'subject TEXT, code TEXT NOT NULL DEFAULT \'\', text TEXT, content TEXT, calendar_data TEXT, cc TEXT DEFAULT \'[]\',',
		'bcc TEXT DEFAULT \'[]\', recipient TEXT, to_email TEXT NOT NULL DEFAULT \'\', to_name TEXT NOT NULL DEFAULT \'\',',
		'in_reply_to TEXT DEFAULT \'\', relation TEXT DEFAULT \'\', message_id TEXT DEFAULT \'\', type INTEGER NOT NULL DEFAULT 0,',
		'status INTEGER NOT NULL DEFAULT 0, resend_email_id TEXT, message TEXT, unread INTEGER NOT NULL DEFAULT 0,',
		'create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, is_del INTEGER NOT NULL DEFAULT 0',
		')',
	].join(' ')).run();
	await env.db.prepare([
		'CREATE TABLE account (',
		'account_id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT \'\', status INTEGER NOT NULL DEFAULT 0,',
		'latest_email_time DATETIME, signature TEXT, create_time DATETIME DEFAULT CURRENT_TIMESTAMP, user_id INTEGER NOT NULL,',
		'all_receive INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, is_del INTEGER NOT NULL DEFAULT 0',
		')',
	].join(' ')).run();
	await env.db.prepare('CREATE TABLE calendar_repair_guard (email_id INTEGER NOT NULL, user_id INTEGER NOT NULL, window_started INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, retry_after INTEGER NOT NULL DEFAULT 0)').run();
	await env.db.prepare('CREATE TABLE attachments (att_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL, account_id INTEGER NOT NULL, key TEXT NOT NULL)').run();
	await env.db.prepare('CREATE TABLE star (star_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL)').run();
	await dbInit.v3_6DB(c);
	await env.db.prepare('INSERT INTO account (account_id, email, user_id) VALUES (11, ?, 99)').bind('local-tester@example.com').run();
	await env.db.prepare('INSERT INTO email (email_id, account_id, user_id, subject, calendar_data) VALUES (1, 11, 99, ?, ?)')
		.bind('Calendar invitation', JSON.stringify({state: 'parsed', events: [invitation]})).run();
}

describe('calendar RSVP responses', () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await resetSchema();
	});

	it('sends one minimal REPLY for an eligible attendee and returns the existing response on repeat', async () => {
		const send = vi.spyOn(emailService, 'send').mockResolvedValue([{resendEmailId: 'provider-receipt'}]);

		const response = await calendarResponseService.respond(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
			participationStatus: 'ACCEPTED',
		}, 99);
		const repeated = await calendarResponseService.respond(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
			participationStatus: 'ACCEPTED',
		}, 99);

		expect(response).toMatchObject({deliveryState: 'delivered', participationStatus: 'ACCEPTED'});
		expect(repeated.responseId).toBe(response.responseId);
		expect(send).toHaveBeenCalledTimes(1);
		const [, sendParams, sendUserId] = send.mock.calls[0];
		expect(sendUserId).toBe(99);
		expect(sendParams.receiveEmail).toEqual(['organizer@example.test']);
		expect(sendParams.attachments[0]).toMatchObject({filename: 'calendar-response.ics', mimeType: 'text/calendar; charset=UTF-8; method=REPLY'});
		const reply = String(sendParams.attachments[0].content);
		expect(reply).toContain('\r\n');
		expect(reply).not.toContain('\\r\\n');
		expect(reply).toContain('METHOD:REPLY');
		expect(reply).toContain('UID:calendar-response-1@example.test');
		expect(reply).toContain('SEQUENCE:3');
		expect(reply).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:local-tester@example.com');
		expect(reply).not.toContain(invitation.description);
		expect(reply).not.toContain(invitation.meetingLink.url);
	});

	it('rejects a response for an account that is not an event attendee before delivery', async () => {
		const send = vi.spyOn(emailService, 'send').mockResolvedValue([]);
		await env.db.prepare('INSERT INTO account (account_id, email, user_id) VALUES (12, ?, 99)').bind('other@example.com').run();

		await expect(calendarResponseService.respond(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 12,
			participationStatus: 'DECLINED',
		}, 99)).rejects.toThrow('eligible attendee');
		expect(send).not.toHaveBeenCalled();
	});

	it('reports eligibility only for the owned invitation and selected attendee account', async () => {
		const eligible = await calendarResponseService.eligibility(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
		}, 99);
		const ineligible = await calendarResponseService.eligibility(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
		}, 100);

		expect(eligible).toMatchObject({
			eligible: true,
			organizer: {address: 'organizer@example.test'},
			account: {accountId: 11, email: 'local-tester@example.com'},
			responses: [],
		});
		expect(ineligible).toEqual({eligible: false});
	});

	it('retries only confirmed no-send responses and blocks delivery-unknown responses', async () => {
		const send = vi.spyOn(emailService, 'send')
			.mockRejectedValueOnce(new BizError('The configured sender rejected this message'))
			.mockResolvedValueOnce([{resendEmailId: 'retried-receipt'}])
			.mockRejectedValueOnce(new Error('connection lost after dispatch'));

		const retryable = await calendarResponseService.respond(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
			participationStatus: 'TENTATIVE',
		}, 99);
		expect(retryable.deliveryState).toBe('retryable_no_send');

		const retried = await calendarResponseService.retry(c, {responseId: retryable.responseId}, 99);
		expect(retried).toMatchObject({deliveryState: 'delivered', providerReceipt: 'retried-receipt'});

		const unknown = await calendarResponseService.respond(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
			participationStatus: 'DECLINED',
		}, 99);
		expect(unknown.deliveryState).toBe('delivery_unknown');
		const blocked = await calendarResponseService.retry(c, {responseId: unknown.responseId}, 99);
		expect(blocked.responseId).toBe(unknown.responseId);
		expect(blocked.deliveryState).toBe('delivery_unknown');
		expect(send).toHaveBeenCalledTimes(3);
	});

	it('reconciles a stale dispatch as delivery unknown without sending again', async () => {
		const send = vi.spyOn(emailService, 'send').mockResolvedValue([]);
		await env.db.prepare(`
			INSERT INTO calendar_response
				(email_id, event_uid, account_id, user_id, participation_status, organizer, delivery_state, dispatched_time)
			VALUES (1, ?, 11, 99, 'ACCEPTED', 'organizer@example.test', 'dispatching', '2000-01-01T00:00:00.000Z')
		`).bind(invitation.uid).run();

		const eligibility = await calendarResponseService.eligibility(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
		}, 99);
		expect(eligibility.responses[0].deliveryState).toBe('delivery_unknown');

		const repeated = await calendarResponseService.respond(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
			participationStatus: 'ACCEPTED',
		}, 99);
		expect(repeated.deliveryState).toBe('delivery_unknown');
		expect(send).not.toHaveBeenCalled();
	});

	it('removes response records through the email and mailbox deletion hooks', async () => {
		vi.spyOn(emailService, 'send').mockResolvedValue([]);
		await calendarResponseService.respond(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
			participationStatus: 'ACCEPTED',
		}, 99);
		await emailService.physicsDelete(c, {emailIds: '1'});
		expect((await env.db.prepare('SELECT count(*) AS count FROM calendar_response').first()).count).toBe(0);

		await resetSchema();
		vi.spyOn(emailService, 'send').mockResolvedValue([]);
		await calendarResponseService.respond(c, {
			emailId: 1,
			eventUid: invitation.uid,
			accountId: 11,
			participationStatus: 'DECLINED',
		}, 99);
		await emailService.physicsDeleteUserIds(c, [99]);
		expect((await env.db.prepare('SELECT count(*) AS count FROM calendar_response').first()).count).toBe(0);
	});
});
