import ICAL from 'ical.js';

export const CALENDAR_SCHEMA_VERSION = 2;
export const CALENDAR_PARSER_VERSION = 'ical.js/2.2.1';

export const CALENDAR_LIMITS = Object.freeze({
	parts: 8,
	contentBytes: 1024 * 1024,
	events: 32,
	attendees: 200,
	linkCandidates: 32,
	lineBytes: 64 * 1024,
	summaryBytes: 2 * 1024,
	locationBytes: 4 * 1024,
	descriptionBytes: 32 * 1024,
	personBytes: 512,
	urlBytes: 2 * 1024,
	envelopeBytes: 256 * 1024,
});

const CALENDAR_MIME_TYPES = new Set(['text/calendar', 'application/ics']);
const KNOWN_CONFERENCE_HOSTS = new Map([
	['meet.google.com', 'google-meet'],
	['teams.microsoft.com', 'microsoft-teams'],
	['teams.live.com', 'microsoft-teams'],
]);
const CONFERENCE_PROPERTIES = new Set([
	'conference',
	'x-google-conference',
	'x-google-hangout',
	'x-microsoft-skypeteamsmeetingurl',
	'x-microsoft-teamsmeetingurl',
	'x-microsoft-online-meeting-conf-link',
	'x-ms-olk-online-meeting-conf-link',
]);
const MAX_WARNINGS = 128;
const SOURCE_METADATA_BYTES = 512;
const METHOD_BYTES = 64;
const MAX_SOURCE_METHODS = 16;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function warning(code, details = {}) {
	return { code, ...details };
}

function addWarning(warnings, code, details = {}) {
	if (warnings.length >= MAX_WARNINGS) return;
	warnings.push(warning(code, details));
}

function normalizeMimeType(value) {
	return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

export function isCalendarMimeType(value) {
	return CALENDAR_MIME_TYPES.has(normalizeMimeType(value));
}

function asBytes(content) {
	if (typeof content === 'string') return textEncoder.encode(content);
	if (content instanceof Uint8Array) return content;
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (ArrayBuffer.isView(content)) {
		return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	}
	return null;
}

async function sourceIdentity(bytes, oversized = false) {
	const digestInput = oversized ? bytes.subarray(0, CALENDAR_LIMITS.lineBytes) : bytes;
	const digest = await crypto.subtle.digest('SHA-256', digestInput);
	const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
	return oversized ? `sha256-prefix:${hex}:${bytes.byteLength}` : `sha256:${hex}`;
}

function hasOversizedPhysicalLine(bytes) {
	let lineBytes = 0;
	for (const byte of bytes) {
		if (byte === 10) {
			lineBytes = 0;
			continue;
		}
		lineBytes += 1;
		if (lineBytes > CALENDAR_LIMITS.lineBytes) return true;
	}
	return false;
}

function truncateUtf8(value, maximumBytes) {
	if (value === null || value === undefined) return null;
	const stringValue = String(value);
	if (textEncoder.encode(stringValue).byteLength <= maximumBytes) {
		return stringValue;
	}

	let result = '';
	let usedBytes = 0;
	for (const character of stringValue) {
		const characterBytes = textEncoder.encode(character).byteLength;
		if (usedBytes + characterBytes > maximumBytes) break;
		result += character;
		usedBytes += characterBytes;
	}
	return result;
}

function boundedText(value, maximumBytes, warnings, field, eventIdentity) {
	if (value === null || value === undefined) return null;
	const stringValue = String(value);
	const result = truncateUtf8(stringValue, maximumBytes);
	if (result !== stringValue) {
		addWarning(warnings, 'field_truncated', { field, eventIdentity });
	}
	return result;
}

function normalizeMethod(value) {
	if (typeof value !== 'string' || !value.trim()) return null;
	return truncateUtf8(value.trim().toUpperCase(), METHOD_BYTES);
}

function normalizedFilename(value, sourceOrder, warnings, sourceId = null) {
	const fallback = sourceOrder ? `invite-${sourceOrder + 1}.ics` : 'invite.ics';
	const original = typeof value === 'string' && value ? value : fallback;
	const filename = truncateUtf8(original, SOURCE_METADATA_BYTES);
	if (filename !== original) addWarning(warnings, 'source_filename_truncated', { sourceId, sourceOrder });
	return filename;
}

function normalizeAddress(value, warnings, field, eventIdentity) {
	if (value === null || value === undefined) return null;
	let address = String(value).trim();
	if (address.toLowerCase().startsWith('mailto:')) address = address.slice(7);
	try {
		address = decodeURIComponent(address);
	} catch (_) {
		addWarning(warnings, 'invalid_person_address', { field, eventIdentity });
	}
	return boundedText(address, CALENDAR_LIMITS.personBytes, warnings, field, eventIdentity);
}

function propertyText(component, name, maximumBytes, warnings, eventIdentity) {
	const value = component.getFirstPropertyValue(name);
	return boundedText(value, maximumBytes, warnings, name, eventIdentity);
}

function pad(value) {
	return String(value).padStart(2, '0');
}

function formatTimeValue(time) {
	const date = `${String(time.year).padStart(4, '0')}-${pad(time.month)}-${pad(time.day)}`;
	if (time.isDate) return date;
	return `${date}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
}

function utcInstant(time, offsetSeconds = 0) {
	const milliseconds = Date.UTC(
		time.year,
		time.month - 1,
		time.day,
		time.hour,
		time.minute,
		time.second,
	) - offsetSeconds * 1000;
	return new Date(milliseconds).toISOString();
}

function timeProperty(component, name, timezones, warnings, eventIdentity) {
	const property = component.getFirstProperty(name);
	if (!property) return null;
	const time = property.getFirstValue();
	if (!time || typeof time !== 'object') return null;
	const value = formatTimeValue(time);

	if (time.isDate) {
		return { kind: 'all-day', value, timezone: null, instant: null };
	}

	const tzidParameter = property.getParameter('tzid');
	const tzid = typeof tzidParameter === 'string' ? tzidParameter : null;
	const isUtc = !tzid && (time.zone === ICAL.Timezone.utcTimezone || time.zone?.tzid === 'UTC' || /Z$/i.test(time.toString()));
	if (isUtc) {
		return { kind: 'utc', value: `${value}Z`, timezone: 'UTC', instant: utcInstant(time) };
	}
	if (!tzid) {
		return { kind: 'floating', value, timezone: null, instant: null };
	}

	const timezone = timezones.get(tzid);
	if (!timezone) {
		addWarning(warnings, 'unresolved_timezone', { timezone: truncateUtf8(tzid, CALENDAR_LIMITS.personBytes), eventIdentity });
		return {
			kind: 'unresolved',
			value,
			timezone: truncateUtf8(tzid, CALENDAR_LIMITS.personBytes),
			instant: null,
		};
	}

	try {
		return {
			kind: 'zoned',
			value,
			timezone: truncateUtf8(tzid, CALENDAR_LIMITS.personBytes),
			instant: utcInstant(time, timezone.utcOffset(time)),
		};
	} catch (_) {
		addWarning(warnings, 'unresolved_timezone', { timezone: truncateUtf8(tzid, CALENDAR_LIMITS.personBytes), eventIdentity });
		return {
			kind: 'unresolved',
			value,
			timezone: truncateUtf8(tzid, CALENDAR_LIMITS.personBytes),
			instant: null,
		};
	}
}

function durationEnd(component, start, timezones, warnings, eventIdentity) {
	if (!start || component.getFirstProperty('dtend')) return null;
	const startProperty = component.getFirstProperty('dtstart');
	const duration = component.getFirstPropertyValue('duration');
	if (!startProperty || !duration || typeof duration !== 'object') return null;

	try {
		const endTime = startProperty.getFirstValue().clone();
		endTime.addDuration(duration);
		const temporary = new ICAL.Component('vevent');
		const endProperty = new ICAL.Property('dtend');
		const tzid = startProperty.getParameter('tzid');
		if (tzid) endProperty.setParameter('tzid', tzid);
		endProperty.setValue(endTime);
		temporary.addProperty(endProperty);
		return timeProperty(temporary, 'dtend', timezones, warnings, eventIdentity);
	} catch (_) {
		addWarning(warnings, 'invalid_duration', { eventIdentity });
		return null;
	}
}

function rawTimeIdentity(component, name) {
	const property = component.getFirstProperty(name);
	if (!property) return null;
	const value = property.getFirstValue();
	if (!value || typeof value !== 'object') return truncateUtf8(value, CALENDAR_LIMITS.personBytes);
	const formatted = formatTimeValue(value);
	return value.isDate ? formatted : `${formatted}${value.zone === ICAL.Timezone.utcTimezone || value.zone?.tzid === 'UTC' ? 'Z' : ''}`;
}

function normalizePerson(property, warnings, field, eventIdentity) {
	if (!property) return null;
	return {
		name: boundedText(property.getParameter('cn'), CALENDAR_LIMITS.personBytes, warnings, `${field}.name`, eventIdentity),
		address: normalizeAddress(property.getFirstValue(), warnings, `${field}.address`, eventIdentity),
	};
}

function normalizeAttendees(component, warnings, eventIdentity) {
	const properties = component.getAllProperties('attendee');
	const selected = properties.slice(0, CALENDAR_LIMITS.attendees);
	if (properties.length > selected.length) {
		addWarning(warnings, 'attendees_truncated', { eventIdentity, omittedCount: properties.length - selected.length });
	}
	return {
		attendees: selected.map(property => ({
			...normalizePerson(property, warnings, 'attendee', eventIdentity),
			role: boundedText(property.getParameter('role'), CALENDAR_LIMITS.personBytes, warnings, 'attendee.role', eventIdentity),
			participationStatus: boundedText(property.getParameter('partstat'), CALENDAR_LIMITS.personBytes, warnings, 'attendee.participationStatus', eventIdentity),
		})),
		omittedAttendeeCount: properties.length - selected.length,
	};
}

function trimUrlPunctuation(value) {
	return value.replace(/[),.;]+$/g, '');
}

function urlsFromText(value) {
	if (typeof value !== 'string') return [];
	return Array.from(value.matchAll(/https?:\/\/[^\s<>"']+/gi), match => trimUrlPunctuation(match[0]));
}

function validateConferenceUrl(value, source) {
	if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
	if (textEncoder.encode(value).byteLength > CALENDAR_LIMITS.urlBytes) return null;

	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
		const hostname = url.hostname.toLowerCase();
		const provider = KNOWN_CONFERENCE_HOSTS.get(hostname) || null;
		return {
			url: url.href,
			hostname,
			source,
			trust: 'unverified',
			provider,
		};
	} catch (_) {
		return null;
	}
}

function selectMeetingLink(component, warnings, eventIdentity) {
	const candidates = [];
	for (const property of component.getAllProperties()) {
		const propertyName = property.name.toLowerCase();
		if (CONFERENCE_PROPERTIES.has(propertyName)) {
			candidates.push({ value: String(property.getFirstValue() || ''), source: propertyName });
		}
	}

	for (const propertyName of ['url', 'location', 'description']) {
		for (const value of urlsFromText(component.getFirstPropertyValue(propertyName))) {
			candidates.push({ value, source: propertyName });
		}
	}

	if (candidates.length > CALENDAR_LIMITS.linkCandidates) {
		addWarning(warnings, 'link_candidates_truncated', {
			eventIdentity,
			omittedCount: candidates.length - CALENDAR_LIMITS.linkCandidates,
		});
	}

	for (const candidate of candidates.slice(0, CALENDAR_LIMITS.linkCandidates)) {
		const result = validateConferenceUrl(candidate.value, candidate.source);
		if (result) return result;
	}
	return null;
}

function classifyAction(calendarMethod, mimeMethod, status, sequence, recurrenceId, warnings, eventIdentity) {
	const mismatch = Boolean(mimeMethod && calendarMethod && mimeMethod !== calendarMethod);
	if (mismatch) addWarning(warnings, 'method_mismatch', { eventIdentity, mimeMethod, calendarMethod });
	if (status === 'CANCELLED') return 'cancellation';
	if (mismatch) return 'calendar';
	if (calendarMethod === 'CANCEL') return 'cancellation';
	if (calendarMethod === 'REQUEST') return sequence > 0 || recurrenceId ? 'update' : 'invitation';
	addWarning(warnings, 'unsupported_method', { eventIdentity, calendarMethod });
	return 'calendar';
}

function createTimezones(calendarComponent) {
	const timezones = new Map();
	for (const component of calendarComponent.getAllSubcomponents('vtimezone')) {
		try {
			const timezone = new ICAL.Timezone(component);
			if (timezone.tzid) timezones.set(timezone.tzid, timezone);
		} catch (_) {
			// The affected event will be represented as an unresolved TZID.
		}
	}
	return timezones;
}

function normalizeEvent(component, context) {
	const uid = boundedText(component.getFirstPropertyValue('uid'), CALENDAR_LIMITS.personBytes, context.warnings, 'uid', null);
	const recurrenceId = rawTimeIdentity(component, 'recurrence-id');
	const sequenceValue = Number(component.getFirstPropertyValue('sequence') || 0);
	const sequence = Number.isFinite(sequenceValue) && sequenceValue >= 0 ? Math.trunc(sequenceValue) : 0;
	const eventIdentity = `${uid || '(missing uid)'}|${recurrenceId || ''}|${sequence}`;
	const status = normalizeMethod(component.getFirstPropertyValue('status'));
	const start = timeProperty(component, 'dtstart', context.timezones, context.warnings, eventIdentity);
	if (!uid) addWarning(context.warnings, 'event_missing_uid', { eventIdentity });
	if (!start) addWarning(context.warnings, 'event_missing_start', { eventIdentity });
	const end = timeProperty(component, 'dtend', context.timezones, context.warnings, eventIdentity)
		|| durationEnd(component, start, context.timezones, context.warnings, eventIdentity);
	const attendeeData = normalizeAttendees(component, context.warnings, eventIdentity);
	const recurrence = Boolean(recurrenceId || component.getFirstProperty('rrule'));

	return {
		sourceId: context.sourceId,
		sourceOrder: context.sourceOrder,
		calendarOrder: context.calendarOrder,
		eventOrder: context.eventOrder,
		uid,
		recurrenceId,
		sequence,
		dtstamp: rawTimeIdentity(component, 'dtstamp'),
		action: classifyAction(context.calendarMethod, context.mimeMethod, status, sequence, recurrenceId, context.warnings, eventIdentity),
		status,
		summary: propertyText(component, 'summary', CALENDAR_LIMITS.summaryBytes, context.warnings, eventIdentity),
		description: propertyText(component, 'description', CALENDAR_LIMITS.descriptionBytes, context.warnings, eventIdentity),
		location: propertyText(component, 'location', CALENDAR_LIMITS.locationBytes, context.warnings, eventIdentity),
		organizer: normalizePerson(component.getFirstProperty('organizer'), context.warnings, 'organizer', eventIdentity),
		attendees: attendeeData.attendees,
		omittedAttendeeCount: attendeeData.omittedAttendeeCount,
		recurrence,
		start,
		end,
		meetingLink: selectMeetingLink(component, context.warnings, eventIdentity),
	};
}

function splitCalendars(content) {
	const matches = content.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/gi);
	return matches?.length ? matches : [content];
}

function duplicateIdentity(item, calendarMethod) {
	if (!item.uid) return null;
	return JSON.stringify([calendarMethod, item.uid, item.recurrenceId, item.sequence]);
}

function displayFingerprint(item) {
	const { sourceId, sourceOrder, calendarOrder, eventOrder, ...displayFields } = item;
	return JSON.stringify(displayFields);
}

function parseSource(text, source, envelope, duplicateIndex, parseState) {
	const calendars = splitCalendars(text);
	let parsedCalendarCount = 0;
	let unsupportedCalendarCount = 0;
	let failedCalendarCount = 0;
	let sourceEventCount = 0;
	let sourceOmittedEventCount = 0;

	for (let calendarOrder = 0; calendarOrder < calendars.length; calendarOrder += 1) {
		try {
			const calendarComponent = new ICAL.Component(ICAL.parse(calendars[calendarOrder]));
			if (calendarComponent.name.toLowerCase() !== 'vcalendar') throw new Error('Expected VCALENDAR');
			const calendarMethod = normalizeMethod(calendarComponent.getFirstPropertyValue('method'));
			if (calendarMethod && !source.calendarMethods.includes(calendarMethod)) {
				if (source.calendarMethods.length < MAX_SOURCE_METHODS) source.calendarMethods.push(calendarMethod);
				else addWarning(envelope.warnings, 'calendar_methods_truncated', { sourceId: source.sourceId });
			}
			const components = calendarComponent.getAllSubcomponents('vevent');
			if (!components.length) {
				unsupportedCalendarCount += 1;
				addWarning(envelope.warnings, 'no_vevent', { sourceId: source.sourceId, calendarOrder });
				continue;
			}

			parsedCalendarCount += 1;
			const timezones = createTimezones(calendarComponent);
			for (let eventOrder = 0; eventOrder < components.length; eventOrder += 1) {
				sourceEventCount += 1;
				parseState.suppliedEventCount += 1;
				if (parseState.suppliedEventCount > CALENDAR_LIMITS.events) {
					envelope.omittedEventCount += 1;
					sourceOmittedEventCount += 1;
					continue;
				}

				try {
					const normalized = normalizeEvent(components[eventOrder], {
						sourceId: source.sourceId,
						sourceOrder: source.sourceOrder,
						calendarOrder,
						eventOrder,
						calendarMethod,
						mimeMethod: source.mimeMethod,
						timezones,
						warnings: envelope.warnings,
					});
					const identity = duplicateIdentity(normalized, calendarMethod);
					const fingerprint = displayFingerprint(normalized);
					const seen = identity ? duplicateIndex.get(identity) : null;
					if (seen?.has(fingerprint)) {
						addWarning(envelope.warnings, 'duplicate_collapsed', { eventIdentity: identity });
						continue;
					}
					if (seen?.size) {
						addWarning(envelope.warnings, 'conflicting_duplicate_identity', { eventIdentity: identity });
					}
					if (identity) {
						if (!seen) duplicateIndex.set(identity, new Set([fingerprint]));
						else seen.add(fingerprint);
					}
					envelope.events.push(normalized);
				} catch (_) {
					addWarning(envelope.warnings, 'event_parse_failed', { sourceId: source.sourceId, calendarOrder, eventOrder });
				}
			}
		} catch (_) {
			failedCalendarCount += 1;
			addWarning(envelope.warnings, 'calendar_parse_failed', { sourceId: source.sourceId, calendarOrder });
		}
	}

	source.eventCount = sourceEventCount;
	source.omittedEventCount = sourceOmittedEventCount;
	if (parsedCalendarCount && (failedCalendarCount || unsupportedCalendarCount)) source.state = 'partial';
	else if (parsedCalendarCount) source.state = 'parsed';
	else if (failedCalendarCount) source.state = 'failed';
	else source.state = 'unsupported';
}

function baseEnvelope() {
	return {
		schemaVersion: CALENDAR_SCHEMA_VERSION,
		parserVersion: CALENDAR_PARSER_VERSION,
		state: 'failed',
		sources: [],
		events: [],
		warnings: [],
		truncated: { parts: false, events: false, envelope: false },
		omittedPartCount: 0,
		omittedEventCount: 0,
	};
}

function serializedBytes(value) {
	return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function enforceEnvelopeLimit(envelope) {
	if (serializedBytes(envelope) <= CALENDAR_LIMITS.envelopeBytes) return;
	envelope.truncated.envelope = true;
	addWarning(envelope.warnings, 'envelope_truncated');

	for (const item of envelope.events) {
		if (serializedBytes(envelope) <= CALENDAR_LIMITS.envelopeBytes) break;
		if (item.description) item.description = truncateUtf8(item.description, 4096);
	}
	for (let index = envelope.events.length - 1; index >= 0 && serializedBytes(envelope) > CALENDAR_LIMITS.envelopeBytes; index -= 1) {
		const item = envelope.events[index];
		while (item.attendees.length && serializedBytes(envelope) > CALENDAR_LIMITS.envelopeBytes) {
			item.attendees.pop();
			item.omittedAttendeeCount += 1;
		}
	}
	while (envelope.events.length && serializedBytes(envelope) > CALENDAR_LIMITS.envelopeBytes) {
		envelope.events.pop();
		envelope.omittedEventCount += 1;
		envelope.truncated.events = true;
	}
	while (envelope.warnings.length > 1 && serializedBytes(envelope) > CALENDAR_LIMITS.envelopeBytes) {
		envelope.warnings.splice(envelope.warnings.length - 2, 1);
	}
}

function finishEnvelope(envelope) {
	if (envelope.omittedPartCount > 0) {
		envelope.truncated.parts = true;
		addWarning(envelope.warnings, 'calendar_parts_truncated', { omittedCount: envelope.omittedPartCount });
	}
	if (envelope.omittedEventCount > 0) {
		envelope.truncated.events = true;
		addWarning(envelope.warnings, 'calendar_events_truncated', { omittedCount: envelope.omittedEventCount });
	}

	if (envelope.events.length) {
		const hasIncompleteSource = envelope.sources.some(source => source.state !== 'parsed');
		envelope.state = hasIncompleteSource || envelope.warnings.some(item => item.code !== 'duplicate_collapsed') ? 'partial' : 'parsed';
	} else if (envelope.sources.some(source => source.state === 'failed')) {
		envelope.state = 'failed';
	} else {
		envelope.state = 'unsupported';
	}

	enforceEnvelopeLimit(envelope);
	if (envelope.truncated.envelope || envelope.truncated.events || envelope.truncated.parts) envelope.state = 'partial';
	return envelope;
}

function failedEnvelope(code, state = 'failed') {
	const envelope = baseEnvelope();
	envelope.state = state;
	addWarning(envelope.warnings, code);
	return envelope;
}

export function createCalendarFallback(code, state = 'failed') {
	return failedEnvelope(code, state);
}

function parseCurrentEnvelope(value) {
	if (typeof value === 'string' && textEncoder.encode(value).byteLength > CALENDAR_LIMITS.envelopeBytes) return null;
	const envelope = typeof value === 'string' ? JSON.parse(value) : value;
	if (!envelope || envelope.schemaVersion !== CALENDAR_SCHEMA_VERSION || envelope.parserVersion !== CALENDAR_PARSER_VERSION) return null;
	if (!['parsed', 'partial', 'unsupported', 'failed'].includes(envelope.state)
		|| !Array.isArray(envelope.sources)
		|| !Array.isArray(envelope.events)
		|| !Array.isArray(envelope.warnings)
		|| serializedBytes(envelope) > CALENDAR_LIMITS.envelopeBytes) return null;
	return envelope;
}

export function isCurrentCalendarEnvelope(value) {
	try {
		return Boolean(parseCurrentEnvelope(value));
	} catch (_) {
		return false;
	}
}

export async function normalizeCalendarAttachments(attachments) {
	try {
		const input = Array.isArray(attachments) ? attachments : [];
		const recognized = input.filter(item => isCalendarMimeType(item?.mimeType || item?.contentType));
		if (!recognized.length) return null;

		const envelope = baseEnvelope();
		envelope.omittedPartCount = Math.max(0, recognized.length - CALENDAR_LIMITS.parts);
		const duplicateIndex = new Map();
		const parseState = { suppliedEventCount: 0 };

		for (let sourceOrder = 0; sourceOrder < Math.min(recognized.length, CALENDAR_LIMITS.parts); sourceOrder += 1) {
			const attachment = recognized[sourceOrder];
			const bytes = asBytes(attachment.content);
			if (!bytes) {
				const source = {
					sourceId: `invalid:${sourceOrder}`,
					sourceOrder,
					mimeType: normalizeMimeType(attachment.mimeType || attachment.contentType),
					filename: normalizedFilename(attachment.filename, sourceOrder, envelope.warnings),
					mimeMethod: normalizeMethod(attachment.method),
					calendarMethods: [],
					state: 'failed',
					eventCount: 0,
					omittedEventCount: 0,
				};
				envelope.sources.push(source);
				addWarning(envelope.warnings, 'invalid_calendar_content', { sourceOrder });
				continue;
			}

			const contentTooLarge = bytes.byteLength > CALENDAR_LIMITS.contentBytes;
			const source = {
				sourceId: await sourceIdentity(bytes, contentTooLarge),
				sourceOrder,
				mimeType: normalizeMimeType(attachment.mimeType || attachment.contentType),
				filename: normalizedFilename(attachment.filename, sourceOrder, envelope.warnings),
				mimeMethod: normalizeMethod(attachment.method),
				calendarMethods: [],
				state: 'failed',
				eventCount: 0,
				omittedEventCount: 0,
			};
			envelope.sources.push(source);

			if (contentTooLarge) {
				addWarning(envelope.warnings, 'calendar_content_too_large', { sourceId: source.sourceId });
				continue;
			}
			if (hasOversizedPhysicalLine(bytes)) {
				addWarning(envelope.warnings, 'calendar_line_too_long', { sourceId: source.sourceId });
				continue;
			}

			parseSource(textDecoder.decode(bytes), source, envelope, duplicateIndex, parseState);
		}

		return finishEnvelope(envelope);
	} catch (_) {
		return failedEnvelope('calendar_normalization_failed');
	}
}

export function decodeCalendarEnvelope(value) {
	try {
		return parseCurrentEnvelope(value) || failedEnvelope('unsupported_calendar_envelope', 'unsupported');
	} catch (_) {
		return failedEnvelope('unsupported_calendar_envelope', 'unsupported');
	}
}
