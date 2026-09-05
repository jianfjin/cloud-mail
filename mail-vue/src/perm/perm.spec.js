import {describe, expect, it} from 'vitest';
import {permsToRouter} from './perm';

describe('mailing-list route permission', () => {
	it('adds the mailing-list management route only for the management permission', () => {
		expect(permsToRouter([]).map(route => route.path)).not.toContain('/mailing-lists');
		expect(permsToRouter(['mailing-list:manage']).map(route => route.path)).toContain('/mailing-lists');
	});
});
