import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {dbInit} from '../src/init/init';
import app from '../src/hono/webs';
import {permKeyToPaths} from '../src/security/security';
import jwtUtils from '../src/utils/jwt-utils';
import KvConst from '../src/const/kv-const';

const c = {env};

async function authorizationHeader(userId, email) {
	const sessionToken = 'mailing-list-session-' + userId;
	const token = await jwtUtils.generateToken(c, {userId, token: sessionToken});
	await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({
		tokens: [sessionToken],
		user: {userId, email},
		refreshTime: new Date().toISOString(),
	}));
	return {Authorization: token};
}

beforeEach(async () => {
	for (const table of ['role_perm', 'role', 'user', 'mailing_list', 'setting', 'perm']) {
		await env.db.prepare('DROP TABLE IF EXISTS ' + table).run();
	}
	await env.db.prepare("CREATE TABLE setting (title TEXT NOT NULL DEFAULT '')").run();
	await env.db.prepare("INSERT INTO setting (title) VALUES ('Cloud Mail')").run();
	await env.db.prepare('CREATE TABLE perm (perm_id INTEGER PRIMARY KEY, name TEXT NOT NULL, perm_key TEXT, pid INTEGER, type INTEGER, sort REAL)').run();
	await env.db.prepare('CREATE TABLE user (user_id INTEGER PRIMARY KEY, type INTEGER NOT NULL, email TEXT NOT NULL)').run();
	await env.db.prepare('CREATE TABLE role (role_id INTEGER PRIMARY KEY)').run();
	await env.db.prepare('CREATE TABLE role_perm (role_id INTEGER NOT NULL, perm_id INTEGER NOT NULL)').run();
	await dbInit.v3_7DB(c);
});

describe('mailing-list permission routes', () => {
	it('maps management and report endpoints to the dedicated permission', () => {
		const paths = permKeyToPaths(['mailing-list:manage']);
		expect(paths).toContain('/mailingList/');
	});

	it('enforces the management permission on the list API', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await env.db.prepare("INSERT INTO user (user_id, type, email) VALUES (1, 1, 'member@example.com'), (2, 2, 'manager@example.com')").run();
		await env.db.prepare('INSERT INTO role (role_id) VALUES (1), (2)').run();
		await env.db.prepare(
			"INSERT INTO role_perm (role_id, perm_id) SELECT 2, perm_id FROM perm WHERE perm_key = 'mailing-list:manage'",
		).run();

		const forbidden = await app.request('/mailingList/list', {headers: await authorizationHeader(1, 'member@example.com')}, env);
		const allowed = await app.request('/mailingList/list', {headers: await authorizationHeader(2, 'manager@example.com')}, env);

		expect((await forbidden.json()).code).toBe(403);
		expect((await allowed.json()).code).toBe(200);
		log.mockRestore();
	});
});
