import { afterEach, describe, expect, it, vi } from 'vitest';
import accountService from '../src/service/account-service';
import permService from '../src/service/perm-service';
import roleService from '../src/service/role-service';
import userService from '../src/service/user-service';

describe('login owned addresses', () => {
	afterEach(() => vi.restoreAllMocks());

	it('returns every active owned address instead of the paginated account subset', async () => {
		vi.spyOn(userService, 'selectById').mockResolvedValue({
			userId: 7,
			email: 'owner@example.com',
			sendCount: 3,
			type: 2,
		});
		vi.spyOn(accountService, 'selectByEmailIncludeDel').mockResolvedValue({
			accountId: 11,
			email: 'owner@example.com',
			name: 'Owner',
		});
		vi.spyOn(accountService, 'listActiveByUserId').mockResolvedValue([
			{ email: 'owner@example.com' },
			{ email: 'alias@example.com' },
			{ email: 'owner+calendar@example.com' },
		]);
		vi.spyOn(roleService, 'selectById').mockResolvedValue({ roleId: 2 });
		vi.spyOn(permService, 'userPermKeys').mockResolvedValue(['邮件查看']);

		const info = await userService.loginUserInfo({ env: { admin: 'admin@example.com' } }, 7);

		expect(info.ownedEmails).toEqual([
			'owner@example.com',
			'alias@example.com',
			'owner+calendar@example.com',
		]);
	});
});
