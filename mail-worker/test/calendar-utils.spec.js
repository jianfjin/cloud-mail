import { describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
import googleMeetMessage from './fixtures/calendar/google-meet.eml?raw';
import teamsMessage from './fixtures/calendar/teams.eml?raw';
import {
	CALENDAR_LIMITS,
	CALENDAR_PARSER_VERSION,
	CALENDAR_SCHEMA_VERSION,
	decodeCalendarEnvelope,
	normalizeCalendarAttachments,
} from '../src/utils/calendar-utils';

const encode = value => new TextEncoder().encode(value);

function calendarPart(content, overrides = {}) {
	return {
		mimeType: 'text/calendar',
		content: encode(content),
		...overrides,
	};
}

function calendar(events, method = 'REQUEST', extra = '') {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		`METHOD:${method}`,
		extra,
		...events,
		'END:VCALENDAR',
	].filter(Boolean).join('\r\n');
}

function event(overrides = {}) {
	const values = {
		uid: 'event-1@example.com',
		dtstamp: '20260830T120000Z',
		dtstart: '20260901T080000Z',
		dtend: '20260901T090000Z',
		sequence: '0',
		summary: 'Planning call',
		...overrides,
	};
	return [
		'BEGIN:VEVENT',
		`UID:${values.uid}`,
		`DTSTAMP:${values.dtstamp}`,
		values.recurrenceId ? `RECURRENCE-ID:${values.recurrenceId}` : '',
		values.dtstart ? `DTSTART${values.dtstartParams || ''}:${values.dtstart}` : '',
		values.dtend ? `DTEND${values.dtendParams || ''}:${values.dtend}` : '',
		values.duration ? `DURATION:${values.duration}` : '',
		`SEQUENCE:${values.sequence}`,
		values.status ? `STATUS:${values.status}` : '',
		`SUMMARY:${values.summary}`,
		values.extra || '',
		'END:VEVENT',
	].filter(Boolean).join('\r\n');
}

describe('calendar attachment normalization', () => {
	it('normalizes bodyless Google Meet and Teams MIME fixtures through PostalMime', async () => {
		const google = await PostalMime.parse(googleMeetMessage);
		const teams = await PostalMime.parse(teamsMessage);
		const googleEnvelope = await normalizeCalendarAttachments(google.attachments);
		const teamsEnvelope = await normalizeCalendarAttachments(teams.attachments);

		expect(google.html).toBeUndefined();
		expect(google.text).toBeUndefined();
		expect(googleEnvelope).toMatchObject({
			schemaVersion: CALENDAR_SCHEMA_VERSION,
			parserVersion: CALENDAR_PARSER_VERSION,
			state: 'parsed',
			events: [{
				action: 'invitation',
				summary: 'Planning call',
				organizer: { name: 'Zoë Example', address: 'zoe@example.com' },
				start: { kind: 'utc', instant: '2026-09-01T08:00:00.000Z' },
				meetingLink: {
					hostname: 'meet.google.com',
					provider: 'google-meet',
					trust: 'unverified',
				},
			}],
		});
		expect(teamsEnvelope).toMatchObject({
			state: 'parsed',
			events: [{
				action: 'update',
				summary: 'Teams planning update',
				start: {
					kind: 'zoned',
					timezone: 'Europe/Amsterdam',
					instant: '2026-09-01T08:00:00.000Z',
				},
				end: { kind: 'zoned', value: '2026-09-01T11:00:00' },
				meetingLink: {
					hostname: 'teams.microsoft.com',
					provider: 'microsoft-teams',
					trust: 'unverified',
				},
			}],
		});
	});

	it('preserves UTC, zoned, floating, unresolved, all-day, and duration semantics', async () => {
		const zone = [
			'BEGIN:VTIMEZONE',
			'TZID:Test/PlusTwo',
			'BEGIN:STANDARD',
			'DTSTART:19700101T000000',
			'TZOFFSETFROM:+0200',
			'TZOFFSETTO:+0200',
			'END:STANDARD',
			'END:VTIMEZONE',
		].join('\r\n');
		const events = [
			event({ uid: 'utc', dtstart: '20260901T080000Z', dtend: '20260901T090000Z' }),
			event({ uid: 'zoned', dtstartParams: ';TZID=Test/PlusTwo', dtstart: '20260901T100000', dtendParams: ';TZID=Test/PlusTwo', dtend: '20260901T110000' }),
			event({ uid: 'floating', dtstart: '20260901T100000', dtend: '', duration: 'PT30M' }),
			event({ uid: 'unknown', dtstartParams: ';TZID=Mars/Olympus', dtstart: '20260901T100000', dtendParams: ';TZID=Mars/Olympus', dtend: '20260901T110000' }),
			event({ uid: 'one-day', dtstartParams: ';VALUE=DATE', dtstart: '20260901', dtendParams: ';VALUE=DATE', dtend: '20260902' }),
			event({ uid: 'multi-day', dtstartParams: ';VALUE=DATE', dtstart: '20260901', dtendParams: ';VALUE=DATE', dtend: '20260904' }),
		];
		const result = await normalizeCalendarAttachments([calendarPart(calendar(events, 'REQUEST', zone))]);
		const byUid = Object.fromEntries(result.events.map(item => [item.uid, item]));

		expect(byUid.utc.start).toMatchObject({ kind: 'utc', timezone: 'UTC', instant: '2026-09-01T08:00:00.000Z' });
		expect(byUid.zoned.start).toMatchObject({ kind: 'zoned', timezone: 'Test/PlusTwo', instant: '2026-09-01T08:00:00.000Z' });
		expect(byUid.floating.start).toEqual({ kind: 'floating', value: '2026-09-01T10:00:00', timezone: null, instant: null });
		expect(byUid.floating.end.value).toBe('2026-09-01T10:30:00');
		expect(byUid.unknown.start).toMatchObject({ kind: 'unresolved', timezone: 'Mars/Olympus', instant: null });
		expect(byUid['one-day'].start).toEqual({ kind: 'all-day', value: '2026-09-01', timezone: null, instant: null });
		expect(byUid['one-day'].end.value).toBe('2026-09-02');
		expect(byUid['multi-day'].end.value).toBe('2026-09-04');
		expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unresolved_timezone' })]));
	});

	it('parses folded people fields, escaped delimiters, quoted parameters, and UTF-8 values', async () => {
		const people = event({ extra: [
			'ORGANIZER;CN="Miyuki 山田":mailto:miyuki@example.com',
			'ATTENDEE;CN="Doe\\, Renée";ROLE=OPT-PARTICIPANT;PARTSTAT=',
			' TENTATIVE:mailto:renee@example.com',
			'DESCRIPTION:First line\\nSecond line with \\, comma and \\; semicolon',
		].join('\r\n') });
		const result = await normalizeCalendarAttachments([calendarPart(calendar([people]))]);

		expect(result.events[0]).toMatchObject({
			organizer: { name: 'Miyuki 山田', address: 'miyuki@example.com' },
			attendees: [{
				name: 'Doe, Renée',
				address: 'renee@example.com',
				role: 'OPT-PARTICIPANT',
				participationStatus: 'TENTATIVE',
			}],
			description: 'First line\nSecond line with , comma and ; semicolon',
		});
	});

	it('classifies lifecycle from VCALENDAR while explicit VEVENT cancellation wins', async () => {
		const initial = await normalizeCalendarAttachments([calendarPart(calendar([event()]))]);
		const update = await normalizeCalendarAttachments([calendarPart(calendar([event({ sequence: '2' })]))]);
		const instanceCancel = await normalizeCalendarAttachments([calendarPart(calendar([event({ recurrenceId: '20260908T080000Z', status: 'CANCELLED' })]))]);
		const wholeCancel = await normalizeCalendarAttachments([calendarPart(calendar([event()], 'CANCEL'))]);
		const mismatch = await normalizeCalendarAttachments([calendarPart(calendar([event()], 'REQUEST'), { method: 'CANCEL' })]);
		const explicitMismatch = await normalizeCalendarAttachments([calendarPart(calendar([event({ status: 'CANCELLED' })], 'REQUEST'), { method: 'CANCEL' })]);

		expect(initial.events[0].action).toBe('invitation');
		expect(update.events[0].action).toBe('update');
		expect(instanceCancel.events[0].action).toBe('cancellation');
		expect(wholeCancel.events[0].action).toBe('cancellation');
		expect(mismatch.events[0].action).toBe('calendar');
		expect(mismatch.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'method_mismatch' })]));
		expect(explicitMismatch.events[0].action).toBe('cancellation');
	});

	it('keeps source order, collapses exact duplicates, and retains conflicting identity variants', async () => {
		const exact = calendar([event()]);
		const conflict = calendar([event({ summary: 'Changed title' })]);
		const firstBytes = encode(exact);
		const untouched = Array.from(firstBytes);
		const result = await normalizeCalendarAttachments([
			calendarPart(exact, { content: firstBytes }),
			calendarPart(exact, { filename: 'copy.ics' }),
			calendarPart(conflict),
		]);

		expect(Array.from(firstBytes)).toEqual(untouched);
		expect(result.sources).toHaveLength(3);
		expect(result.sources[0].sourceId).toBe(result.sources[1].sourceId);
		expect(result.sources.map(source => source.sourceOrder)).toEqual([0, 1, 2]);
		expect(result.sources.map(source => source.filename)).toEqual(['invite.ics', 'copy.ics', 'invite-3.ics']);
		expect(result.events.map(item => item.summary)).toEqual(['Planning call', 'Changed title']);
		expect(result.warnings).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'duplicate_collapsed' }),
			expect.objectContaining({ code: 'conflicting_duplicate_identity' }),
		]));
	});

	it('parses concatenated calendars and recurrence exceptions without expansion', async () => {
		const master = event({ uid: 'series', extra: 'RRULE:FREQ=DAILY;COUNT=1000' });
		const exception = event({ uid: 'series', recurrenceId: '20260902T080000Z', dtstart: '20260902T100000Z', dtend: '20260902T110000Z' });
		const result = await normalizeCalendarAttachments([
			calendarPart(`${calendar([master])}\r\n${calendar([exception])}`),
		]);

		expect(result.events).toHaveLength(2);
		expect(result.events[0].recurrence).toBe(true);
		expect(result.events[1]).toMatchObject({ recurrence: true, recurrenceId: '2026-09-02T08:00:00Z' });
	});

	it('returns visible bounded fallbacks for unsupported, malformed, and future data', async () => {
		const noEvent = calendar([], 'PUBLISH');
		const todo = calendar(['BEGIN:VTODO\r\nUID:todo-1\r\nSUMMARY:Task\r\nEND:VTODO']);
		const malformed = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nBROKEN';
		const mixed = await normalizeCalendarAttachments([calendarPart(calendar([event()])), calendarPart(malformed)]);
		const unknownMethod = await normalizeCalendarAttachments([calendarPart(calendar([event()], 'X-UNKNOWN'))]);
		const incompleteEvent = await normalizeCalendarAttachments([calendarPart(calendar([event({ uid: '', dtstart: '', dtend: '' })]))]);

		expect((await normalizeCalendarAttachments([calendarPart(noEvent)])).state).toBe('unsupported');
		expect((await normalizeCalendarAttachments([calendarPart(todo)])).state).toBe('unsupported');
		expect((await normalizeCalendarAttachments([calendarPart(malformed)])).state).toBe('failed');
		expect(mixed).toMatchObject({ state: 'partial', events: [{ uid: 'event-1@example.com' }] });
		expect(unknownMethod.events[0].action).toBe('calendar');
		expect(unknownMethod.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported_method' })]));
		expect(incompleteEvent.state).toBe('partial');
		expect(incompleteEvent.warnings).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'event_missing_uid' }),
			expect.objectContaining({ code: 'event_missing_start' }),
		]));
		expect(decodeCalendarEnvelope(null).state).toBe('unsupported');
		expect(decodeCalendarEnvelope('{bad json').state).toBe('unsupported');
		expect(decodeCalendarEnvelope({ schemaVersion: 999, parserVersion: 'future' }).state).toBe('unsupported');
		expect(decodeCalendarEnvelope('x'.repeat(CALENDAR_LIMITS.envelopeBytes + 1)).state).toBe('unsupported');
		expect(await normalizeCalendarAttachments([{ mimeType: 'text/plain', content: encode('ordinary mail') }])).toBeNull();
	});

	it('retains safe unverified conference links without fetching or trusting lookalike hosts', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const unsafe = event({ extra: [
			'CONFERENCE:https://user:pass@example.com/join',
			'CONFERENCE:http://meet.google.com/insecure',
			'URL:javascript:alert(1)',
			'LOCATION:https://meet.google.com.evil.example/join',
			'DESCRIPTION:data:text/html\\,bad file:///tmp/bad https://example.com/home',
			'ATTACH:https://example.com/payload',
			'IMAGE:https://example.com/image.png',
			'BEGIN:VALARM',
			'TRIGGER:-PT15M',
			'ACTION:DISPLAY',
			'DESCRIPTION:Reminder',
			'END:VALARM',
		].join('\r\n') });
		const lookalike = event({ uid: 'lookalike', extra: 'CONFERENCE:https://meet.google.com.evil.example/join' });
		const unverified = event({ uid: 'unverified', extra: 'CONFERENCE:https://video.example.net/room/123' });
		const trustedTeams = event({ uid: 'teams', extra: 'CONFERENCE:https://teams.live.com/meet/123' });
		const result = await normalizeCalendarAttachments([calendarPart(calendar([unsafe, lookalike, unverified, trustedTeams]))]);
		const byUid = Object.fromEntries(result.events.map(item => [item.uid, item]));

		expect(byUid['event-1@example.com'].meetingLink).toMatchObject({ hostname: 'meet.google.com.evil.example', trust: 'unverified', provider: null });
		expect(byUid.lookalike.meetingLink).toMatchObject({ hostname: 'meet.google.com.evil.example', trust: 'unverified', provider: null });
		expect(byUid.unverified.meetingLink).toMatchObject({ hostname: 'video.example.net', trust: 'unverified', provider: null });
		expect(byUid.teams.meetingLink).toMatchObject({ hostname: 'teams.live.com', trust: 'unverified', provider: 'microsoft-teams' });
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('enforces part, content, event, attendee, link, line, field, URL, and envelope caps', async () => {
		const manyEvents = Array.from({ length: CALENDAR_LIMITS.events + 1 }, (_, index) => event({ uid: `event-${index}` }));
		const attendees = Array.from({ length: CALENDAR_LIMITS.attendees + 1 }, (_, index) => `ATTENDEE;CN="Person ${index}":mailto:person${index}@example.com`).join('\r\n');
		const conferences = Array.from({ length: CALENDAR_LIMITS.linkCandidates + 1 }, (_, index) => `CONFERENCE:https://video${index}.example.net/room`).join('\r\n');
		const longFields = event({ uid: 'bounded-fields', summary: 'é'.repeat(2000), extra: [
			`LOCATION:${'l'.repeat(CALENDAR_LIMITS.locationBytes + 10)}`,
			`DESCRIPTION:${'d'.repeat(CALENDAR_LIMITS.descriptionBytes + 10)}`,
			`ORGANIZER;CN="${'名'.repeat(400)}":mailto:${'a'.repeat(600)}@example.com`,
			attendees,
			conferences,
		].join('\r\n') });
		const partsResult = await normalizeCalendarAttachments(Array.from(
			{ length: CALENDAR_LIMITS.parts + 1 },
			(_, index) => calendarPart(calendar([event({ uid: `part-${index}` })])),
		));
		const eventResult = await normalizeCalendarAttachments([calendarPart(calendar(manyEvents))]);
		const fieldsResult = await normalizeCalendarAttachments([calendarPart(calendar([longFields]))]);
		const tooLarge = await normalizeCalendarAttachments([calendarPart('x'.repeat(CALENDAR_LIMITS.contentBytes + 1))]);
		const longLine = await normalizeCalendarAttachments([calendarPart(`BEGIN:VCALENDAR\r\n${'x'.repeat(CALENDAR_LIMITS.lineBytes + 1)}\r\nEND:VCALENDAR`)]);
		const overlongUrl = await normalizeCalendarAttachments([calendarPart(calendar([event({ extra: `CONFERENCE:https://example.com/${'x'.repeat(CALENDAR_LIMITS.urlBytes)}` })]))]);
		const envelopeHeavyEvents = Array.from({ length: CALENDAR_LIMITS.events }, (_, index) => event({
			uid: `heavy-${index}`,
			summary: `Heavy ${index}`,
			extra: `DESCRIPTION:${'z'.repeat(12000)}`,
		}));
		const envelopeHeavy = await normalizeCalendarAttachments([calendarPart(calendar(envelopeHeavyEvents))]);

		expect(partsResult).toMatchObject({ state: 'partial', omittedPartCount: 1, truncated: { parts: true } });
		expect(eventResult).toMatchObject({ state: 'partial', omittedEventCount: 1, truncated: { events: true } });
		expect(eventResult.events).toHaveLength(CALENDAR_LIMITS.events);
		expect(fieldsResult.events[0].attendees).toHaveLength(CALENDAR_LIMITS.attendees);
		expect(fieldsResult.events[0].omittedAttendeeCount).toBe(1);
		expect(new TextEncoder().encode(fieldsResult.events[0].summary).byteLength).toBeLessThanOrEqual(CALENDAR_LIMITS.summaryBytes);
		expect(new TextEncoder().encode(fieldsResult.events[0].location).byteLength).toBeLessThanOrEqual(CALENDAR_LIMITS.locationBytes);
		expect(new TextEncoder().encode(fieldsResult.events[0].description).byteLength).toBeLessThanOrEqual(CALENDAR_LIMITS.descriptionBytes);
		expect(new TextEncoder().encode(fieldsResult.events[0].organizer.name).byteLength).toBeLessThanOrEqual(CALENDAR_LIMITS.personBytes);
		expect(fieldsResult.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'link_candidates_truncated' })]));
		expect(tooLarge.state).toBe('failed');
		expect(longLine.state).toBe('failed');
		expect(overlongUrl.events[0].meetingLink).toBeNull();
		expect(new TextEncoder().encode(JSON.stringify(fieldsResult)).byteLength).toBeLessThanOrEqual(CALENDAR_LIMITS.envelopeBytes);
		expect(envelopeHeavy.truncated.envelope).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(envelopeHeavy)).byteLength).toBeLessThanOrEqual(CALENDAR_LIMITS.envelopeBytes);
	});
});
