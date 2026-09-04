import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import account from '../src/entity/account';
import email from '../src/entity/email';
import orm from '../src/entity/orm';
import emailService from '../src/service/email-service';
import roleService from '../src/service/role-service';
import settingService from '../src/service/setting-service';

const c = { env: { ...env, admin: 'admin@example.com' } };

async function resetSchema() {
	await env.db.prepare('DROP TABLE IF EXISTS email').run();
	await env.db.prepare('DROP TABLE IF EXISTS account').run();
	await env.db.prepare([
		'CREATE TABLE email (',
		'email_id INTEGER PRIMARY KEY AUTOINCREMENT, send_email TEXT, name TEXT, account_id INTEGER NOT NULL, user_id INTEGER NOT NULL,',
		'subject TEXT, code TEXT NOT NULL DEFAULT \'\', text TEXT, content TEXT, calendar_data TEXT, cc TEXT DEFAULT \'[]\',',
		'bcc TEXT DEFAULT \'[]\', recipient TEXT, to_email TEXT NOT NULL DEFAULT \'\', to_name TEXT NOT NULL DEFAULT \'\',',
		'in_reply_to TEXT NOT NULL DEFAULT \'\', relation TEXT NOT NULL DEFAULT \'\', message_id TEXT NOT NULL DEFAULT \'\',',
		'type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, resend_email_id TEXT, message TEXT, unread INTEGER NOT NULL DEFAULT 0,',
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
}

describe('internal recipient copies', () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await resetSchema();
		await orm(c).insert(account).values([
			{ accountId: 1, email: 'to@example.com', name: 'To', userId: 1 },
			{ accountId: 2, email: 'cc@example.com', name: 'Cc', userId: 2 },
			{ accountId: 3, email: 'blind-one@example.com', name: 'Blind One', userId: 3 },
			{ accountId: 4, email: 'blind-two@example.com', name: 'Blind Two', userId: 4 },
		]).run();
		vi.spyOn(settingService, 'query').mockResolvedValue({ noRecipient: 1 });
		vi.spyOn(roleService, 'selectByUserIds').mockResolvedValue([
			{ userId: 1, banEmail: '[]', availDomain: '[]' },
			{ userId: 2, banEmail: '[]', availDomain: '[]' },
			{ userId: 3, banEmail: '[]', availDomain: '[]' },
			{ userId: 4, banEmail: '[]', availDomain: '[]' },
		]);
		vi.spyOn(roleService, 'hasAvailDomainPerm').mockReturnValue(true);
		vi.spyOn(roleService, 'isBanEmail').mockReturnValue(false);
	});

	it('creates one BCC-sanitized copy per unique To, CC, and BCC recipient', async () => {
		const sent = await orm(c).insert(email).values({
			sendEmail: 'admin@example.com',
			name: 'Admin',
			accountId: 9,
			userId: 9,
			subject: 'Private distribution',
			text: 'Hello',
			content: '<p>Hello</p>',
			recipient: JSON.stringify([{ address: 'to@example.com', name: '' }]),
			cc: JSON.stringify([{ address: 'cc@example.com', name: '' }]),
			bcc: JSON.stringify([
				{ address: 'blind-one@example.com', name: '' },
				{ address: 'blind-two@example.com', name: '' },
			]),
		}).returning().get();

		await emailService.HandleOnSiteEmail(c, {
			to: ['to@example.com'],
			cc: ['cc@example.com'],
			bcc: ['blind-one@example.com', 'blind-two@example.com'],
			all: ['to@example.com', 'cc@example.com', 'blind-one@example.com', 'blind-two@example.com'],
		}, sent, []);

		const copies = await orm(c).select().from(email).where(email.emailId).all();
		expect(copies).toHaveLength(5);
		for (const copy of copies.filter(row => row.emailId !== sent.emailId)) {
			expect(JSON.parse(copy.recipient)).toEqual([{ address: 'to@example.com', name: '' }]);
			expect(JSON.parse(copy.cc)).toEqual([{ address: 'cc@example.com', name: '' }]);
			expect(JSON.parse(copy.bcc)).toEqual([]);
		}
	});

	it('rejects a cross-role duplicate before loading sending configuration', async () => {
		const querySpy = vi.spyOn(settingService, 'query');

		await expect(emailService.send(c, {
			receiveEmail: ['person@example.com'],
			cc: ['PERSON@example.com'],
			bcc: [],
		}, 1)).rejects.toMatchObject({code: 400});

		expect(querySpy).not.toHaveBeenCalled();
	});
});
