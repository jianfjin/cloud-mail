import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
import googleMeetMessage from './fixtures/calendar/google-meet.eml?raw';
import { prepareCalendarReceipt } from '../src/email/calendar-receipt';
import { dbInit } from '../src/init/init';
import orm from '../src/entity/orm';
import email from '../src/entity/email';
import emailService from '../src/service/email-service';
import { emailBriefColumns, emailListColumns } from '../src/lib/email-list-columns';
import webhookService from '../src/service/webhook-service';

const c = { env };

async function resetEmailSchema() {
	await env.db.prepare('DROP TABLE IF EXISTS calendar_repair_guard').run();
	await env.db.prepare('DROP TABLE IF EXISTS attachments').run();
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
	await env.db.prepare(`
		CREATE TABLE attachments (
			att_id INTEGER PRIMARY KEY,
			user_id INTEGER NOT NULL,
			email_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL,
			key TEXT NOT NULL
		)
	`).run();
}

describe('calendar receipt persistence', () => {
	beforeEach(resetEmailSchema);

	it('normalizes PostalMime calendar parts, assigns stable filenames, and persists the envelope', async () => {
		const parsed = await PostalMime.parse(googleMeetMessage);
		const prepared = await prepareCalendarReceipt(parsed);

		expect(prepared.attachments).toHaveLength(1);
		expect(prepared.attachments[0].filename).toBe('invite.ics');
		expect(Array.from(prepared.attachments[0].content)).toEqual(Array.from(parsed.attachments[0].content));
		expect(JSON.parse(prepared.calendarData)).toMatchObject({
			state: 'parsed',
			events: [{ summary: 'Planning call' }],
		});

		await dbInit.v3_5DB(c);
		const row = await emailService.receive(c, {
			accountId: 10,
			userId: 20,
			toEmail: 'owner@example.com',
			toName: 'Owner',
			sendEmail: 'sender@example.com',
			calendarData: prepared.calendarData,
		}, [], null);

		expect(JSON.parse(row.calendarData)).toMatchObject({ events: [{ uid: 'google-meet-1@example.com' }] });
	});

	it('keeps ordinary bodies and calendar bytes while making malformed input non-fatal', async () => {
		const content = new TextEncoder().encode('BEGIN:VCALENDAR\r\nBROKEN');
		const parsed = {
			html: '<p>Keep this body</p>',
			text: 'Keep this body',
			attachments: [
				{ mimeType: 'application/ics', filename: '', content },
				{ mimeType: 'text/calendar', content },
			],
		};
		const prepared = await prepareCalendarReceipt(parsed);

		expect(parsed.html).toBe('<p>Keep this body</p>');
		expect(parsed.text).toBe('Keep this body');
		expect(Array.from(prepared.attachments[0].content)).toEqual(Array.from(content));
		expect(prepared.attachments[0].filename).toBe('invite.ics');
		expect(prepared.attachments[1].filename).toBe('invite-2.ics');
		expect(JSON.parse(prepared.calendarData).state).toBe('failed');
	});

	it('leaves ordinary mail unchanged and stores no calendar envelope', async () => {
		const attachment = { mimeType: 'text/plain', filename: 'notes.txt', content: new TextEncoder().encode('notes') };
		const prepared = await prepareCalendarReceipt({ attachments: [attachment] });

		expect(prepared.calendarData).toBeNull();
		expect(prepared.attachments).toEqual([attachment]);
	});

	it('adds the calendar column idempotently and exposes only its presence through list projections', async () => {
		const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await dbInit.v3_5DB(c);
		await dbInit.v3_5DB(c);

		const columns = await env.db.prepare('PRAGMA table_info(email)').all();
		const attachmentColumns = await env.db.prepare('PRAGMA table_info(attachments)').all();
		expect(columns.results.filter(column => column.name === 'calendar_data')).toHaveLength(1);
		expect(attachmentColumns.results.filter(column => column.name === 'calendar_method')).toHaveLength(1);
		expect(emailListColumns).not.toHaveProperty('calendarData');
		expect(emailListColumns).toHaveProperty('hasCalendar');
		expect(emailBriefColumns).not.toHaveProperty('calendarData');
		expect(emailBriefColumns).toHaveProperty('hasCalendar');

		const calendarEmail = await emailService.receive(c, {
			accountId: 10,
			userId: 20,
			calendarData: JSON.stringify({state: 'parsed'}),
		}, [], null);
		const ordinaryEmail = await emailService.receive(c, {
			accountId: 10,
			userId: 20,
		}, [], null);
		const [fullCalendar, briefCalendar, briefOrdinary] = await Promise.all([
			orm(c).select(emailListColumns).from(email).where(eq(email.emailId, calendarEmail.emailId)).get(),
			orm(c).select(emailBriefColumns).from(email).where(eq(email.emailId, calendarEmail.emailId)).get(),
			orm(c).select(emailBriefColumns).from(email).where(eq(email.emailId, ordinaryEmail.emailId)).get(),
		]);

		expect(fullCalendar).toMatchObject({hasCalendar: 1});
		expect(briefCalendar).toMatchObject({hasCalendar: 1});
		expect(briefOrdinary).toMatchObject({hasCalendar: 0});
		expect(briefCalendar).not.toHaveProperty('calendarData');
		warningSpy.mockRestore();
	});

	it('does not leak the internal envelope through webhook payloads', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 204 }));
		await webhookService.sendEmail(c, {
			emailId: 1,
			sendEmail: 'sender@example.com',
			name: 'Sender',
			toEmail: 'owner@example.com',
			toName: 'Owner',
			subject: 'Invitation',
			text: '',
			content: '',
			code: '',
			createTime: '2026-08-31 09:00:00',
			calendarData: JSON.stringify({ organizer: 'private@example.com', meetingUrl: 'https://meet.google.com/private' }),
		}, 'https://hooks.example.test/calendar');

		const payload = await fetchSpy.mock.calls[0][1].body;
		expect(payload).not.toContain('calendarData');
		expect(payload).not.toContain('private@example.com');
		expect(payload).not.toContain('meet.google.com');
		fetchSpy.mockRestore();
	});
});
