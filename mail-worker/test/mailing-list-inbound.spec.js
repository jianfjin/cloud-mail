import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {dbInit} from '../src/init/init';
import mailingListInboundService from '../src/service/mailing-list-inbound-service';

let sourceObjects;
let queue;
let c;

beforeEach(async () => {
	sourceObjects = new Map();
	queue = {sendBatch: vi.fn(async messages => messages)};
	c = {
		env: {
			...env,
			r2: {
				put: vi.fn(async (key, value) => sourceObjects.set(key, value)),
				delete: vi.fn(async key => sourceObjects.delete(key)),
			},
			mailingListQueue: queue,
		},
	};
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
			raw: 'From: Sender <sender@example.com>\r\n\r\nPrivate source',
		});
		const repeated = await mailingListInboundService.accept(c, {
			to: 'team@example.com',
			sender: 'sender@example.com',
			fingerprint: 'message-1',
			raw: 'From: Sender <sender@example.com>\r\n\r\nPrivate source',
		});
		const deliveries = await env.db.prepare('SELECT email, state, safe_reason FROM mailing_list_delivery ORDER BY delivery_id').all();

		expect(accepted.accepted).toBe(true);
		expect(repeated.postId).toBe(accepted.postId);
		expect(deliveries.results).toEqual([
			{email: 'sender@example.com', state: 'skipped', safe_reason: 'Self delivery disabled'},
			{email: 'member@outside.test', state: 'queued', safe_reason: ''},
		]);
		expect(queue.sendBatch).toHaveBeenCalledTimes(1);
		expect(queue.sendBatch.mock.calls[0][0]).toEqual([
			expect.objectContaining({
				body: expect.objectContaining({
					postId: accepted.postId,
					deliveryId: expect.any(Number),
					dispatchToken: expect.any(String),
				}),
			}),
		]);
		expect(JSON.stringify(queue.sendBatch.mock.calls[0][0])).not.toContain('Private source');
		const post = await env.db.prepare('SELECT source_r2_key FROM mailing_list_post WHERE post_id = ?').bind(accepted.postId).first();
		expect(post.source_r2_key).toMatch(/^mailing-list\//);
		expect(sourceObjects.get(post.source_r2_key)).toContain('Private source');
	});

	it('rejects a non-member before creating a post', async () => {
		await expect(mailingListInboundService.accept(c, {to: 'team@example.com', sender: 'blocked@example.com', fingerprint: 'message-2'})).rejects.toThrow('not authorized');
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_post').first()).count).toBe(0);
	});

	it('applies sender allowlists case-insensitively', async () => {
		await env.db.prepare('UPDATE mailing_list SET posting_policy = ? WHERE list_id = 1').bind('allowlist').run();
		await env.db.prepare('INSERT INTO mailing_list_sender (list_id, email, email_normalized) VALUES (1, ?, ?)').bind('Allowed@Example.com', 'allowed@example.com').run();

		await expect(mailingListInboundService.accept(c, {
			to: 'team@example.com',
			sender: 'blocked@example.com',
			fingerprint: 'message-allowlist-blocked',
			raw: 'From: Blocked <blocked@example.com>\r\n\r\nBlocked',
		})).rejects.toThrow('not authorized');
		await expect(mailingListInboundService.accept(c, {
			to: 'team@example.com',
			sender: 'ALLOWED@example.com',
			fingerprint: 'message-allowlist-accepted',
			raw: 'From: Allowed <allowed@example.com>\r\n\r\nAccepted',
		})).resolves.toMatchObject({accepted: true});
	});

	it('rejects oversized external source MIME before it is stored or queued', async () => {
		await expect(mailingListInboundService.accept(c, {
			to: 'team@example.com',
			sender: 'sender@example.com',
			fingerprint: 'message-too-large',
			raw: 'x'.repeat(5 * 1024 * 1024 + 1),
		})).rejects.toThrow('too large');

		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_post').first()).count).toBe(0);
		expect(sourceObjects.size).toBe(0);
		expect(queue.sendBatch).not.toHaveBeenCalled();
	});

	it('removes the private snapshot when queueing cannot start', async () => {
		queue.sendBatch.mockRejectedValueOnce(new Error('Queue unavailable'));

		await expect(mailingListInboundService.accept(c, {
			to: 'team@example.com',
			sender: 'sender@example.com',
			fingerprint: 'message-3',
			raw: 'From: Sender <sender@example.com>\r\n\r\nQueue failure source',
		})).rejects.toThrow('delivery unavailable');

		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_post').first()).count).toBe(0);
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_delivery').first()).count).toBe(0);
		expect(sourceObjects.size).toBe(0);
	});
});
