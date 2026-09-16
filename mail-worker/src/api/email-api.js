import app from '../hono/hono';
import emailService from '../service/email-service';
import result from '../model/result';
import userContext from '../security/user-context';
import attService from '../service/att-service';
import calendarPreviewService from '../service/calendar-preview-service';
import emailSearchService from '../service/email-search-service';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

async function searchResponse(c, operation) {
	c.header('Cache-Control', 'private, no-store');
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json(result.fail(t('searchInvalid'), 400), 400);
	}

	try {
		const response = await operation(body);
		if (response.status === 'rate_limited') {
			c.header('Retry-After', String(response.retryAfter));
			return c.json(result.fail(t('searchRateLimited'), 429), 429);
		}
		if (response.status === 'unavailable') {
			return c.json(result.fail(t('searchUnavailable'), 503), 503);
		}
		return c.json(result.ok(response.data));
	} catch (error) {
		if (error instanceof BizError && error.code === 400) {
			return c.json(result.fail(error.message, 400), 400);
		}
		throw error;
	}
}

app.get('/email/list', async (c) => {
	const data = await emailService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.get('/email/latest', async (c) => {
	const list = await emailService.latest(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.delete('/email/delete', async (c) => {
	await emailService.delete(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/email/attList', async (c) => {
	const attList = await attService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(attList));
});

app.post('/email/send', async (c) => {
	const email = await emailService.send(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(email));
});

app.put('/email/read', async (c) => {
	await emailService.read(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
})

app.post('/email/search', (c) => searchResponse(c, body => emailSearchService.page(
	c,
	body,
	userContext.getUserId(c),
)));

app.post('/email/search/details', (c) => searchResponse(c, body => emailSearchService.details(
	c,
	body,
	userContext.getUserId(c),
)));

app.post('/email/calendar-preview', async (c) => {
	c.header('Cache-Control', 'private, no-store');
	const body = await c.req.json().catch(() => null);
	if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'emailId')) {
		return c.json(result.fail('Invalid request', 400), 400);
	}

	const preview = await calendarPreviewService.getPreview(c, {
		emailId: body.emailId,
		userId: userContext.getUserId(c),
	});
	if (preview.status === 'not_found') return c.json(result.fail('Not found', 404), 404);
	if (preview.status === 'rate_limited') return c.json(result.fail('Try again later', 429), 429);
	if (preview.status === 'retryable') return c.json(result.fail('Preview temporarily unavailable', 503), 503);
	return c.json(result.ok(preview.envelope));
});
