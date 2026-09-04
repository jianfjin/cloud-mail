import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it} from 'vitest';
import {dbInit} from '../src/init/init';
import mailingListService from '../src/service/mailing-list-service';

const c = {env: {...env, domain: ['example.com']}};

beforeEach(async () => {
	for (const table of ['mailing_list_member', 'mailing_list', 'setting', 'account', 'perm']) {
		await env.db.prepare('DROP TABLE IF EXISTS ' + table).run();
	}
	await env.db.prepare('CREATE TABLE setting (title TEXT NOT NULL DEFAULT \'\')').run();
	await env.db.prepare('INSERT INTO setting (title) VALUES (\'Cloud Mail\')').run();
	await env.db.prepare('CREATE TABLE account (account_id INTEGER PRIMARY KEY, email TEXT NOT NULL)').run();
	await env.db.prepare('CREATE TABLE perm (perm_id INTEGER PRIMARY KEY, name TEXT NOT NULL, perm_key TEXT, pid INTEGER, type INTEGER, sort REAL)').run();
	await dbInit.v3_7DB(c);
});

describe('mailing-list administration', () => {
	it('creates an owned-domain list and rejects mailbox/address collisions', async () => {
		const created = await mailingListService.create(c, {address: 'Team@Example.com', displayName: 'Team'});
		expect(created.address).toBe('Team@Example.com');

		await expect(mailingListService.create(c, {address: 'team@example.com', displayName: 'Duplicate'})).rejects.toThrow();
		await env.db.prepare('INSERT INTO account (account_id, email) VALUES (1, \'box@example.com\')').run();
		await expect(mailingListService.create(c, {address: 'BOX@example.com', displayName: 'Mailbox'})).rejects.toThrow();
	});
});
