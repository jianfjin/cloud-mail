import app from '../hono/hono';
import result from '../model/result';
import mailingListService from '../service/mailing-list-service';

app.get('/mailingList/list', async (c) => c.json(result.ok(await mailingListService.list(c, c.req.query()))));
app.get('/mailingList/detail', async (c) => c.json(result.ok(await mailingListService.detail(c, c.req.query('listId')))));
app.post('/mailingList/create', async (c) => c.json(result.ok(await mailingListService.create(c, await c.req.json()))));
app.get('/mailingList/members', async (c) => c.json(result.ok(await mailingListService.members(c, c.req.query('listId')))));
app.post('/mailingList/member', async (c) => {
	const body = await c.req.json();
	return c.json(result.ok(await mailingListService.addMember(c, body.listId, body.email)));
});
app.delete('/mailingList/member', async (c) => {
	await mailingListService.removeMember(c, c.req.query('listId'), c.req.query('memberId'));
	return c.json(result.ok());
});
app.put('/mailingList/state', async (c) => {
	const body = await c.req.json();
	return c.json(result.ok(await mailingListService.setState(c, body.listId, body.state)));
});
