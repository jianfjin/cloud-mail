import BizError from '../error/biz-error';

function dispatchToken() {
	return globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

function reportTotals(outcomes) {
	const totals = {
		delivered: 0,
		failed: 0,
		queued: 0,
		processing: 0,
		pending: 0,
		skipped: 0,
	};
	for (const outcome of outcomes) {
		if (Object.hasOwn(totals, outcome.state)) totals[outcome.state] += 1;
	}
	return totals;
}

function rowTotals(row) {
	return {
		delivered: Number(row.delivered || 0),
		failed: Number(row.failed || 0),
		queued: Number(row.queued || 0),
		processing: Number(row.processing || 0),
		pending: Number(row.pending || 0),
		skipped: Number(row.skipped || 0),
	};
}

async function postForList(c, listId, postId) {
	return c.env.db.prepare(
		'SELECT p.post_id, p.sender_email, p.create_time, p.state AS post_state, p.source_r2_key, ' +
		'l.list_id, l.address, l.display_name, l.state AS list_state ' +
		'FROM mailing_list_post p JOIN mailing_list l ON l.list_id = p.list_id ' +
		'WHERE p.post_id = ? AND p.list_id = ?',
	).bind(Number(postId), Number(listId)).first();
}

const mailingListReportService = {
	async report(c, listId, postId) {
		const post = await postForList(c, listId, postId);
		if (!post) throw new BizError('Mailing-list report not found');
		const outcomes = (await c.env.db.prepare(
			'SELECT delivery_id, state, safe_reason FROM mailing_list_delivery WHERE post_id = ? ORDER BY delivery_id',
		).bind(post.post_id).all()).results.map(row => ({
			deliveryId: row.delivery_id,
			state: row.state,
			safeReason: row.safe_reason,
		}));
		return {
			postId: post.post_id,
			list: {
				listId: post.list_id,
				address: post.address,
				displayName: post.display_name,
			},
			sender: post.sender_email,
			acceptedAt: post.create_time,
			state: post.post_state,
			totals: reportTotals(outcomes),
			outcomes,
		};
	},

	async reports(c, listId) {
		const reports = (await c.env.db.prepare(
			'SELECT p.post_id, p.sender_email, p.create_time, p.state AS post_state, ' +
			'l.list_id, l.address, l.display_name, ' +
			"SUM(CASE WHEN d.state = 'delivered' THEN 1 ELSE 0 END) AS delivered, " +
			"SUM(CASE WHEN d.state = 'failed' THEN 1 ELSE 0 END) AS failed, " +
			"SUM(CASE WHEN d.state = 'queued' THEN 1 ELSE 0 END) AS queued, " +
			"SUM(CASE WHEN d.state = 'processing' THEN 1 ELSE 0 END) AS processing, " +
			"SUM(CASE WHEN d.state = 'pending' THEN 1 ELSE 0 END) AS pending, " +
			"SUM(CASE WHEN d.state = 'skipped' THEN 1 ELSE 0 END) AS skipped " +
			'FROM mailing_list_post p ' +
			'JOIN mailing_list l ON l.list_id = p.list_id ' +
			'LEFT JOIN mailing_list_delivery d ON d.post_id = p.post_id ' +
			'WHERE p.list_id = ? ' +
			'GROUP BY p.post_id, p.sender_email, p.create_time, p.state, l.list_id, l.address, l.display_name ' +
			'ORDER BY p.post_id DESC',
		).bind(Number(listId)).all()).results;
		return reports.map(report => ({
			postId: report.post_id,
			list: {
				listId: report.list_id,
				address: report.address,
				displayName: report.display_name,
			},
			sender: report.sender_email,
			acceptedAt: report.create_time,
			state: report.post_state,
			totals: rowTotals(report),
		}));
	},

	async retry(c, listId, postId) {
		const post = await postForList(c, listId, postId);
		if (!post) throw new BizError('Mailing-list report not found');
		if (post.list_state !== 'enabled') throw new BizError('Mailing list is not enabled');
		if (!post.source_r2_key || !c.env.mailingListQueue?.sendBatch) {
			throw new BizError('Mailing list delivery unavailable');
		}

		const failed = (await c.env.db.prepare(
			'SELECT delivery_id FROM mailing_list_delivery WHERE post_id = ? AND state = ? ORDER BY delivery_id',
		).bind(post.post_id, 'failed').all()).results;
		const retries = failed.map(delivery => ({
			deliveryId: delivery.delivery_id,
			dispatchToken: dispatchToken(),
		}));
		if (!retries.length) return {requeued: 0};

		const results = await c.env.db.batch(retries.map(retry => c.env.db.prepare(
			'UPDATE mailing_list_delivery SET state = ?, dispatch_token = ?, update_time = CURRENT_TIMESTAMP WHERE delivery_id = ? AND post_id = ? AND state = ?',
		).bind('queued', retry.dispatchToken, retry.deliveryId, post.post_id, 'failed')));
		const accepted = retries.filter((_, index) => results[index].meta.changes === 1);
		if (!accepted.length) return {requeued: 0};

		try {
			await c.env.mailingListQueue.sendBatch(accepted.map(retry => ({
				body: {
					postId: post.post_id,
					deliveryId: retry.deliveryId,
					dispatchToken: retry.dispatchToken,
				},
			})));
		} catch (_) {
			await c.env.db.batch(accepted.map(retry => c.env.db.prepare(
				'UPDATE mailing_list_delivery SET state = ? WHERE delivery_id = ? AND state = ? AND dispatch_token = ?',
			).bind('failed', retry.deliveryId, 'queued', retry.dispatchToken)));
			throw new BizError('Mailing list delivery unavailable');
		}

		return {requeued: accepted.length};
	},

	async cleanup(c, now = new Date()) {
		const setting = await c.env.db.prepare(
			'SELECT mailing_list_report_retention_days FROM setting LIMIT 1',
		).first();
		const retentionDays = setting?.mailing_list_report_retention_days || 30;
		const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
		const expired = (await c.env.db.prepare(
			'SELECT post_id, source_r2_key FROM mailing_list_post WHERE create_time < ? LIMIT 100',
		).bind(cutoff).all()).results;
		let removed = 0;
		let failed = 0;

		for (const post of expired) {
			try {
				if (post.source_r2_key) await c.env.r2.delete(post.source_r2_key);
				await c.env.db.batch([
					c.env.db.prepare('DELETE FROM mailing_list_delivery_attempt WHERE delivery_id IN (SELECT delivery_id FROM mailing_list_delivery WHERE post_id = ?)').bind(post.post_id),
					c.env.db.prepare('DELETE FROM mailing_list_delivery WHERE post_id = ?').bind(post.post_id),
					c.env.db.prepare('DELETE FROM mailing_list_post WHERE post_id = ?').bind(post.post_id),
				]);
				removed += 1;
			} catch (_) {
				await c.env.db.prepare('UPDATE mailing_list_post SET state = ? WHERE post_id = ?').bind('cleanup_failed', post.post_id).run();
				failed += 1;
			}
		}

		await c.env.db.prepare('DELETE FROM mailing_list_rejection WHERE create_time < ?').bind(cutoff).run();
		return {removed, failed};
	},
};

export default mailingListReportService;
