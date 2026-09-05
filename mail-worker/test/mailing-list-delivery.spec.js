import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import PostalMime from 'postal-mime';
import {dbInit} from '../src/init/init';
import mailingListDeliveryService from '../src/service/mailing-list-delivery-service';

let c;
let sourceObjects;

async function seedDelivery({targetType = 'external', dispatchToken = 'dispatch-1'} = {}) {
	await env.db.prepare("INSERT INTO mailing_list (address, address_normalized, display_name) VALUES ('team@example.com', 'team@example.com', 'Team')").run();
	await env.db.prepare("INSERT INTO mailing_list_post (list_id, source_fingerprint, sender_email, policy_snapshot, source_r2_key, state) VALUES (1, 'source-1', 'sender@example.test', ?, 'mailing-list/1/1/source.eml', 'accepted')")
		.bind(JSON.stringify({replyPolicy: 'sender'})).run();
	await env.db.prepare("INSERT INTO mailing_list_delivery (post_id, email, email_normalized, target_type, state, dispatch_token) VALUES (1, 'member@example.net', 'member@example.net', ?, 'queued', ?)")
		.bind(targetType, dispatchToken).run();
	sourceObjects.set('mailing-list/1/1/source.eml', [
		'From: Original Sender <sender@example.test>',
		'To: team@example.com',
		'Subject: Private list post',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="outer"',
		'',
		'--outer',
		'Content-Type: multipart/alternative; boundary="inner"',
		'',
		'--inner',
		'Content-Type: text/plain; charset=UTF-8',
		'',
		'Plain body',
		'--inner',
		'Content-Type: text/html; charset=UTF-8',
		'',
		'<p>HTML body</p>',
		'--inner--',
		'--outer',
		'Content-Type: text/plain; name="notes.txt"',
		'Content-Transfer-Encoding: base64',
		'Content-Disposition: attachment; filename="notes.txt"',
		'',
		'bm90ZXM=',
		'--outer--',
		'',
	].join('\r\n'));
}

beforeEach(async () => {
	sourceObjects = new Map();
	c = {
		env: {
			...env,
			r2: {
				get: vi.fn(async key => sourceObjects.has(key) ? {text: async () => sourceObjects.get(key)} : null),
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
});

describe('mailing-list queue delivery', () => {
	it('renders one privacy-safe external MIME copy and records a delivered attempt', async () => {
		await seedDelivery();
		const external = vi.fn().mockResolvedValue();

		const result = await mailingListDeliveryService.deliver(c, {postId: 1, deliveryId: 1, dispatchToken: 'dispatch-1'}, {external});
		const delivery = await env.db.prepare('SELECT state, safe_reason FROM mailing_list_delivery WHERE delivery_id = 1').first();
		const attempt = await env.db.prepare('SELECT attempt_number, trigger_type, state, safe_reason FROM mailing_list_delivery_attempt WHERE delivery_id = 1').first();
		const raw = external.mock.calls[0][0].raw;
		const rendered = await PostalMime.parse(raw);

		expect(result).toEqual({delivered: true, deliveryId: 1});
		expect(external).toHaveBeenCalledTimes(1);
		expect(raw).toContain('From: Original Sender via Team <team@example.com>');
		expect(raw).toContain('To: team@example.com');
		expect(raw).toContain('Reply-To: sender@example.test');
		expect(raw).toContain('X-Cloud-Mail-Original-From: sender@example.test');
		expect(rendered.text.trim()).toBe('Plain body');
		expect(rendered.html.trim()).toBe('<p>HTML body</p>');
		expect(new TextDecoder().decode(rendered.attachments[0].content)).toBe('notes');
		expect(raw).toContain('filename="notes.txt"');
		expect(raw).not.toContain('member@example.net');
		expect(delivery).toEqual({state: 'delivered', safe_reason: ''});
		expect(attempt).toEqual({attempt_number: 1, trigger_type: 'queue', state: 'delivered', safe_reason: ''});
	});

	it('claims each queued delivery once even when the queue submits it twice', async () => {
		await seedDelivery();
		const external = vi.fn().mockResolvedValue();

		await mailingListDeliveryService.deliver(c, {postId: 1, deliveryId: 1, dispatchToken: 'dispatch-1'}, {external});
		await expect(mailingListDeliveryService.deliver(c, {postId: 1, deliveryId: 1, dispatchToken: 'dispatch-1'}, {external}))
			.resolves.toEqual({delivered: false, deliveryId: 1});
		expect(external).toHaveBeenCalledTimes(1);
	});

	it('uses the focused internal adapter without forwarding or external transport', async () => {
		await seedDelivery({targetType: 'internal'});
		const internal = vi.fn().mockResolvedValue();
		const external = vi.fn();

		await mailingListDeliveryService.deliver(c, {postId: 1, deliveryId: 1, dispatchToken: 'dispatch-1'}, {internal, external});
		expect(internal).toHaveBeenCalledTimes(1);
		expect(external).not.toHaveBeenCalled();
	});

	it('records a safe failed outcome when a provider rejects the member copy', async () => {
		await seedDelivery();
		const external = vi.fn().mockRejectedValue(new Error('provider token secret=not-for-storage'));

		await expect(mailingListDeliveryService.deliver(c, {postId: 1, deliveryId: 1, dispatchToken: 'dispatch-1'}, {external}))
		.resolves.toEqual({delivered: false, deliveryId: 1});
		const delivery = await env.db.prepare('SELECT state, safe_reason FROM mailing_list_delivery WHERE delivery_id = 1').first();
		const attempt = await env.db.prepare('SELECT state, safe_reason FROM mailing_list_delivery_attempt WHERE delivery_id = 1').first();

		expect(delivery).toEqual({state: 'failed', safe_reason: 'Delivery failed'});
		expect(attempt).toEqual({state: 'failed', safe_reason: 'Delivery failed'});
	});
});
