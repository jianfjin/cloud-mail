import {describe, expect, it, vi} from 'vitest';
import {processMailingListQueue} from '../src/index';

describe('mailing-list Queue handler', () => {
	it('delivers each identifier payload and acknowledges it after a recorded outcome', async () => {
		const deliver = vi.fn().mockResolvedValue({delivered: true, deliveryId: 7});
		const message = {body: {postId: 4, deliveryId: 7, dispatchToken: 'token-7'}, ack: vi.fn()};

		await processMailingListQueue({messages: [message]}, {db: {}}, deliver);

		expect(deliver).toHaveBeenCalledWith({env: {db: {}}}, message.body);
		expect(message.ack).toHaveBeenCalledTimes(1);
	});

	it('acknowledges a consumer exception so Cloudflare does not redeliver automatically', async () => {
		const deliver = vi.fn().mockRejectedValue(new Error('source read failed'));
		const message = {body: {postId: 4, deliveryId: 7, dispatchToken: 'token-7'}, ack: vi.fn()};

		await expect(processMailingListQueue({messages: [message]}, {db: {}}, deliver)).resolves.toBeUndefined();
		expect(message.ack).toHaveBeenCalledTimes(1);
	});
});
