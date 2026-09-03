import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import calendarProviderService from '../service/calendar-provider-service';
import calendarResponseService from '../service/calendar-response-service';

async function requestBody(c) {
	const body = await c.req.json().catch(() => null);
	if (!body || Array.isArray(body)) {
		return null;
	}
	return body;
}

app.post('/email/calendar-response/eligibility', async (c) => {
	const body = await requestBody(c);
	if (!body) return c.json(result.fail('Invalid request', 400), 400);
	const eligibility = await calendarResponseService.eligibility(c, body, userContext.getUserId(c));
	return c.json(result.ok(eligibility));
});

app.post('/email/calendar-response', async (c) => {
	const body = await requestBody(c);
	if (!body) return c.json(result.fail('Invalid request', 400), 400);
	const response = await calendarResponseService.respond(c, body, userContext.getUserId(c));
	return c.json(result.ok(response));
});

app.post('/email/calendar-response/retry', async (c) => {
	const body = await requestBody(c);
	if (!body) return c.json(result.fail('Invalid request', 400), 400);
	const response = await calendarResponseService.retry(c, body, userContext.getUserId(c));
	return c.json(result.ok(response));
});

app.get('/calendar/providers', async (c) => {
	return c.json(result.ok(await calendarProviderService.list(c)));
});

app.post('/calendar/providers', async (c) => {
	const body = await requestBody(c);
	if (!body) return c.json(result.fail('Invalid request', 400), 400);
	const provider = await calendarProviderService.create(c, body, userContext.getUserId(c));
	return c.json(result.ok(provider));
});

app.put('/calendar/providers/:providerId', async (c) => {
	const body = await requestBody(c);
	if (!body) return c.json(result.fail('Invalid request', 400), 400);
	const provider = await calendarProviderService.update(c, c.req.param('providerId'), body, userContext.getUserId(c));
	return c.json(result.ok(provider));
});
