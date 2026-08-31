import { isCalendarMimeType, normalizeCalendarAttachments } from '../utils/calendar-utils';

function withCalendarFilenames(attachments) {
	let calendarOrder = 0;

	return attachments.map(attachment => {
		if (!isCalendarMimeType(attachment?.mimeType || attachment?.contentType)) {
			return attachment;
		}

		calendarOrder += 1;
		if (typeof attachment.filename === 'string' && attachment.filename.trim()) {
			return attachment;
		}

		return {
			...attachment,
			filename: calendarOrder === 1 ? 'invite.ics' : `invite-${calendarOrder}.ics`,
		};
	});
}

export async function prepareCalendarReceipt(parsedEmail) {
	const input = Array.isArray(parsedEmail?.attachments) ? parsedEmail.attachments : [];
	const attachments = withCalendarFilenames(input);

	try {
		const envelope = await normalizeCalendarAttachments(attachments);
		return {
			attachments,
			calendarData: envelope ? JSON.stringify(envelope) : null,
		};
	} catch (_) {
		return { attachments, calendarData: null };
	}
}
