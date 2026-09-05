import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import PostalMime from 'postal-mime';
import {dbInit} from '../src/init/init';
import mailingListDeliveryService from '../src/service/mailing-list-delivery-service';
import mailingListInboundService from '../src/service/mailing-list-inbound-service';
import mailingListReportService from '../src/service/mailing-list-report-service';

let c;
let queue;
let sourceObjects;

beforeEach(async () => {
	queue = {sendBatch: vi.fn(async messages => messages)};
	sourceObjects = new Map();
	c = {
		env: {
			...env,
			mailingListQueue: queue,
			r2: {
				put: vi.fn(async (key, value) => sourceObjects.set(key, value)),
				get: vi.fn(async key => sourceObjects.has(key) ? {text: async () => sourceObjects.get(key)} : null),
				delete: vi.fn(async key => sourceObjects.delete(key)),
			},
		},
	};
	for (const table of ['mailing_list_delivery_attempt', 'mailing_list_delivery', 'mailing_list_post', 'mailing_list_daily_quota', 'mailing_list_sender', 'mailing_list_member', 'mailing_list', 'setting', 'perm']) {
		await env.db.prepare('DROP TABLE IF EXISTS ' + table).run();
	}
	await env.db.prepare("CREATE TABLE setting (title TEXT NOT NULL DEFAULT '')").run();
	await env.db.prepare("INSERT INTO setting (title) VALUES ('Cloud Mail')").run();
	await env.db.prepare('CREATE TABLE perm (perm_id INTEGER PRIMARY KEY, name TEXT NOT NULL, perm_key TEXT, pid INTEGER, type INTEGER, sort REAL)').run();
	await dbInit.v3_7DB(c);
	await env.db.prepare(
		"INSERT INTO mailing_list (address, address_normalized, display_name, posting_policy) VALUES ('team@example.com', 'team@example.com', 'Team', 'public')",
	).run();
	await env.db.prepare(
		"INSERT INTO mailing_list_member (list_id, email, email_normalized) VALUES (1, 'delivered@example.net', 'delivered@example.net'), (1, 'failed@example.net', 'failed@example.net')",
	).run();
});

describe('mailing-list integration', () => {
	it('accepts a private post, retries only its failed member, and expires its operational data', async () => {
		const accepted = await mailingListInboundService.accept(c, {
			to: 'TEAM@example.com',
			sender: 'organizer@example.test',
			fingerprint: 'integration-message-1',
			raw: [
				'From: Test Organizer <organizer@example.test>',
				'To: team@example.com',
				'Subject: Integration list post',
				'Content-Type: text/plain; charset=UTF-8',
				'',
				'Private body',
			].join('\r\n'),
		});
		const firstDispatches = queue.sendBatch.mock.calls[0][0];
		const sent = [];

		for (const dispatch of firstDispatches) {
			await mailingListDeliveryService.deliver(c, dispatch.body, {
				external: async payload => {
					if (payload.delivery.email === 'failed@example.net') throw new Error('forced provider failure');
					sent.push(payload.raw);
				},
			});
		}

		const firstReport = await mailingListReportService.report(c, 1, accepted.postId);
		expect(firstReport.totals).toMatchObject({delivered: 1, failed: 1});
		expect(firstReport.outcomes).toHaveLength(2);
		expect(JSON.stringify(firstReport)).not.toContain('Private body');
		expect(JSON.stringify(firstReport)).not.toContain('failed@example.net');
		const firstCopy = await PostalMime.parse(sent[0]);
		expect(firstCopy.to[0].address).toBe('team@example.com');
		expect(sent[0]).not.toContain('delivered@example.net');
		expect(sent[0]).not.toContain('failed@example.net');

		await expect(mailingListReportService.retry(c, 1, accepted.postId)).resolves.toEqual({requeued: 1});
		const retryDispatch = queue.sendBatch.mock.calls[1][0][0];
		await mailingListDeliveryService.deliver(c, retryDispatch.body, {external: vi.fn().mockResolvedValue()});

		const retriedReport = await mailingListReportService.report(c, 1, accepted.postId);
		expect(retriedReport.totals).toMatchObject({delivered: 2, failed: 0});
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_delivery_attempt').first()).count).toBe(3);

		await env.db.prepare("UPDATE mailing_list_post SET create_time = '2026-08-01 00:00:00' WHERE post_id = ?").bind(accepted.postId).run();
		await expect(mailingListReportService.cleanup(c, new Date('2026-09-05T00:00:00Z'))).resolves.toEqual({removed: 1, failed: 0});
		expect(sourceObjects.size).toBe(0);
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_post').first()).count).toBe(0);
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list').first()).count).toBe(1);
	});
});
