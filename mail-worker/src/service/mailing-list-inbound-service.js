import BizError from '../error/biz-error';

const MAX_EXTERNAL_SOURCE_BYTES = 5 * 1024 * 1024;

const normalize = value => String(value || '').trim().toLowerCase();

function sourceByteLength(raw) {
	if (typeof raw === 'string') return new TextEncoder().encode(raw).byteLength;
	if (raw instanceof ArrayBuffer) return raw.byteLength;
	if (ArrayBuffer.isView(raw)) return raw.byteLength;
	return 0;
}

function sourceKey(listId, postId) {
	const token = globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(16).slice(2);
	return 'mailing-list/' + listId + '/' + postId + '/' + token + '.eml';
}

async function internalMemberAddresses(c, members) {
	if (!members.length) return new Set();

	try {
		const placeholders = members.map(() => '?').join(', ');
		const rows = await c.env.db.prepare(
			'SELECT lower(email) AS email_normalized ' +
			'FROM account ' +
			'WHERE is_del = 0 AND lower(email) IN (' + placeholders + ')',
		).bind(...members.map(member => member.email_normalized)).all();
		return new Set(rows.results.map(row => row.email_normalized));
	} catch (error) {
		if (String(error.message).includes('no such table')) return new Set();
		throw error;
	}
}

async function rollbackAcceptance(c, {postId, sourceR2Key, quotaClaimed, listId, day}) {
	if (postId) {
		await c.env.db.batch([
			c.env.db.prepare('DELETE FROM mailing_list_delivery_attempt WHERE delivery_id IN (SELECT delivery_id FROM mailing_list_delivery WHERE post_id = ?)').bind(postId),
			c.env.db.prepare('DELETE FROM mailing_list_delivery WHERE post_id = ?').bind(postId),
			c.env.db.prepare('DELETE FROM mailing_list_post WHERE post_id = ?').bind(postId),
		]);
	}
	if (sourceR2Key) await c.env.r2.delete(sourceR2Key);
	if (quotaClaimed) {
		await c.env.db.prepare(
			'UPDATE mailing_list_daily_quota SET accepted_count = accepted_count - 1 WHERE list_id = ? AND utc_day = ? AND accepted_count > 0',
		).bind(listId, day).run();
	}
}

async function duplicateAcceptance(c, listId, fingerprint) {
	const existing = await c.env.db.prepare(
		'SELECT post_id, state FROM mailing_list_post WHERE list_id = ? AND source_fingerprint = ?',
	).bind(listId, fingerprint).first();
	if (existing && ['staging', 'queued', 'accepted'].includes(existing.state)) {
		return {accepted: true, postId: existing.post_id, duplicate: true};
	}
	return null;
}

const mailingListInboundService = {
	async accept(c, {to, sender, fingerprint, raw}) {
		const list = await c.env.db.prepare(
			'SELECT * FROM mailing_list WHERE address_normalized COLLATE NOCASE = ?',
		).bind(normalize(to)).first();
		if (!list) return null;
		if (list.state !== 'enabled') throw new BizError('Mailing list is not accepting posts');

		const members = (await c.env.db.prepare(
			'SELECT email, email_normalized FROM mailing_list_member WHERE list_id = ? ORDER BY member_id',
		).bind(list.list_id).all()).results;
		if (members.length === 0) throw new BizError('Mailing list has no members');

		const senderNormalized = normalize(sender);
		const isMember = members.some(member => member.email_normalized === senderNormalized);
		if (list.posting_policy === 'members' && !isMember) {
			throw new BizError('Sender is not authorized to post');
		}
		if (list.posting_policy === 'allowlist') {
			const allowed = await c.env.db.prepare(
				'SELECT sender_id FROM mailing_list_sender WHERE list_id = ? AND email_normalized COLLATE NOCASE = ?',
			).bind(list.list_id, senderNormalized).first();
			if (!allowed) throw new BizError('Sender is not authorized to post');
		}
		if (!raw || !c.env.r2?.put || !c.env.mailingListQueue?.sendBatch) {
			throw new BizError('Mailing list delivery unavailable');
		}

		const duplicate = await duplicateAcceptance(c, list.list_id, fingerprint);
		if (duplicate) return duplicate;
		const existing = await c.env.db.prepare(
			'SELECT post_id FROM mailing_list_post WHERE list_id = ? AND source_fingerprint = ?',
		).bind(list.list_id, fingerprint).first();
		if (existing) throw new BizError('Mailing list post is already being processed');

		const internalAddresses = await internalMemberAddresses(c, members);
		const targets = members.map(member => ({
			...member,
			targetType: internalAddresses.has(member.email_normalized) ? 'internal' : 'external',
			skipped: !list.self_delivery && member.email_normalized === senderNormalized,
		}));
		if (targets.some(target => target.targetType === 'external') && sourceByteLength(raw) > MAX_EXTERNAL_SOURCE_BYTES) {
			throw new BizError('Mailing list source is too large for external delivery');
		}

		const day = new Date().toISOString().slice(0, 10);
		const setting = await c.env.db.prepare('SELECT mailing_list_daily_post_limit FROM setting LIMIT 1').first();
		const limit = list.daily_post_limit || setting?.mailing_list_daily_post_limit || 100;
		const snapshot = JSON.stringify({
			postingPolicy: list.posting_policy,
			replyPolicy: list.reply_policy,
			selfDelivery: list.self_delivery,
			dailyPostLimit: limit,
			acceptedDay: day,
		});
		let postId = 0;
		let sourceR2Key = '';
		let quotaClaimed = false;

		try {
			const post = await c.env.db.prepare(
				'INSERT INTO mailing_list_post ' +
				'(list_id, source_fingerprint, sender_email, policy_snapshot, state) ' +
				"VALUES (?, ?, ?, ?, 'staging')",
			).bind(list.list_id, fingerprint, sender, snapshot).run();
			postId = post.meta.last_row_id;

			await c.env.db.prepare(
				'INSERT OR IGNORE INTO mailing_list_daily_quota (list_id, utc_day, accepted_count) VALUES (?, ?, 0)',
			).bind(list.list_id, day).run();
			const quota = await c.env.db.prepare(
				'UPDATE mailing_list_daily_quota ' +
				'SET accepted_count = accepted_count + 1 ' +
				'WHERE list_id = ? AND utc_day = ? AND accepted_count < ?',
			).bind(list.list_id, day, limit).run();
			if (quota.meta.changes !== 1) throw new BizError('Mailing list daily post limit reached');
			quotaClaimed = true;

			sourceR2Key = sourceKey(list.list_id, postId);
			await c.env.r2.put(sourceR2Key, raw);

			const statements = [c.env.db.prepare(
				"UPDATE mailing_list_post SET source_r2_key = ?, state = 'queued' WHERE post_id = ?",
			).bind(sourceR2Key, postId)];
			const pendingTargets = [];
			for (const target of targets) {
				if (target.skipped) {
					statements.push(c.env.db.prepare(
						'INSERT INTO mailing_list_delivery ' +
						'(post_id, email, email_normalized, target_type, state, safe_reason) ' +
						"VALUES (?, ?, ?, ?, 'skipped', 'Self delivery disabled')",
					).bind(postId, target.email, target.email_normalized, target.targetType));
					continue;
				}

				const dispatchToken = globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(16).slice(2);
				pendingTargets.push({statementIndex: statements.length, dispatchToken});
				statements.push(c.env.db.prepare(
					'INSERT INTO mailing_list_delivery ' +
					'(post_id, email, email_normalized, target_type, state, dispatch_token) ' +
					"VALUES (?, ?, ?, ?, 'queued', ?)",
				).bind(postId, target.email, target.email_normalized, target.targetType, dispatchToken));
			}
			const results = await c.env.db.batch(statements);
			const dispatches = pendingTargets.map(target => ({
					body: {
						postId,
						deliveryId: results[target.statementIndex].meta.last_row_id,
						dispatchToken: target.dispatchToken,
					},
				}));
			if (dispatches.length) await c.env.mailingListQueue.sendBatch(dispatches);
			await c.env.db.prepare('UPDATE mailing_list_post SET state = ' + `'accepted'` + ' WHERE post_id = ?').bind(postId).run();

			return {accepted: true, postId, duplicate: false};
		} catch (error) {
			if (!postId) {
				const concurrentDuplicate = await duplicateAcceptance(c, list.list_id, fingerprint);
				if (concurrentDuplicate) return concurrentDuplicate;
			}
			await rollbackAcceptance(c, {postId, sourceR2Key, quotaClaimed, listId: list.list_id, day});
			if (error instanceof BizError) throw error;
			console.error('Mailing-list acceptance failed');
			throw new BizError('Mailing list delivery unavailable');
		}
	},
};

export default mailingListInboundService;
