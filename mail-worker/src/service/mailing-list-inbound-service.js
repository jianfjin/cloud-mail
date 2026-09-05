import BizError from '../error/biz-error';

const normalize = value => value.trim().toLowerCase();

const mailingListInboundService = {
	async accept(c, {to, sender, fingerprint}) {
		const list = await c.env.db.prepare('SELECT * FROM mailing_list WHERE address_normalized COLLATE NOCASE = ?').bind(normalize(to)).first();
		if (!list) return null;
		if (list.state !== 'enabled') throw new BizError('Mailing list is not accepting posts');

		const members = (await c.env.db.prepare('SELECT email, email_normalized FROM mailing_list_member WHERE list_id = ? ORDER BY member_id').bind(list.list_id).all()).results;
		if (members.length === 0) throw new BizError('Mailing list has no members');
		const senderNormalized = normalize(sender);
		const isMember = members.some(member => member.email_normalized === senderNormalized);
		if (list.posting_policy === 'members' && !isMember) throw new BizError('Sender is not authorized to post');

		const existing = await c.env.db.prepare('SELECT post_id FROM mailing_list_post WHERE list_id = ? AND source_fingerprint = ?').bind(list.list_id, fingerprint).first();
		if (existing) return {accepted: true, postId: existing.post_id, duplicate: true};

		const day = new Date().toISOString().slice(0, 10);
		const setting = await c.env.db.prepare('SELECT mailing_list_daily_post_limit FROM setting LIMIT 1').first();
		const limit = list.daily_post_limit || setting?.mailing_list_daily_post_limit || 100;
		await c.env.db.prepare('INSERT OR IGNORE INTO mailing_list_daily_quota (list_id, utc_day, accepted_count) VALUES (?, ?, 0)').bind(list.list_id, day).run();
		const quota = await c.env.db.prepare('UPDATE mailing_list_daily_quota SET accepted_count = accepted_count + 1 WHERE list_id = ? AND utc_day = ? AND accepted_count < ?').bind(list.list_id, day, limit).run();
		if (quota.meta.changes !== 1) throw new BizError('Mailing list daily post limit reached');

		const snapshot = JSON.stringify({postingPolicy: list.posting_policy, replyPolicy: list.reply_policy, selfDelivery: list.self_delivery, acceptedDay: day});
		const post = await c.env.db.prepare('INSERT INTO mailing_list_post (list_id, source_fingerprint, sender_email, policy_snapshot) VALUES (?, ?, ?, ?)').bind(list.list_id, fingerprint, sender, snapshot).run();
		for (const member of members) {
			if (!list.self_delivery && member.email_normalized === senderNormalized) continue;
			const targetType = member.email_normalized.endsWith('@example.com') ? 'internal' : 'external';
			await c.env.db.prepare('INSERT INTO mailing_list_delivery (post_id, email, email_normalized, target_type) VALUES (?, ?, ?, ?)').bind(post.meta.last_row_id, member.email, member.email_normalized, targetType).run();
		}
		return {accepted: true, postId: post.meta.last_row_id, duplicate: false};
	},
};

export default mailingListInboundService;
