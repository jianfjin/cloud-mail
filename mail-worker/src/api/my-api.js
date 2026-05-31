import app from '../hono/hono';
import userService from '../service/user-service';
import result from '../model/result';
import userContext from '../security/user-context';

app.get('/my/loginUserInfo', async (c) => {
	const user = await userService.loginUserInfo(c, userContext.getUserId(c));
	return c.json(result.ok(user));
});

app.put('/my/resetPassword', async (c) => {
	await userService.resetPassword(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/my/delete', async (c) => {
	await userService.delete(c, userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/my/signature', async (c) => {
	const userId = userContext.getUserId(c);
	const userRow = await userService.selectById(c, userId);
	return c.json(result.ok({ signature: userRow.signature || '' }));
});

app.put('/my/signature', async (c) => {
	const userId = userContext.getUserId(c);
	const { signature } = await c.req.json();
	await userService.setSignature(c, userId, signature || '');
	return c.json(result.ok());
});


