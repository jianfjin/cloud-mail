import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import verifyUtils from '../utils/verify-utils';

function normalize(email) {
	return email.trim().toLowerCase();
}

const mailingListService = {
	async detail(c, listId) {
		return await c.env.db.prepare('SELECT * FROM mailing_list WHERE list_id = ?').bind(Number(listId)).first();
	},

	async list(c, query = {}) {
		const search = query.search?.trim();
		const statement = search
			? c.env.db.prepare('SELECT * FROM mailing_list WHERE address LIKE ? OR display_name LIKE ? ORDER BY list_id DESC').bind('%' + search + '%', '%' + search + '%')
			: c.env.db.prepare('SELECT * FROM mailing_list ORDER BY list_id DESC');
		return (await statement.all()).results;
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
		const setting = await c.env.db.prepare('SELECT mailing_list_member_limit FROM setting LIMIT 1').first();
		const limit = list.member_limit || setting?.mailing_list_member_limit || 500;
		const count = await c.env.db.prepare('SELECT count(*) AS count FROM mailing_list_member WHERE list_id = ?').bind(Number(listId)).first();
		const existing = await c.env.db.prepare('SELECT member_id FROM mailing_list_member WHERE list_id = ? AND email_normalized COLLATE NOCASE = ?').bind(Number(listId), normalized).first();
		if (existing) throw new BizError('Member already exists');
		if (count.count >= limit) throw new BizError('Member limit reached');
		await c.env.db.prepare('INSERT INTO mailing_list_member (list_id, email, email_normalized) VALUES (?, ?, ?)').bind(Number(listId), email.trim(), normalized).run();
		return await this.members(c, listId);
	},

	async members(c, listId) {
		return (await c.env.db.prepare('SELECT * FROM mailing_list_member WHERE list_id = ? ORDER BY member_id').bind(Number(listId)).all()).results;
	},

	async removeMember(c, listId, memberId) {
		await c.env.db.prepare('DELETE FROM mailing_list_member WHERE list_id = ? AND member_id = ?').bind(Number(listId), Number(memberId)).run();
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
