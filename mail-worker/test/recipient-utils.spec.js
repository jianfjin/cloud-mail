import { describe, expect, it } from 'vitest';
import { normalizeRecipients } from '../src/lib/recipient-utils';

describe('normalizeRecipients', () => {
	it('keeps legacy To-only payloads compatible', () => {
		const recipients = normalizeRecipients({ receiveEmail: ['To@example.com'] });

		expect(recipients.to).toEqual(['To@example.com']);
		expect(recipients.cc).toEqual([]);
		expect(recipients.bcc).toEqual([]);
		expect(recipients.all).toEqual(['To@example.com']);
	});

	it('accepts CC-only and BCC-only recipients', () => {
		expect(normalizeRecipients({ cc: ['cc@example.com'] })).toMatchObject({
			to: [],
			cc: ['cc@example.com'],
			bcc: [],
		});
		expect(normalizeRecipients({ bcc: ['bcc@example.com'] })).toMatchObject({
			to: [],
			cc: [],
			bcc: ['bcc@example.com'],
		});
	});

	it('collapses case variants inside the same role without mutating input', () => {
		const receiveEmail = ['Person@example.com', 'person@example.com'];
		const recipients = normalizeRecipients({ receiveEmail });

		expect(recipients.to).toEqual(['Person@example.com']);
		expect(receiveEmail).toEqual(['Person@example.com', 'person@example.com']);
	});

	it('reports every conflicting role for cross-field duplicates', () => {
		try {
			normalizeRecipients({
				receiveEmail: ['Person@example.com'],
				cc: ['person@example.com'],
				bcc: ['PERSON@example.com'],
			});
			expect.unreachable('Expected cross-role duplicate to throw');
		} catch (error) {
			expect(error.code).toBe('recipientRoleDuplicate');
			expect(error.conflicts).toEqual([
				{ address: 'Person@example.com', roles: ['To', 'Cc', 'Bcc'] },
			]);
		}
	});

	it.each([
		{ receiveEmail: [] },
		{ receiveEmail: ['not-an-email'] },
		{ cc: 'cc@example.com' },
		{ bcc: Array.from({ length: 1001 }, (_, index) => `person-${index}@example.com`) },
	])('rejects invalid recipient input %#', input => {
		expect(() => normalizeRecipients(input)).toThrow();
	});
});
