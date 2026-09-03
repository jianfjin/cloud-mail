import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it} from 'vitest';
import {dbInit} from '../src/init/init';
import calendarProviderService from '../src/service/calendar-provider-service';

const c = {env};

async function resetProviderSchema() {
	await env.db.prepare('DROP TABLE IF EXISTS calendar_response').run();
	await env.db.prepare('DROP TABLE IF EXISTS calendar_provider').run();
	await dbInit.v3_6DB(c);
}

describe('calendar provider registry', () => {
	beforeEach(resetProviderSchema);

	it('trusts only enabled exact hosts and keeps lookalikes unverified', async () => {
		const custom = await calendarProviderService.create(c, {
			host: 'Video.Example.NET',
			label: 'Example Video',
		}, 41);
		const envelope = {
			events: [
				{uid: 'registered', meetingLink: {url: 'https://video.example.net/room', hostname: 'video.example.net', trust: 'unverified', provider: null}},
				{uid: 'lookalike', meetingLink: {url: 'https://video.example.net.evil.test/room', hostname: 'video.example.net.evil.test', trust: 'unverified', provider: null}},
				{uid: 'teams', meetingLink: {url: 'https://teams.microsoft.com/meet/1', hostname: 'teams.microsoft.com', trust: 'unverified', provider: 'microsoft-teams'}},
			],
		};

		const trusted = await calendarProviderService.applyTrust(c, envelope);
		expect(trusted).not.toBe(envelope);
		expect(trusted.events[0].meetingLink).toMatchObject({trust: 'trusted', provider: 'Example Video'});
		expect(trusted.events[1].meetingLink).toMatchObject({trust: 'unverified', provider: null});
		expect(trusted.events[2].meetingLink).toMatchObject({trust: 'trusted', provider: 'microsoft-teams'});

		await calendarProviderService.update(c, custom.providerId, {enabled: false}, 42);
		const disabled = await calendarProviderService.applyTrust(c, envelope);
		expect(disabled.events[0].meetingLink).toMatchObject({trust: 'unverified', provider: null});
	});

	it('rejects wildcards, URL-shaped hosts, and duplicate hosts', async () => {
		await expect(calendarProviderService.create(c, {host: '*.example.net', label: 'Wildcard'}, 1)).rejects.toThrow('exact HTTPS host');
		await expect(calendarProviderService.create(c, {host: 'https://video.example.net', label: 'URL'}, 1)).rejects.toThrow('exact HTTPS host');
		await calendarProviderService.create(c, {host: 'video.example.net', label: 'Video'}, 1);
		await expect(calendarProviderService.create(c, {host: 'VIDEO.example.net', label: 'Duplicate'}, 1)).rejects.toThrow('already registered');
	});
});
