import {asc, eq} from 'drizzle-orm';
import BizError from '../error/biz-error';
import calendarProvider from '../entity/calendar-provider';
import orm from '../entity/orm';

function normalizeHost(value) {
	if (typeof value !== 'string') throw new BizError('Provider host must be an exact HTTPS host.', 400);
	const host = value.trim().toLowerCase();
	if (!host || host.includes('*') || /[/:@?#\s]/.test(host)) {
		throw new BizError('Provider host must be an exact HTTPS host.', 400);
	}

	const labels = host.split('.');
	if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
		throw new BizError('Provider host must be an exact HTTPS host.', 400);
	}
	return host;
}

function normalizeLabel(value) {
	if (typeof value !== 'string') throw new BizError('Provider label is required.', 400);
	const label = value.trim();
	if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
		throw new BizError('Provider label is invalid.', 400);
	}
	return label;
}

function normalizedEnabled(value) {
	if (value === true || value === 1) return 1;
	if (value === false || value === 0) return 0;
	throw new BizError('Provider enabled state is invalid.', 400);
}

const calendarProviderService = {
	list(c) {
		return orm(c).select().from(calendarProvider).orderBy(asc(calendarProvider.host)).all();
	},

	async create(c, params, userId) {
		const host = normalizeHost(params?.host);
		const label = normalizeLabel(params?.label);
		const enabled = params?.enabled === undefined ? 1 : normalizedEnabled(params.enabled);
		try {
			return await orm(c).insert(calendarProvider).values({
				host,
				label,
				enabled,
				createdByUserId: userId,
				updatedByUserId: userId,
			}).returning().get();
		} catch (error) {
			const existing = await orm(c).select().from(calendarProvider).where(eq(calendarProvider.host, host)).get();
			if (existing) throw new BizError('Provider host is already registered.', 409);
			throw error;
		}
	},

	async update(c, providerId, params, userId) {
		providerId = Number(providerId);
		if (!Number.isInteger(providerId) || providerId <= 0) throw new BizError('Provider identity is invalid.', 400);
		const changes = {updatedByUserId: userId, updateTime: new Date().toISOString()};
		if (Object.hasOwn(params || {}, 'label')) changes.label = normalizeLabel(params.label);
		if (Object.hasOwn(params || {}, 'enabled')) changes.enabled = normalizedEnabled(params.enabled);
		if (Object.keys(changes).length === 2) throw new BizError('Provider update is empty.', 400);
		const updated = await orm(c).update(calendarProvider).set(changes)
			.where(eq(calendarProvider.providerId, providerId)).returning().get();
		if (!updated) throw new BizError('Provider not found.', 404);
		return updated;
	},

	async applyTrust(c, envelope) {
		const providers = await this.list(c);
		const enabledByHost = new Map(providers.filter(provider => provider.enabled).map(provider => [provider.host, provider]));
		return {
			...envelope,
			events: Array.isArray(envelope?.events) ? envelope.events.map(event => {
				const link = event?.meetingLink;
				if (!link || typeof link.hostname !== 'string') return event;
				const provider = enabledByHost.get(link.hostname.toLowerCase());
				return {
					...event,
					meetingLink: {
						...link,
						trust: provider ? 'trusted' : 'unverified',
						provider: provider ? (link.provider || provider.label) : (link.provider || null),
					},
				};
			}) : [],
		};
	},
};

export default calendarProviderService;
