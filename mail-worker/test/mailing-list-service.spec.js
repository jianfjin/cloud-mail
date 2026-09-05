import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it} from 'vitest';
import {dbInit} from '../src/init/init';
import mailingListService from '../src/service/mailing-list-service';

const c = {env: {...env, domain: ['example.com']}};

beforeEach(async () => {
	for (const table of ['mailing_list_sender', 'mailing_list_member', 'mailing_list', 'setting', 'account', 'perm']) {
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

	it('adds normalized direct members up to the effective cap and preserves retired addresses', async () => {
		const list = await mailingListService.create(c, {address: 'team@example.com', displayName: 'Team', memberLimit: 1});
		await mailingListService.addMember(c, list.list_id, 'Member@outside.test');
		await expect(mailingListService.addMember(c, list.list_id, 'member@outside.test')).rejects.toThrow();
		await expect(mailingListService.addMember(c, list.list_id, 'other@outside.test')).rejects.toThrow();

		await mailingListService.retire(c, list.list_id);
		await expect(mailingListService.create(c, {address: 'TEAM@example.com', displayName: 'Replacement'})).rejects.toThrow();
		await mailingListService.restore(c, list.list_id);
		expect((await mailingListService.detail(c, list.list_id)).state).toBe('enabled');
	});

	it('updates policy and limit settings, exposes effective values, and manages normalized senders', async () => {
		const list = await mailingListService.create(c, {address: 'team@example.com', displayName: 'Team'});
		const updated = await mailingListService.update(c, list.list_id, {
			postingPolicy: 'allowlist',
			replyPolicy: 'list',
			selfDelivery: false,
			memberLimit: 12,
			dailyPostLimit: 7,
		});

		expect(updated).toMatchObject({
			posting_policy: 'allowlist',
			reply_policy: 'list',
			self_delivery: 0,
			effectiveMemberLimit: 12,
			effectiveDailyPostLimit: 7,
		});
		await expect(mailingListService.update(c, list.list_id, {address: 'renamed@example.com'})).rejects.toThrow('immutable');

		await mailingListService.addSender(c, list.list_id, 'Allowed@Example.com');
		await expect(mailingListService.addSender(c, list.list_id, 'allowed@example.com')).rejects.toThrow('already exists');
		expect(await mailingListService.senders(c, list.list_id)).toMatchObject([
			{email: 'Allowed@Example.com', email_normalized: 'allowed@example.com'},
		]);
		const sender = (await mailingListService.senders(c, list.list_id))[0];
		await mailingListService.removeSender(c, list.list_id, sender.sender_id);
		await expect(mailingListService.senders(c, list.list_id)).resolves.toEqual([]);
	});
});
