import {describe, expect, it} from 'vitest';
import {permKeyToPaths} from '../src/security/security';

describe('mailing-list permission routes', () => {
	it('maps management and report endpoints to the dedicated permission', () => {
		const paths = permKeyToPaths(['mailing-list:manage']);
		expect(paths).toContain('/mailingList/list');
		expect(paths).toContain('/mailingList/report');
	});
});
