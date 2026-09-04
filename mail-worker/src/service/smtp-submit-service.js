import { connect as connectSocket } from 'cloudflare:sockets';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBase64(value) {
	const bytes = encoder.encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function dotStuff(rawMessage) {
	const normalized = String(rawMessage || '').replace(/\r?\n/g, '\r\n').replace(/\r\n?$/g, '');
	return `${normalized.replace(/(^|\r\n)\./g, '$1..')}\r\n.\r\n`;
}

async function createResponseReader(socket) {
	const reader = socket.readable.getReader();
	let buffer = '';

	return {
		async read() {
			let responseCode = null;
			while (true) {
				const newline = buffer.indexOf('\n');
				if (newline >= 0) {
					const line = buffer.slice(0, newline).replace(/\r$/, '');
					buffer = buffer.slice(newline + 1);
					const match = line.match(/^(\d{3})([- ])/);
					if (!match) continue;
					responseCode ||= Number(match[1]);
					if (match[2] === ' ') return { code: responseCode, line };
					continue;
				}

				const next = await reader.read();
				if (next.done) throw new Error('SMTP connection closed before a response was received.');
				buffer += decoder.decode(next.value, { stream: true });
			}
		},
		release() {
			reader.releaseLock();
		},
	};
}

function assertResponse(response, allowedCodes) {
	if (!allowedCodes.includes(response.code)) {
		throw new Error(`SMTP rejected the message with status ${response.code}.`);
	}
}

export async function submitRawSmtp({ apiKey, from, recipients, rawMessage, connect = connectSocket }) {
	if (!apiKey || !from || !Array.isArray(recipients) || recipients.length === 0) {
		throw new Error('SMTP submission is missing sender, recipients, or credentials.');
	}

	const socket = connect({ hostname: 'smtp.resend.com', port: 465, secureTransport: 'on' });
	if (socket.opened) await socket.opened;
	const responses = await createResponseReader(socket);
	const writer = socket.writable.getWriter();

	const command = async (value, allowedCodes) => {
		await writer.write(encoder.encode(`${value}\r\n`));
		const response = await responses.read();
		assertResponse(response, allowedCodes);
	};

	try {
		assertResponse(await responses.read(), [220]);
		await command('EHLO cloud-mail', [250]);
		await command(`AUTH PLAIN ${encodeBase64(`\u0000resend\u0000${apiKey}`)}`, [235]);
		await command(`MAIL FROM:<${from}>`, [250]);
		for (const recipient of recipients) {
			await command(`RCPT TO:<${recipient}>`, [250, 251]);
		}
		await command('DATA', [354]);
		await writer.write(encoder.encode(dotStuff(rawMessage)));
		assertResponse(await responses.read(), [250]);
		await command('QUIT', [221]);
	} finally {
		writer.releaseLock();
		responses.release();
		socket.close();
	}
}
