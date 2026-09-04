import { beforeEach, describe, expect, it, vi } from 'vitest';

import r2Service from '../src/service/r2-service';
import worker from '../src/index';

// Regression: attachments downloaded with 0 bytes because the /attachments/*
// route in index.js hardcoded kvObjService (KV) while files are stored in R2
// when storageType() resolves to R2. Downloads must go through r2Service so
// they respect the configured storage backend.

const SETTINGS_KEY = 'setting:';

// settingService.query mutates the settings object (emailPrefixFilter becomes
// an array), so every consumer gets a fresh copy.
function makeSettings() {
	return {
		receive: 0,
		send: 1,
		r2Domain: 'example.com',
		resendTokens: '{}',
		bucket: '',
		region: '',
		endpoint: '',
		s3AccessKey: '',
		s3SecretKey: '',
		forcePathStyle: 1,
		emailPrefixFilter: '',
		noRecipient: 1,
		syncDelete: 1,
	};
}

// KV mock: entries are { value, metadata }; initial entries are raw values.
function makeKv(initial = {}) {
	const store = new Map(Object.entries(initial).map(([k, v]) => [k, { value: v, metadata: null }]));
	return {
		store,
		put: vi.fn(async (key, value, opts) => {
			store.set(key, { value, metadata: opts?.metadata ?? null });
		}),
		get: vi.fn(async (key, opts) => {
			const entry = store.get(key);
			if (!entry) return null;
			let value = entry.value;
			if (opts?.type === 'json' && typeof value === 'string') {
				value = JSON.parse(value);
			}
			return value;
		}),
		getWithMetadata: vi.fn(async (key) => {
			const entry = store.get(key);
			if (!entry) return { value: null, metadata: null };
			return entry;
		}),
		delete: vi.fn(async (key) => {
			store.delete(key);
		}),
	};
}

// R2 mock: initial entries are already { value, metadata } shaped.
function makeR2(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		get: vi.fn(async (key) => {
			const entry = store.get(key);
			if (!entry) return null;
			return {
				body: new Response(entry.value).body,
				httpMetadata: entry.metadata ?? {},
			};
		}),
		put: vi.fn(async (key, value, opts) => {
			store.set(key, { value, metadata: opts?.httpMetadata ?? {} });
		}),
		delete: vi.fn(async (key) => {
			store.delete(key);
		}),
	};
}

const PDF_BYTES = '%PDF-1.4 fake attachment payload';

let env;

beforeEach(() => {
	env = {
		domain: ['example.com'],
	};
	env.kv = makeKv({ [SETTINGS_KEY]: makeSettings() });
});

describe('r2Service.toObjResp', () => {
	it('wraps an R2Object into a Response with body and http metadata', async () => {
		env.r2 = makeR2({
			'attachments/report.pdf': { value: new TextEncoder().encode(PDF_BYTES), metadata: { contentType: 'application/pdf', contentDisposition: 'attachment;filename=report.pdf' } },
		});
		const c = { env };

		const resp = await r2Service.toObjResp(c, 'attachments/report.pdf');

		expect(resp).toBeInstanceOf(Response);
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe(PDF_BYTES);
		expect(resp.headers.get('Content-Type')).toBe('application/pdf');
		expect(resp.headers.get('Content-Disposition')).toContain('report.pdf');
	});

	it('returns 404 when the object exists in no backend', async () => {
		env.r2 = makeR2({});
		const c = { env };

		const resp = await r2Service.toObjResp(c, 'attachments/missing.pdf');

		expect(resp.status).toBe(404);
	});

	it('passes through Response objects returned by the KV backend', async () => {
		delete env.r2; // no R2 binding -> storageType falls back to KV
		const c = { env };

		const resp = await r2Service.toObjResp(c, 'attachments/kv.txt');

		expect(resp).toBeInstanceOf(Response);
		expect(resp.status).toBe(404);
	});
});

describe('worker /attachments/* download route', () => {
	it('serves attachments from R2 when storage type is R2 (regression: 0-byte downloads)', async () => {
		const body = new TextEncoder().encode(PDF_BYTES);
		env.r2 = makeR2({
			'attachments/report.pdf': { value: body, metadata: { contentType: 'application/pdf', contentDisposition: 'attachment;filename=report.pdf' } },
		});

		const req = new Request('http://cloudmail.test/attachments/report.pdf');
		const resp = await worker.fetch(req, env, {});

		// The buggy code returned null from the fetch handler when the key
		// was not in KV, so the browser saved a 0-byte file.
		expect(resp).toBeInstanceOf(Response);
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe(PDF_BYTES);
		expect(resp.headers.get('Content-Disposition')).toContain('report.pdf');
		expect(env.r2.get).toHaveBeenCalledWith('attachments/report.pdf');
	});

	it('still serves attachments from KV when no R2 bucket is bound', async () => {
		delete env.r2; // storage type resolves to KV
		await env.kv.put('attachments/notes.txt', new TextEncoder().encode('hello kv'), {
			metadata: { contentType: 'text/plain', contentDisposition: 'attachment;filename=notes.txt' },
		});

		const req = new Request('http://cloudmail.test/attachments/notes.txt');
		const resp = await worker.fetch(req, env, {});

		expect(resp).toBeInstanceOf(Response);
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe('hello kv');
	});

	it('returns 404 for attachments that exist in no backend', async () => {
		env.r2 = makeR2({});

		const req = new Request('http://cloudmail.test/attachments/missing.pdf');
		const resp = await worker.fetch(req, env, {});

		expect(resp).toBeInstanceOf(Response);
		expect(resp.status).toBe(404);
	});
});
