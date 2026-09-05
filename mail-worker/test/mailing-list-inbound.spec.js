import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it} from 'vitest';
import {dbInit} from '../src/init/init';
import mailingListInboundService from '../src/service/mailing-list-inbound-service';

const c = {env};

beforeEach(async () => {
	for (const table of ['mailing_list_delivery_attempt', 'mailing_list_delivery', 'mailing_list_post', 'mailing_list_daily_quota', 'mailing_list_sender', 'mailing_list_member', 'mailing_list', 'setting', 'perm']) {
		await env.db.prepare('DROP TABLE IF EXISTS ' + table).run();
	}
	await env.db.prepare('CREATE TABLE setting (title TEXT NOT NULL DEFAULT \'\')').run();
	await env.db.prepare('INSERT INTO setting (title) VALUES (\'Cloud Mail\')').run();
	await env.db.prepare('CREATE TABLE perm (perm_id INTEGER PRIMARY KEY, name TEXT NOT NULL, perm_key TEXT, pid INTEGER, type INTEGER, sort REAL)').run();
	await dbInit.v3_7DB(c);
	await env.db.prepare('INSERT INTO mailing_list (address, address_normalized, display_name) VALUES (\'team@example.com\', \'team@example.com\', \'Team\')').run();
	await env.db.prepare('INSERT INTO mailing_list_member (list_id, email, email_normalized) VALUES (1, \'sender@example.com\', \'sender@example.com\'), (1, \'member@outside.test\', \'member@outside.test\')').run();
});

describe('mailing-list inbound acceptance', () => {
	it('snapshots a members-only post once and does not expose a sender copy when disabled', async () => {
		await env.db.prepare('UPDATE mailing_list SET self_delivery = 0 WHERE list_id = 1').run();
		const accepted = await mailingListInboundService.accept(c, {
			to: 'TEAM@example.com',
			sender: 'Sender@Example.com',
			fingerprint: 'message-1',
		});
		const repeated = await mailingListInboundService.accept(c, {
			to: 'team@example.com',
			sender: 'sender@example.com',
			fingerprint: 'message-1',
		});
		const deliveries = await env.db.prepare('SELECT email, state FROM mailing_list_delivery ORDER BY delivery_id').all();

		expect(accepted.accepted).toBe(true);
		expect(repeated.postId).toBe(accepted.postId);
		expect(deliveries.results).toEqual([{email: 'member@outside.test', state: 'pending'}]);
	});

	it('rejects a non-member before creating a post', async () => {
		await expect(mailingListInboundService.accept(c, {to: 'team@example.com', sender: 'blocked@example.com', fingerprint: 'message-2'})).rejects.toThrow('not authorized');
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_post').first()).count).toBe(0);
	});
});
