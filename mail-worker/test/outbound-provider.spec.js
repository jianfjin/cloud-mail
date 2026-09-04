import { describe, expect, it, vi } from 'vitest';
import { buildRawMime } from '../src/lib/outbound-mime';
import emailService from '../src/service/email-service';

const message = {
	name: 'Sender',
	accountEmail: 'sender@example.com',
	to: ['to@example.net'],
	cc: ['cc@example.net'],
	bcc: ['blind@example.net'],
	subject: 'Quarterly update',
	text: 'Plain text body',
	html: '<p>HTML body</p>',
	attachments: [],
	sendType: 'reply',
	messageId: '<previous@example.net>',
};

describe('outbound recipient providers', () => {
	it('maps each recipient role into the Cloudflare structured payload', async () => {
		const send = vi.fn().mockResolvedValue({ messageId: 'provider-message-id' });

		await emailService.sendByCloudflareEmail({ env: { email: { send } } }, message);

		expect(send).toHaveBeenCalledWith(expect.objectContaining({
			to: ['to@example.net'],
			cc: ['cc@example.net'],
			bcc: ['blind@example.net'],
			headers: {
				'in-reply-to': '<previous@example.net>',
				references: '<previous@example.net>',
			},
		}));
	});

	it('builds BCC-only raw MIME without recipient headers', () => {
		const raw = buildRawMime({ ...message, to: [], cc: [] });

		expect(raw).toContain('From: Sender <sender@example.com>');
		expect(raw).toContain('Subject: Quarterly update');
		expect(raw).not.toMatch(/^To:/m);
		expect(raw).not.toMatch(/^Cc:/m);
		expect(raw).not.toMatch(/^Bcc:/m);
		expect(raw).not.toContain('blind@example.net');
	});

	it('dispatches a BCC-only Cloudflare message individually as raw mail', async () => {
		const send = vi.fn().mockResolvedValue({ messageId: 'raw-provider-message-id' });
		const createEmailMessage = vi.fn((from, to, raw) => ({ from, to, raw }));

		await emailService.sendByCloudflareEmail({ env: { email: { send } } }, {
			...message,
			to: [],
			cc: [],
			bcc: ['blind-one@example.net', 'blind-two@example.net'],
			createEmailMessage,
		});

		expect(createEmailMessage).toHaveBeenCalledTimes(2);
		expect(createEmailMessage).toHaveBeenNthCalledWith(1, 'sender@example.com', 'blind-one@example.net', expect.not.stringContaining('Bcc:'));
		expect(createEmailMessage).toHaveBeenNthCalledWith(2, 'sender@example.com', 'blind-two@example.net', expect.not.stringContaining('Bcc:'));
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('keeps only visible Cc recipients and preserves attachment and reply metadata in raw MIME', () => {
		const raw = buildRawMime({
			...message,
			to: [],
			attachments: [{
				filename: 'agenda.ics',
				mimeType: 'text/calendar; charset=UTF-8',
				content: 'QkFTRTY0',
			}],
		});

		expect(raw).toContain('Cc: cc@example.net');
		expect(raw).not.toMatch(/^Bcc:/m);
		expect(raw).toContain('In-Reply-To: <previous@example.net>');
		expect(raw).toContain('References: <previous@example.net>');
		expect(raw).toContain('Content-Type: text/calendar; charset=UTF-8');
		expect(raw).toContain('filename="agenda.ics"');
		expect(raw).toContain('QkFTRTY0');
	});
});
