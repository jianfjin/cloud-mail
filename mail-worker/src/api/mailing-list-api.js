import app from '../hono/hono';
import result from '../model/result';
import mailingListService from '../service/mailing-list-service';
import mailingListReportService from '../service/mailing-list-report-service';

app.get('/mailingList/list', async (c) => c.json(result.ok(await mailingListService.list(c, c.req.query()))));
app.get('/mailingList/detail', async (c) => c.json(result.ok(await mailingListService.detail(c, c.req.query('listId')))));
app.post('/mailingList/create', async (c) => c.json(result.ok(await mailingListService.create(c, await c.req.json()))));
app.put('/mailingList/update', async (c) => {
	const body = await c.req.json();
	return c.json(result.ok(await mailingListService.update(c, body.listId, body)));
});
app.get('/mailingList/members', async (c) => c.json(result.ok(await mailingListService.members(c, c.req.query('listId')))));
app.post('/mailingList/member', async (c) => {
	const body = await c.req.json();
	return c.json(result.ok(await mailingListService.addMember(c, body.listId, body.email)));
});
app.delete('/mailingList/member', async (c) => {
	await mailingListService.removeMember(c, c.req.query('listId'), c.req.query('memberId'));
	return c.json(result.ok());
});
app.get('/mailingList/senders', async (c) => c.json(result.ok(await mailingListService.senders(c, c.req.query('listId')))));
app.post('/mailingList/sender', async (c) => {
	const body = await c.req.json();
	return c.json(result.ok(await mailingListService.addSender(c, body.listId, body.email)));
});
app.delete('/mailingList/sender', async (c) => {
	await mailingListService.removeSender(c, c.req.query('listId'), c.req.query('senderId'));
	return c.json(result.ok());
});
app.get('/mailingList/reports', async (c) => c.json(result.ok(await mailingListReportService.reports(c, c.req.query('listId')))));
app.get('/mailingList/report', async (c) => c.json(result.ok(await mailingListReportService.report(c, c.req.query('listId'), c.req.query('postId')))));
app.post('/mailingList/retry', async (c) => {
	const body = await c.req.json();
	return c.json(result.ok(await mailingListReportService.retry(c, body.listId, body.postId)));
});
app.put('/mailingList/state', async (c) => {
	const body = await c.req.json();
	return c.json(result.ok(await mailingListService.setState(c, body.listId, body.state)));
});
