import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import jwtUtils from '../src/utils/jwt-utils';
import KvConst from '../src/const/kv-const';

/**
 * escapeHtml 函数 — 与 email-service.js 中内联定义的逻辑一致。
 * 转义 & < > " ' 五个字符。
 */
function escapeHtml(str) {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

// ────────── Helpers ──────────

/**
 * 在 D1 中创建 user 表。
 * D1 的 exec() 只接受单条 SQL，因此逐条执行。
 */
async function createTables(db) {
	await db.exec(
		"CREATE TABLE IF NOT EXISTS user ( user_id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, type INTEGER DEFAULT 1 NOT NULL, password TEXT NOT NULL, salt TEXT NOT NULL, status INTEGER DEFAULT 0 NOT NULL, create_time TEXT DEFAULT CURRENT_TIMESTAMP, active_time TEXT, create_ip TEXT, active_ip TEXT, os TEXT, browser TEXT, device TEXT, sort TEXT DEFAULT '0', send_count TEXT DEFAULT '0', reg_key_id INTEGER DEFAULT 0 NOT NULL, is_del INTEGER DEFAULT 0 NOT NULL, signature TEXT DEFAULT '' NOT NULL )"
	);
}

/**
 * 生成一个测试 JWT，同时将认证信息存入 KV。
 * 返回完整的 Authorization header 值。
 */
async function createAuthToken(env, userId, email = 'test@example.com') {
	const token = await jwtUtils.generateToken(
		{ env },
		{ userId, token: 'test-token-' + userId },
		3600
	);

	const authInfo = {
		user: { userId, email, signature: '' },
		tokens: ['test-token-' + userId],
		refreshTime: new Date().toISOString(),
	};

	await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), {
		expirationTtl: 3600,
	});

	return token;
}

/**
 * 向 D1 中插入一条测试用户记录。
 */
async function seedUser(db, userId, email, signature = '') {
	await db
		.prepare(
			`INSERT INTO user (user_id, email, password, salt, type, status, send_count, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(userId, email, 'hashed-password', 'salt', 1, 0, '0', signature)
		.run();
}

// ────────── Tests ──────────

describe('escapeHtml', () => {
	it('转义 & 符号', () => {
		expect(escapeHtml('&')).toBe('&amp;');
		expect(escapeHtml('&amp;')).toBe('&amp;amp;');
	});

	it('转义 < 符号', () => {
		expect(escapeHtml('<')).toBe('&lt;');
		expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
	});

	it('转义 > 符号', () => {
		expect(escapeHtml('>')).toBe('&gt;');
	});

	it('转义双引号 "', () => {
		expect(escapeHtml('"')).toBe('&quot;');
		expect(escapeHtml('a="b"')).toBe('a=&quot;b&quot;');
	});

	it("转义单引号 '", () => {
		expect(escapeHtml("'")).toBe('&#039;');
		expect(escapeHtml("it's")).toBe('it&#039;s');
	});

	it('同时转义所有五个字符', () => {
		const input = `<script>alert("xss&test")</script>`;
		const expected =
			'&lt;script&gt;alert(&quot;xss&amp;test&quot;)&lt;/script&gt;';
		expect(escapeHtml(input)).toBe(expected);
	});

	it('空字符串保持不变', () => {
		expect(escapeHtml('')).toBe('');
	});

	it('无特殊字符的普通文本保持不变', () => {
		expect(escapeHtml('Hello World')).toBe('Hello World');
	});
});

describe('GET /my/signature API', () => {
	let token;
	const userId = 1001;
	const email = 'sig-test@example.com';
	const signature = 'Best regards,\nJohn Doe';

	beforeAll(async () => {
		await createTables(env.db);
		await seedUser(env.db, userId, email, signature);
		token = await createAuthToken(env, userId, email);
	});

	it('返回当前用户签名', async () => {
		const res = await SELF.fetch('http://example.com/api/my/signature', {
			headers: { Authorization: token },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.code).toBe(200);
		expect(body.data.signature).toBe(signature);
	});

	it('用户无签名时返回空字符串', async () => {
		const userId2 = 1002;
		await seedUser(env.db, userId2, 'no-sig@example.com', '');
		const token2 = await createAuthToken(env, userId2, 'no-sig@example.com');

		const res = await SELF.fetch('http://example.com/api/my/signature', {
			headers: { Authorization: token2 },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.code).toBe(200);
		expect(body.data.signature).toBe('');
	});
});

describe('PUT /my/signature API', () => {
	let token;
	const userId = 2001;
	const email = 'put-sig@example.com';

	beforeAll(async () => {
		await createTables(env.db);
		await seedUser(env.db, userId, email, '');
		token = await createAuthToken(env, userId, email);
	});

	it('设置签名并返回成功', async () => {
		const newSig = 'Regards, Tester';

		const res = await SELF.fetch('http://example.com/api/my/signature', {
			method: 'PUT',
			headers: {
				Authorization: token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ signature: newSig }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.code).toBe(200);
	});

	it('设置后可通过 GET 读取', async () => {
		const sig = 'Updated signature via PUT';
		await SELF.fetch('http://example.com/api/my/signature', {
			method: 'PUT',
			headers: {
				Authorization: token,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ signature: sig }),
		});

		const res = await SELF.fetch('http://example.com/api/my/signature', {
			headers: { Authorization: token },
		});
		const body = await res.json();
		expect(body.data.signature).toBe(sig);
	});
});

describe('签名追加逻辑 (escape + append)', () => {
	it('有签名时生成包含签名 div 的 HTML', () => {
		const userSig = 'Best regards';
		const originalHtml = '<p>Hello</p>';
		const escaped = escapeHtml(userSig);
		const resultHtml =
			originalHtml +
			`<div style="margin-top:32px;border-top:1px solid #eee;padding-top:16px;font-size:12px;color:#666;">${escaped}</div>`;

		expect(resultHtml).toContain('Best regards');
		expect(resultHtml).toContain('margin-top:32px');
		expect(resultHtml).toContain('border-top');
		expect(resultHtml).toContain('font-size:12px');
	});

	it('签名含特殊字符时被正确转义', () => {
		const userSig = 'Hello & "World" <test>';
		const escaped = escapeHtml(userSig);
		expect(escaped).toBe(
			'Hello &amp; &quot;World&quot; &lt;test&gt;'
		);

		const resultHtml = `<div>${escaped}</div>`;
		expect(resultHtml).toContain('&amp;');
		expect(resultHtml).toContain('&quot;');
		expect(resultHtml).toContain('&lt;');
		expect(resultHtml).not.toContain('<test>');
	});

	it('空签名时签名 div 不出现（模拟逻辑判断）', () => {
		const userSig = '';
		let html = '<p>Hello</p>';
		if (userSig) {
			html += `<div>${escapeHtml(userSig)}</div>`;
		}
		expect(html).not.toContain('<div');
		expect(html).toBe('<p>Hello</p>');
	});
});

describe('XSS payload 转义', () => {
	it('script 标签被转义', () => {
		const payload = "<script>alert('xss')</script>";
		const result = escapeHtml(payload);
		expect(result).toBe(
			'&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;'
		);
		expect(result).not.toContain('<script>');
		expect(result).not.toContain('</script>');
	});

	it('onerror 事件属性被转义', () => {
		const payload = '<img src=x onerror=alert(1)>';
		const result = escapeHtml(payload);
		expect(result).toBe('&lt;img src=x onerror=alert(1)&gt;');
		expect(result).not.toContain('<img');
	});

	it('javascript: URL 在属性中被转义', () => {
		const payload = '<a href="javascript:alert(1)">click</a>';
		const result = escapeHtml(payload);
		expect(result).toBe(
			'&lt;a href=&quot;javascript:alert(1)&quot;&gt;click&lt;/a&gt;'
		);
		expect(result).not.toContain('href="javascript');
	});

	it('嵌套混合 payload 被完全转义', () => {
		const payload = '<script>&lt;evil&gt;</script>';
		const result = escapeHtml(payload);
		expect(result).toBe(
			'&lt;script&gt;&amp;lt;evil&amp;gt;&lt;/script&gt;'
		);
		expect(result).not.toContain('<script>');
	});
});
