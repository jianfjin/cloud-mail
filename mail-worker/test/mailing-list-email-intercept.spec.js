import {describe, expect, it, vi} from 'vitest';
import BizError from '../src/error/biz-error';
import {interceptMailingListMessage} from '../src/email/email';

describe('mailing-list email interception', () => {
	it('passes the original raw MIME to list acceptance and stops ordinary inbound handling', async () => {
		const accept = vi.fn().mockResolvedValue({accepted: true, postId: 1});
		const message = {to: 'team@example.com', setReject: vi.fn()};
		const intercepted = await interceptMailingListMessage({
			message,
			env: {db: {}},
			parsedEmail: {from: {address: 'sender@example.com'}, messageId: '<source@example.test>'},
			raw: 'From: Sender <sender@example.com>\r\n\r\nPrivate source',
			accept,
		});

		expect(intercepted).toBe(true);
		expect(accept).toHaveBeenCalledWith({env: {db: {}}}, {
			to: 'team@example.com',
			sender: 'sender@example.com',
			fingerprint: '<source@example.test>',
			raw: 'From: Sender <sender@example.com>\r\n\r\nPrivate source',
		});
		expect(message.setReject).not.toHaveBeenCalled();
	});

	it('continues ordinary inbound handling when no list identity is claimed', async () => {
		const accept = vi.fn().mockResolvedValue(null);
		const message = {to: 'mailbox@example.com', setReject: vi.fn()};

		await expect(interceptMailingListMessage({
			message,
			env: {db: {}},
			parsedEmail: {from: {address: 'sender@example.com'}, messageId: '<source@example.test>'},
			raw: 'ordinary source',
			accept,
		})).resolves.toBe(false);
		expect(message.setReject).not.toHaveBeenCalled();
	});

	it('rejects a list policy failure before ordinary forwarding behavior can run', async () => {
		const accept = vi.fn().mockRejectedValue(new BizError('Sender is not authorized to post'));
		const message = {to: 'team@example.com', setReject: vi.fn()};

		await expect(interceptMailingListMessage({
			message,
			env: {db: {}},
			parsedEmail: {from: {address: 'blocked@example.com'}, messageId: '<source@example.test>'},
			raw: 'blocked source',
			accept,
		})).resolves.toBe(true);
		expect(message.setReject).toHaveBeenCalledWith('Sender is not authorized to post');
	});
});
