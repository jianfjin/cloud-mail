import { describe, expect, it, vi } from 'vitest';
import { submitRawSmtp } from '../src/service/smtp-submit-service';

function socketFor(responses) {
	const encoder = new TextEncoder();
	const writes = [];
	let index = 0;

	return {
		writes,
		socket: {
			readable: {
				getReader() {
					return {
						async read() {
							if (index >= responses.length) return { done: true };
							return { done: false, value: encoder.encode(responses[index++]) };
						},
						releaseLock() {},
					};
				},
			},
			writable: {
				getWriter() {
					return {
						async write(value) {
							writes.push(new TextDecoder().decode(value));
						},
						async close() {},
						releaseLock() {},
					};
				},
			},
			close: vi.fn(),
		},
	};
}

describe('submitRawSmtp', () => {
	it('uses implicit TLS, submits every envelope recipient, and dot-stuffs raw MIME', async () => {
		const { socket, writes } = socketFor([
			'220 smtp.resend.com ready\r\n',
			'250-smtp.resend.com\r\n250 AUTH PLAIN\r\n',
			'235 authenticated\r\n',
			'250 sender accepted\r\n',
			'250 recipient accepted\r\n',
			'250 recipient accepted\r\n',
			'354 send message\r\n',
			'250 queued\r\n',
			'221 bye\r\n',
		]);
		const connect = vi.fn(() => socket);

		await submitRawSmtp({
			apiKey: 're_test_key',
			from: 'sender@example.com',
			recipients: ['cc@example.net', 'blind@example.net'],
			rawMessage: 'Subject: Test\r\n\r\nfirst line\r\n.leading dot',
			connect,
		});

		expect(connect).toHaveBeenCalledWith({
			hostname: 'smtp.resend.com',
			port: 465,
			secureTransport: 'on',
		});
		expect(writes.join('')).toContain('AUTH PLAIN ');
		expect(writes).toContain('MAIL FROM:<sender@example.com>\r\n');
		expect(writes).toContain('RCPT TO:<cc@example.net>\r\n');
		expect(writes).toContain('RCPT TO:<blind@example.net>\r\n');
		expect(writes.join('')).toContain('first line\r\n..leading dot\r\n.\r\n');
	});
});
