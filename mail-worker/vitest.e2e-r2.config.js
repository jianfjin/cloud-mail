import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		include: ['test/attachment-e2e-r2.spec.js'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler-test-r2.toml' },
			},
		},
	},
});
