import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import account from '../src/entity/account';
import orm from '../src/entity/orm';
import accountService from '../src/service/account-service';
import { and, eq } from 'drizzle-orm';

const c = { env };

async function ensureAccountSchema() {
	await env.db.prepare(`
		CREATE TABLE IF NOT EXISTS user (
			user_id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL,
			type INTEGER DEFAULT 1 NOT NULL,
			password TEXT NOT NULL,
			salt TEXT NOT NULL,
			status INTEGER DEFAULT 0 NOT NULL,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
			active_time DATETIME,
			is_del INTEGER DEFAULT 0 NOT NULL
		)
	`).run();
	await env.db.prepare(`
		CREATE TABLE IF NOT EXISTS account (
			account_id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL,
			name TEXT NOT NULL DEFAULT '',
			status INTEGER DEFAULT 0 NOT NULL,
			latest_email_time DATETIME,
			signature TEXT,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
			user_id INTEGER NOT NULL,
			all_receive INTEGER NOT NULL DEFAULT 0,
			sort INTEGER NOT NULL DEFAULT 0,
			is_del INTEGER DEFAULT 0 NOT NULL
		)
	`).run();
	try {
		await env.db.prepare('ALTER TABLE account ADD COLUMN signature TEXT').run();
	} catch (_) {
		// Existing local test databases may already have this column.
	}
}

async function resetAccountTable() {
	await ensureAccountSchema();
	await env.db.prepare('DELETE FROM account').run();
	await env.db.prepare('DELETE FROM user').run();
}

async function insertAccount(email, userId) {
	return orm(c).insert(account).values({
		email,
		name: email.split('@')[0],
		userId,
	}).returning().get();
}

async function insertUser(email, userId) {
	await env.db.prepare(`
		INSERT INTO user (user_id, email, password, salt)
		VALUES (?, ?, 'password', 'salt')
	`).bind(userId, email).run();
}

describe('account signatures', () => {
	beforeEach(async () => {
		await resetAccountTable();
	});

	it('saves sanitized rich-text signatures on owned accounts', async () => {
		const row = await insertAccount('owner@example.com', 101);

		await accountService.setSignature(c, {
			accountId: row.accountId,
			signature: '<p>Jin</p><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(2)">site</a>',
		}, 101);

		const saved = await orm(c).select().from(account).where(eq(account.accountId, row.accountId)).get();
		expect(saved.signature).toContain('<p>Jin</p>');
		expect(saved.signature).not.toContain('<script');
		expect(saved.signature).not.toContain('javascript:');
		expect(saved.signature).not.toContain('onclick');
	});

	it('clears signatures to null and rejects non-owned account updates', async () => {
		const ownerRow = await insertAccount('owner@example.com', 201);
		const otherRow = await insertAccount('other@example.com', 202);

		await accountService.setSignature(c, {
			accountId: ownerRow.accountId,
			signature: '<p>Owner</p>',
		}, 201);
		await accountService.setSignature(c, {
			accountId: ownerRow.accountId,
			signature: '',
		}, 201);

		const cleared = await orm(c).select().from(account).where(eq(account.accountId, ownerRow.accountId)).get();
		expect(cleared.signature).toBeNull();

		await accountService.setSignature(c, {
			accountId: otherRow.accountId,
			signature: '<p>Changed</p>',
		}, 201);

		const unchanged = await orm(c).select().from(account).where(and(
			eq(account.accountId, otherRow.accountId),
			eq(account.userId, 202),
		)).get();
		expect(unchanged.signature).toBeNull();
	});

	it("keeps safe signature images while removing unsafe image payloads", async () => {
		const row = await insertAccount("images@example.com", 250);

		await accountService.setSignature(c, {
			accountId: row.accountId,
			signature: `<p><img src=\"https://example.com/logo.png\" alt=\"Logo\" onerror=\"alert(1)\"><img src=\"data:image/png;base64,AAAA\"><img src=\"data:image/svg+xml;base64,PHN2Zy8+\"><img src=\"javascript:alert(1)\"></p>`,
		}, 250);

		const saved = await orm(c).select().from(account).where(eq(account.accountId, row.accountId)).get();
		expect(saved.signature).toContain("src=\"https://example.com/logo.png\"");
		expect(saved.signature).toContain("src=\"data:image/png;base64,AAAA\"");
		expect(saved.signature).not.toContain("onerror");
		expect(saved.signature).not.toContain("image/svg+xml");
		expect(saved.signature).not.toContain("javascript:");
	});

	it("includes signatures in owned account lists and omits them from user-management account lists", async () => {
		await insertUser("owner@example.com", 301);
		const mainRow = await insertAccount("owner@example.com", 301);
		const aliasRow = await insertAccount("alias@example.com", 301);

		await accountService.setSignature(c, {
			accountId: aliasRow.accountId,
			signature: "<p>Alias</p>",
		}, 301);

		const ownedList = await accountService.list(c, { accountId: 0, size: 30, lastSort: null }, 301);
		const ownedAlias = ownedList.find(row => row.accountId === aliasRow.accountId);
		expect(ownedAlias.signature).toBe("<p>Alias</p>");

		const { list } = await accountService.allAccount(c, { userId: 301, num: 1, size: 30 });
		const adminAlias = list.find(row => row.accountId === aliasRow.accountId);
		expect(adminAlias).toBeDefined();
		expect(adminAlias.signature).toBeUndefined();
		expect(list.some(row => row.accountId === mainRow.accountId)).toBe(false);
	});
});
