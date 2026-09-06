import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {dbInit} from '../src/init/init';
import mailingListReportService from '../src/service/mailing-list-report-service';

let c;
let queue;
let deletedKeys;

async function seedReport({state = 'enabled'} = {}) {
	await env.db.prepare("INSERT INTO mailing_list (address, address_normalized, display_name, state) VALUES ('team@example.com', 'team@example.com', 'Team', ?)").bind(state).run();
	await env.db.prepare("INSERT INTO mailing_list_post (list_id, source_fingerprint, sender_email, policy_snapshot, source_r2_key, state) VALUES (1, 'source-1', 'sender@example.test', '{}', 'mailing-list/1/1/source.eml', 'accepted')").run();
	await env.db.prepare("INSERT INTO mailing_list_delivery (post_id, email, email_normalized, target_type, state, dispatch_token, safe_reason) VALUES (1, 'delivered@example.net', 'delivered@example.net', 'external', 'delivered', 'old-delivered', ''), (1, 'failed@example.net', 'failed@example.net', 'external', 'failed', 'old-failed', 'Delivery failed')").run();
}

beforeEach(async () => {
	queue = {sendBatch: vi.fn(async messages => messages)};
	deletedKeys = [];
	c = {
		env: {
			...env,
			mailingListQueue: queue,
			r2: {delete: vi.fn(async key => deletedKeys.push(key))},
		},
	};
	for (const table of ['mailing_list_delivery_attempt', 'mailing_list_delivery', 'mailing_list_post', 'mailing_list_daily_quota', 'mailing_list_sender', 'mailing_list_member', 'mailing_list', 'setting', 'perm']) {
		await env.db.prepare('DROP TABLE IF EXISTS ' + table).run();
	}
	await env.db.prepare("CREATE TABLE setting (title TEXT NOT NULL DEFAULT '')").run();
	await env.db.prepare("INSERT INTO setting (title) VALUES ('Cloud Mail')").run();
	await env.db.prepare('CREATE TABLE perm (perm_id INTEGER PRIMARY KEY, name TEXT NOT NULL, perm_key TEXT, pid INTEGER, type INTEGER, sort REAL)').run();
	await dbInit.v3_7DB(c);
});

describe('mailing-list reports and retry', () => {
	it('returns safe report metadata and failed-only outcomes without source or recipient data', async () => {
		await seedReport();
		const report = await mailingListReportService.report(c, 1, 1);

		expect(report).toMatchObject({
			postId: 1,
			list: {listId: 1, address: 'team@example.com', displayName: 'Team'},
			sender: 'sender@example.test',
			totals: {delivered: 1, failed: 1, queued: 0, processing: 0, pending: 0, skipped: 0},
			outcomes: [
				{deliveryId: 1, state: 'delivered', safeReason: ''},
				{deliveryId: 2, state: 'failed', safeReason: 'Delivery failed'},
			],
		});
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain('mailing-list/1/1/source.eml');
		expect(serialized).not.toContain('delivered@example.net');
		expect(serialized).not.toContain('failed@example.net');
	});

	it('returns list report summaries without loading every recipient outcome', async () => {
		await seedReport();

		const reports = await mailingListReportService.reports(c, 1);

		expect(reports).toEqual([
			expect.objectContaining({
				postId: 1,
				totals: {delivered: 1, failed: 1, queued: 0, processing: 0, pending: 0, skipped: 0},
			}),
		]);
		expect(reports[0]).not.toHaveProperty('outcomes');
	});

	it('requeues only failed recipients once and refuses retries while the list is disabled', async () => {
		await seedReport();
		const retry = await mailingListReportService.retry(c, 1, 1);
		const repeated = await mailingListReportService.retry(c, 1, 1);
		const states = await env.db.prepare('SELECT delivery_id, state, dispatch_token FROM mailing_list_delivery ORDER BY delivery_id').all();

		expect(retry).toEqual({requeued: 1});
		expect(repeated).toEqual({requeued: 0});
		expect(queue.sendBatch).toHaveBeenCalledWith([
			{body: {postId: 1, deliveryId: 2, dispatchToken: expect.any(String)}},
		]);
		expect(states.results[0]).toMatchObject({delivery_id: 1, state: 'delivered', dispatch_token: 'old-delivered'});
		expect(states.results[1]).toMatchObject({delivery_id: 2, state: 'queued'});
		expect(states.results[1].dispatch_token).not.toBe('old-failed');

		await env.db.prepare("UPDATE mailing_list SET state = 'disabled' WHERE list_id = 1").run();
		await env.db.prepare("UPDATE mailing_list_delivery SET state = 'failed' WHERE delivery_id = 2").run();
		await expect(mailingListReportService.retry(c, 1, 1)).rejects.toThrow('not enabled');
	});

	it('keeps concurrent retry requests idempotent per failed recipient', async () => {
		await seedReport();
		const retries = await Promise.all([
			mailingListReportService.retry(c, 1, 1),
			mailingListReportService.retry(c, 1, 1),
		]);

		expect(retries[0].requeued + retries[1].requeued).toBe(1);
		expect(queue.sendBatch).toHaveBeenCalledTimes(1);
	});

	it('removes expired reports and their private source while preserving the reserved list identity', async () => {
		await seedReport();
		await env.db.prepare("UPDATE mailing_list_post SET create_time = '2026-08-01 00:00:00' WHERE post_id = 1").run();
		await env.db.prepare("INSERT INTO mailing_list_rejection (list_id, sender_email, safe_reason, create_time) VALUES (1, 'blocked@example.net', 'Sender is not authorized to post to this list', '2026-08-01 00:00:00')").run();

		const result = await mailingListReportService.cleanup(c, new Date('2026-09-05T00:00:00Z'));
		expect(result).toEqual({removed: 1, failed: 0});
		expect(deletedKeys).toEqual(['mailing-list/1/1/source.eml']);
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list').first()).count).toBe(1);
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_post').first()).count).toBe(0);
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_delivery').first()).count).toBe(0);
		expect((await env.db.prepare('SELECT count(*) AS count FROM mailing_list_rejection').first()).count).toBe(0);

		await env.db.prepare("INSERT INTO mailing_list_post (list_id, source_fingerprint, sender_email, policy_snapshot, source_r2_key, state, create_time) VALUES (1, 'source-2', 'sender@example.test', '{}', 'mailing-list/1/2/source.eml', 'accepted', '2026-08-01 00:00:00')").run();
		c.env.r2.delete.mockRejectedValueOnce(new Error('R2 unavailable'));
		await expect(mailingListReportService.cleanup(c, new Date('2026-09-05T00:00:00Z'))).resolves.toEqual({removed: 0, failed: 1});
		expect((await env.db.prepare('SELECT state FROM mailing_list_post WHERE post_id = 2').first()).state).toBe('cleanup_failed');
	});
});
