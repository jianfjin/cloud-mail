import PostalMime from 'postal-mime';
import {buildRawMime} from '../lib/outbound-mime';
import {emailConst, isDel} from '../const/entity-const';
import constant from '../const/constant';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';
import {prepareCalendarReceipt} from '../email/calendar-receipt';
import attService from './att-service';
import emailService from './email-service';
import settingService from './setting-service';

function parseSnapshot(value) {
	try {
		return JSON.parse(value || '{}');
	} catch (_) {
		return {};
	}
}

function safeFailureReason(error) {
	if (String(error?.message || '').includes('Source unavailable')) return 'Source unavailable';
	return 'Delivery failed';
}

function listSenderName(parsed, list, post) {
	const sender = parsed.from?.name || parsed.from?.address || post.sender_email;
	return sender + ' via ' + list.display_name;
}

async function sourceText(c, key) {
	const source = await c.env.r2.get(key);
	if (!source) throw new Error('Source unavailable');
	if (typeof source.text === 'function') return source.text();
	return new Response(source.body).text();
}

async function defaultExternal({c, params, delivery}) {
	const externalParams = {
		...params,
		envelopeRecipients: [delivery.email],
	};
	if (c.env.email) return emailService.sendRawByCloudflareEmail(c, externalParams);

	const {resendTokens} = await settingService.query(c);
	const token = resendTokens?.[emailUtils.getDomain(externalParams.accountEmail)];
	if (!token) throw new Error('Outbound provider unavailable');
	return emailService.sendRawByResendSmtp(token, externalParams);
}

async function toArrayBuffer(content) {
	if (content instanceof ArrayBuffer) return content;
	if (ArrayBuffer.isView(content)) {
		return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
	}
	if (content?.arrayBuffer) return content.arrayBuffer();
	return new ArrayBuffer(0);
}

async function defaultInternal({c, delivery, list, post, parsed, prepared}) {
	const account = await c.env.db.prepare(
		'SELECT account_id AS accountId, user_id AS userId, email, name FROM account WHERE email COLLATE NOCASE = ? AND is_del = 0',
	).bind(delivery.email).first();
	if (!account) throw new Error('Internal member mailbox unavailable');

	const {r2Domain} = await settingService.query(c);
	const attachments = [];
	const cidAttachments = [];
	for (const original of prepared.attachments) {
		const content = await toArrayBuffer(original.content);
		const attachment = {
			...original,
			content,
			key: constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(content) + fileUtils.getExtFileName(original.filename || ''),
			size: content.byteLength,
			calendarMethod: original.method || null,
		};
		attachments.push(attachment);
		if (attachment.contentId) cidAttachments.push(attachment);
	}

	const row = await emailService.receive(c, {
		toEmail: delivery.email,
		toName: account.name || emailUtils.getName(delivery.email),
		sendEmail: list.address,
		name: listSenderName(parsed, list, post),
		subject: parsed.subject || '',
		content: parsed.html || '',
		text: parsed.text || '',
		cc: '[]',
		bcc: '[]',
		recipient: JSON.stringify([{address: list.address, name: list.display_name}]),
		inReplyTo: parsed.inReplyTo || '',
		relation: parsed.references || '',
		messageId: parsed.messageId || '',
		calendarData: prepared.calendarData,
		userId: account.userId,
		accountId: account.accountId,
		isDel: isDel.DELETE,
		status: emailConst.status.SAVING,
	}, cidAttachments, r2Domain);

	for (const attachment of attachments) {
		attachment.emailId = row.emailId;
		attachment.userId = row.userId;
		attachment.accountId = row.accountId;
	}
	if (attachments.length) await attService.addAtt(c, attachments);
	await emailService.completeReceive(c, emailConst.status.RECEIVE, row.emailId);
}

async function appendAttempt(c, deliveryId, state, safeReason) {
	const count = await c.env.db.prepare(
		'SELECT count(*) AS count FROM mailing_list_delivery_attempt WHERE delivery_id = ?',
	).bind(deliveryId).first();
	await c.env.db.batch([
		c.env.db.prepare(
			'UPDATE mailing_list_delivery SET state = ?, safe_reason = ?, update_time = CURRENT_TIMESTAMP WHERE delivery_id = ?',
		).bind(state, safeReason, deliveryId),
		c.env.db.prepare(
			'INSERT INTO mailing_list_delivery_attempt (delivery_id, attempt_number, trigger_type, state, safe_reason) VALUES (?, ?, ?, ?, ?)',
		).bind(deliveryId, Number(count.count) + 1, 'queue', state, safeReason),
	]);
}

const mailingListDeliveryService = {
	async deliver(c, {postId, deliveryId, dispatchToken}, adapters = {}) {
		const claimed = await c.env.db.prepare(
			'UPDATE mailing_list_delivery SET state = ?, update_time = CURRENT_TIMESTAMP WHERE delivery_id = ? AND post_id = ? AND dispatch_token = ? AND state = ?',
		).bind('processing', deliveryId, postId, dispatchToken, 'queued').run();
		if (claimed.meta.changes !== 1) return {delivered: false, deliveryId};

		try {
			const record = await c.env.db.prepare(
				'SELECT d.delivery_id, d.email, d.target_type, p.post_id, p.sender_email, p.policy_snapshot, p.source_r2_key, l.address, l.display_name ' +
				'FROM mailing_list_delivery d ' +
				'JOIN mailing_list_post p ON p.post_id = d.post_id ' +
				'JOIN mailing_list l ON l.list_id = p.list_id ' +
				'WHERE d.delivery_id = ? AND p.post_id = ?',
			).bind(deliveryId, postId).first();
			if (!record) throw new Error('Delivery record unavailable');

			const rawSource = await sourceText(c, record.source_r2_key);
			const parsed = await PostalMime.parse(rawSource);
			const prepared = await prepareCalendarReceipt(parsed);
			const snapshot = parseSnapshot(record.policy_snapshot);
			const params = {
				name: listSenderName(parsed, record, record),
				accountEmail: record.address,
				to: [record.address],
				cc: [],
				bcc: [],
				subject: parsed.subject || '',
				text: parsed.text || '',
				html: parsed.html || '',
				attachments: prepared.attachments,
				replyTo: snapshot.replyPolicy === 'list' ? record.address : record.sender_email,
				headers: {
					'X-Cloud-Mail-Original-From': record.sender_email,
					'X-Cloud-Mail-List': record.address,
				},
			};
			const rawAttachments = await emailService.toRawAttachments(params.attachments);
			const raw = buildRawMime({...params, attachments: rawAttachments});
			const adapterInput = {
				c,
				delivery: record,
				list: {address: record.address, display_name: record.display_name},
				post: record,
				parsed,
				prepared,
				params,
				raw,
			};

			if (record.target_type === 'internal') {
				await (adapters.internal || defaultInternal)(adapterInput);
			} else {
				await (adapters.external || defaultExternal)(adapterInput);
			}
			await appendAttempt(c, deliveryId, 'delivered', '');
			return {delivered: true, deliveryId};
		} catch (error) {
			await appendAttempt(c, deliveryId, 'failed', safeFailureReason(error));
			console.error('Mailing-list delivery failed');
			return {delivered: false, deliveryId};
		}
	},
};

export default mailingListDeliveryService;
