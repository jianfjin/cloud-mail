import verifyUtils from '../utils/verify-utils';

export const MAX_REQUEST_RECIPIENTS = 1000;

export class RecipientValidationError extends Error {
	constructor(code, message, conflicts = []) {
		super(message);
		this.name = 'RecipientValidationError';
		this.code = code;
		this.conflicts = conflicts;
	}
}

const roles = [
	{ input: 'receiveEmail', output: 'to', label: 'To' },
	{ input: 'cc', output: 'cc', label: 'Cc' },
	{ input: 'bcc', output: 'bcc', label: 'Bcc' },
];

function normalizeRole(value, label) {
	if (value == null) return [];
	if (!Array.isArray(value)) {
		throw new RecipientValidationError('invalidRecipientList', `${label} recipients must be an array.`);
	}

	const result = [];
	const seen = new Set();

	for (const recipient of value) {
		if (typeof recipient !== 'string') {
			throw new RecipientValidationError('invalidRecipient', `${label} contains an invalid email address.`);
		}

		const address = recipient.trim();
		if (!verifyUtils.isEmail(address)) {
			throw new RecipientValidationError('invalidRecipient', `${label} contains an invalid email address.`);
		}

		const normalized = address.toLowerCase();
		if (!seen.has(normalized)) {
			seen.add(normalized);
			result.push(address);
		}
	}

	return result;
}

export function normalizeRecipients(params = {}) {
	if (!params || typeof params !== 'object' || Array.isArray(params)) {
		throw new RecipientValidationError('invalidRecipientList', 'Recipients must be an object.');
	}

	const result = { to: [], cc: [], bcc: [] };
	const addresses = new Map();

	for (const role of roles) {
		const recipients = normalizeRole(params[role.input], role.label);
		result[role.output] = recipients;

		for (const address of recipients) {
			const normalized = address.toLowerCase();
			const entry = addresses.get(normalized) || { address, roles: [] };
			entry.roles.push(role.label);
			addresses.set(normalized, entry);
		}
	}

	const all = [...result.to, ...result.cc, ...result.bcc];
	if (all.length === 0) {
		throw new RecipientValidationError('emptyRecipient', 'Add at least one recipient.');
	}
	if (all.length > MAX_REQUEST_RECIPIENTS) {
		throw new RecipientValidationError('recipientLimit', `A message can have at most ${MAX_REQUEST_RECIPIENTS} recipients.`);
	}

	const conflicts = [...addresses.values()].filter(entry => entry.roles.length > 1);
	if (conflicts.length > 0) {
		const labels = [...new Set(conflicts.flatMap(entry => entry.roles))];
		throw new RecipientValidationError(
			'recipientRoleDuplicate',
			`A recipient cannot appear in ${labels.join(', ')} more than once.`,
			conflicts,
		);
	}

	return {
		...result,
		all,
		count: all.length,
	};
}
