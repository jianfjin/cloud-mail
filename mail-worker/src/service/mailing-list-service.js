import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import verifyUtils from '../utils/verify-utils';

function normalize(email) {
	return email.trim().toLowerCase();
}

const mailingListService = {
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
		const result = await c.env.db.prepare('INSERT INTO mailing_list (address, address_normalized, display_name) VALUES (?, ?, ?)').bind(address, addressNormalized, displayName).run();
		return await c.env.db.prepare('SELECT * FROM mailing_list WHERE list_id = ?').bind(result.meta.last_row_id).first();
	},
};

export default mailingListService;
