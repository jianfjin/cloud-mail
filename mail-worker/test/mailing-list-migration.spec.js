import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it} from 'vitest';
import {dbInit} from '../src/init/init';

const c = {env};

async function resetSchema() {
	for (const table of ['mailing_list_rejection', 'mailing_list_delivery_attempt', 'mailing_list_delivery', 'mailing_list_post', 'mailing_list_daily_quota', 'mailing_list_sender', 'mailing_list_member', 'mailing_list', 'setting', 'account', 'perm']) {
		await env.db.prepare('DROP TABLE IF EXISTS ' + table).run();
	}
	await env.db.prepare('CREATE TABLE setting (title TEXT NOT NULL DEFAULT \'\')').run();
	await env.db.prepare('INSERT INTO setting (title) VALUES (\'Cloud Mail\')').run();
	await env.db.prepare('CREATE TABLE account (account_id INTEGER PRIMARY KEY, email TEXT NOT NULL)').run();
	await env.db.prepare('CREATE TABLE perm (perm_id INTEGER PRIMARY KEY, name TEXT NOT NULL, perm_key TEXT, pid INTEGER NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 2, sort REAL)').run();
	await env.db.prepare('INSERT INTO account (account_id, email) VALUES (1, \'existing@example.com\')').run();
}

describe('mailing-list v3.7 initialization', () => {
	beforeEach(resetSchema);

	it('creates storage and defaults repeatably without changing existing data', async () => {
		await dbInit.v3_7DB(c);
		await dbInit.v3_7DB(c);

		const tables = await env.db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name LIKE \'mailing_list%\' ORDER BY name').all();
		const settings = await env.db.prepare('SELECT mailing_list_member_limit, mailing_list_daily_post_limit, mailing_list_report_retention_days FROM setting').first();
		const account = await env.db.prepare('SELECT email FROM account WHERE account_id = 1').first();

		expect(tables.results.map(row => row.name)).toEqual(['mailing_list', 'mailing_list_daily_quota', 'mailing_list_delivery', 'mailing_list_delivery_attempt', 'mailing_list_member', 'mailing_list_post', 'mailing_list_rejection', 'mailing_list_sender']);
		expect(settings).toMatchObject({mailing_list_member_limit: 500, mailing_list_daily_post_limit: 100, mailing_list_report_retention_days: 30});
		expect(account.email).toBe('existing@example.com');
	});
});
