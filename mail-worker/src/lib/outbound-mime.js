function sanitizeHeader(value) {
	return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function base64(value) {
	const bytes = new TextEncoder().encode(String(value || ''));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function foldBase64(value) {
	return String(value || '').replace(/\s+/g, '').match(/.{1,76}/g)?.join('\r\n') || '';
}

function boundary(label) {
	const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return `=_cloud_mail_${label}_${id}`;
}

function messageId(address) {
	const domain = sanitizeHeader(address).split('@')[1] || 'cloud-mail.local';
	const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return `<${id}@${domain}>`;
}

function formatFrom(name, address) {
	const safeAddress = sanitizeHeader(address);
	const safeName = sanitizeHeader(name);
	return safeName ? `${safeName} <${safeAddress}>` : safeAddress;
}

function formatAddresses(addresses = []) {
	return addresses.map(sanitizeHeader).filter(Boolean).join(', ');
}

function textPart(contentType, content) {
	return [
		`Content-Type: ${contentType}; charset=UTF-8`,
		'Content-Transfer-Encoding: base64',
		'',
		foldBase64(base64(content)),
	].join('\r\n');
}

function attachmentPart(attachment) {
	const contentType = sanitizeHeader(attachment.mimeType || attachment.contentType || attachment.type || 'application/octet-stream');
	const filename = sanitizeHeader(attachment.filename || 'attachment');
	const disposition = attachment.contentId ? 'inline' : 'attachment';
	const headers = [
		`Content-Type: ${contentType}`,
		'Content-Transfer-Encoding: base64',
		`Content-Disposition: ${disposition}; filename="${filename.replaceAll('"', '')}"`,
	];

	if (attachment.contentId) {
		headers.push(`Content-ID: <${sanitizeHeader(attachment.contentId).replace(/^<|>$/g, '')}>`);
	}

	headers.push('', foldBase64(attachment.content));
	return headers.join('\r\n');
}

function bodyPart({ text, html, attachments }) {
	const hasText = Boolean(text);
	const hasHtml = Boolean(html);
	let body;

	if (hasText && hasHtml) {
		const alternativeBoundary = boundary('alternative');
		body = [
			`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
			'',
			`--${alternativeBoundary}`,
			textPart('text/plain', text),
			`--${alternativeBoundary}`,
			textPart('text/html', html),
			`--${alternativeBoundary}--`,
		].join('\r\n');
	} else if (hasHtml) {
		body = textPart('text/html', html);
	} else {
		body = textPart('text/plain', text || '');
	}

	if (!attachments.length) return body;

	const mixedBoundary = boundary('mixed');
	return [
		`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
		'',
		`--${mixedBoundary}`,
		body,
		...attachments.flatMap(attachment => [`--${mixedBoundary}`, attachmentPart(attachment)]),
		`--${mixedBoundary}--`,
	].join('\r\n');
}

export function buildRawMime({
	name,
	accountEmail,
	to = [],
	cc = [],
	subject,
	text,
	html,
	attachments = [],
	sendType,
	messageId: replyMessageId,
}) {
	const headers = [
		`From: ${formatFrom(name, accountEmail)}`,
		`Subject: ${sanitizeHeader(subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: ${messageId(accountEmail)}`,
		'MIME-Version: 1.0',
	];
	const visibleTo = formatAddresses(to);
	const visibleCc = formatAddresses(cc);
	if (visibleTo) headers.splice(1, 0, `To: ${visibleTo}`);
	if (visibleCc) headers.splice(visibleTo ? 2 : 1, 0, `Cc: ${visibleCc}`);
	if (sendType === 'reply' && replyMessageId) {
		const relatedMessageId = sanitizeHeader(replyMessageId);
		headers.push(`In-Reply-To: ${relatedMessageId}`, `References: ${relatedMessageId}`);
	}

	const parts = attachments.filter(attachment => attachment?.content);
	return `${headers.join('\r\n')}\r\n\r\n${bodyPart({ text, html, attachments: parts })}\r\n`;
}
