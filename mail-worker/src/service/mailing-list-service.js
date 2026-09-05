import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import verifyUtils from '../utils/verify-utils';

function normalize(email) {
	return email.trim().toLowerCase();
}

function limitValue(value, label) {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new BizError(label + ' must be a positive integer');
	return parsed;
}

function withEffectiveLimits(list, setting) {
	if (!list) return null;
	return {
		...list,
		effectiveMemberLimit: list.member_limit || setting?.mailing_list_member_limit || 500,
		effectiveDailyPostLimit: list.daily_post_limit || setting?.mailing_list_daily_post_limit || 100,
	};
}

const mailingListService = {
	async detail(c, listId) {
		const [list, setting] = await Promise.all([
			c.env.db.prepare('SELECT * FROM mailing_list WHERE list_id = ?').bind(Number(listId)).first(),
			c.env.db.prepare('SELECT mailing_list_member_limit, mailing_list_daily_post_limit FROM setting LIMIT 1').first(),
		]);
		return withEffectiveLimits(list, setting);
	},

	async list(c, query = {}) {
		const search = query.search?.trim();
		const statement = search
			? c.env.db.prepare('SELECT * FROM mailing_list WHERE address LIKE ? OR display_name LIKE ? ORDER BY list_id DESC').bind('%' + search + '%', '%' + search + '%')
			: c.env.db.prepare('SELECT * FROM mailing_list ORDER BY list_id DESC');
		const [lists, setting] = await Promise.all([
			statement.all(),
			c.env.db.prepare('SELECT mailing_list_member_limit, mailing_list_daily_post_limit FROM setting LIMIT 1').first(),
		]);
		return lists.results.map(list => withEffectiveLimits(list, setting));
	},

	async create(c, params) {
		const address = params.address?.trim();
		const displayName = params.displayName?.trim();
		if (!address || !displayName || !verifyUtils.isEmail(address)) {
			throw new BizError('A valid address and display name are required');
		}
		if (!c.env.domain.some(domain => domain.toLowerCase() === emailUtils.getDomain(address).toLowerCase())) {
			throw new BizError('List address must use an owned domain');
		}
		const addressNormalized = normalize(address);
		const account = await c.env.db.prepare('SELECT account_id FROM account WHERE email COLLATE NOCASE = ?').bind(address).first();
		const existing = await c.env.db.prepare('SELECT list_id FROM mailing_list WHERE address_normalized COLLATE NOCASE = ?').bind(addressNormalized).first();
		if (account || existing) {
			throw new BizError('List address is already reserved');
		}
		const memberLimit = Number.isInteger(params.memberLimit) && params.memberLimit > 0 ? params.memberLimit : null;
		const dailyPostLimit = Number.isInteger(params.dailyPostLimit) && params.dailyPostLimit > 0 ? params.dailyPostLimit : null;
		const result = await c.env.db.prepare('INSERT INTO mailing_list (address, address_normalized, display_name, member_limit, daily_post_limit) VALUES (?, ?, ?, ?, ?)').bind(address, addressNormalized, displayName, memberLimit, dailyPostLimit).run();
		return await c.env.db.prepare('SELECT * FROM mailing_list WHERE list_id = ?').bind(result.meta.last_row_id).first();
	},

	async addMember(c, listId, email) {
		const list = await this.detail(c, listId);
		if (!list || list.state === 'retired') throw new BizError('Mailing list not found');
		if (!email || !verifyUtils.isEmail(email)) throw new BizError('A valid member email is required');
		const normalized = normalize(email);
		const listMember = await c.env.db.prepare('SELECT list_id FROM mailing_list WHERE address_normalized COLLATE NOCASE = ?').bind(normalized).first();
		if (listMember) throw new BizError('A mailing list cannot be a member');
		const limit = list.effectiveMemberLimit;
		const added = await c.env.db.prepare(
			'INSERT INTO mailing_list_member (list_id, email, email_normalized) ' +
			'SELECT ?, ?, ? ' +
			'WHERE NOT EXISTS (SELECT 1 FROM mailing_list_member WHERE list_id = ? AND email_normalized COLLATE NOCASE = ?) ' +
			'AND (SELECT count(*) FROM mailing_list_member WHERE list_id = ?) < ?',
		).bind(Number(listId), email.trim(), normalized, Number(listId), normalized, Number(listId), limit).run();
		if (added.meta.changes !== 1) {
			const existing = await c.env.db.prepare(
				'SELECT member_id FROM mailing_list_member WHERE list_id = ? AND email_normalized COLLATE NOCASE = ?',
			).bind(Number(listId), normalized).first();
			if (existing) throw new BizError('Member already exists');
			throw new BizError('Member limit reached');
		}
		return await this.members(c, listId);
	},

	async members(c, listId) {
		return (await c.env.db.prepare('SELECT * FROM mailing_list_member WHERE list_id = ? ORDER BY member_id').bind(Number(listId)).all()).results;
	},

	async removeMember(c, listId, memberId) {
		await c.env.db.prepare('DELETE FROM mailing_list_member WHERE list_id = ? AND member_id = ?').bind(Number(listId), Number(memberId)).run();
	},

	async update(c, listId, params) {
		const list = await this.detail(c, listId);
		if (!list || list.state === 'retired') throw new BizError('Mailing list not found');
		if (params.address && normalize(params.address) !== normalize(list.address)) {
			throw new BizError('Mailing-list address is immutable');
		}

		const values = [];
		const assignments = [];
		if (params.displayName !== undefined) {
			const displayName = params.displayName?.trim();
			if (!displayName) throw new BizError('A display name is required');
			assignments.push('display_name = ?');
			values.push(displayName);
		}
		if (params.postingPolicy !== undefined) {
			if (!['members', 'allowlist', 'public'].includes(params.postingPolicy)) throw new BizError('Invalid posting policy');
			assignments.push('posting_policy = ?');
			values.push(params.postingPolicy);
		}
		if (params.replyPolicy !== undefined) {
			if (!['sender', 'list'].includes(params.replyPolicy)) throw new BizError('Invalid reply policy');
			assignments.push('reply_policy = ?');
			values.push(params.replyPolicy);
		}
		if (params.selfDelivery !== undefined) {
			assignments.push('self_delivery = ?');
			values.push(params.selfDelivery ? 1 : 0);
		}
		if (params.memberLimit !== undefined) {
			assignments.push('member_limit = ?');
			values.push(limitValue(params.memberLimit, 'Member limit'));
		}
		if (params.dailyPostLimit !== undefined) {
			assignments.push('daily_post_limit = ?');
			values.push(limitValue(params.dailyPostLimit, 'Daily post limit'));
		}
		if (assignments.length) {
			assignments.push('update_time = CURRENT_TIMESTAMP');
			await c.env.db.prepare('UPDATE mailing_list SET ' + assignments.join(', ') + ' WHERE list_id = ?').bind(...values, Number(listId)).run();
		}
		return this.detail(c, listId);
	},

	async senders(c, listId) {
		return (await c.env.db.prepare('SELECT * FROM mailing_list_sender WHERE list_id = ? ORDER BY sender_id').bind(Number(listId)).all()).results;
	},

	async addSender(c, listId, email) {
		const list = await this.detail(c, listId);
		if (!list || list.state === 'retired') throw new BizError('Mailing list not found');
		if (!email || !verifyUtils.isEmail(email)) throw new BizError('A valid sender email is required');
		const normalized = normalize(email);
		const existing = await c.env.db.prepare('SELECT sender_id FROM mailing_list_sender WHERE list_id = ? AND email_normalized COLLATE NOCASE = ?').bind(Number(listId), normalized).first();
		if (existing) throw new BizError('Sender already exists');
		await c.env.db.prepare('INSERT INTO mailing_list_sender (list_id, email, email_normalized) VALUES (?, ?, ?)').bind(Number(listId), email.trim(), normalized).run();
		return this.senders(c, listId);
	},

	async removeSender(c, listId, senderId) {
		await c.env.db.prepare('DELETE FROM mailing_list_sender WHERE list_id = ? AND sender_id = ?').bind(Number(listId), Number(senderId)).run();
	},

	async setState(c, listId, state) {
		if (!['enabled', 'disabled', 'retired'].includes(state)) throw new BizError('Invalid mailing-list state');
		await c.env.db.prepare('UPDATE mailing_list SET state = ?, update_time = CURRENT_TIMESTAMP WHERE list_id = ?').bind(state, Number(listId)).run();
		return await this.detail(c, listId);
	},

	retire(c, listId) {
		return this.setState(c, listId, 'retired');
	},

	restore(c, listId) {
		return this.setState(c, listId, 'enabled');
	},
};

export default mailingListService;
