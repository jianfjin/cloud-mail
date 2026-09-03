import { getTableColumns, sql } from 'drizzle-orm';
import email from '../entity/email';

export const EMAIL_LIST_TEXT_LEN = 300;

/** 去掉换行/回车/制表符，并压缩连续空格、标签间空白 */
function sqlStripWhitespace(column) {
	return sql`trim(replace(replace(replace(replace(replace(replace(
		coalesce(${column}, ''),
		char(13), ''),
		char(10), ''),
		char(9), ' '),
		'  ', ' '),
		'  ', ' '),
		'> <', '><'))`;
}

const { calendarData, ...publicEmailColumns } = getTableColumns(email);
const hasCalendar = sql`CASE WHEN ${calendarData} IS NULL THEN 0 ELSE 1 END`.mapWith(Number).as('has_calendar');

/** 完整查询：排除内部日历数据，只暴露无敏感信息的存在标记 */
export const emailListColumns = {
	...publicEmailColumns,
	hasCalendar,
};

/** 摘要查询：列表 + 详情头部；有 text 则不读 content，没有才查 content（去空白），响应里不返回 content */
export const emailBriefColumns = {
	emailId: email.emailId,
	sendEmail: email.sendEmail,
	name: email.name,
	subject: email.subject,
	code: email.code,
	recipient: email.recipient,
	toEmail: email.toEmail,
	type: email.type,
	status: email.status,
	message: email.message,
	unread: email.unread,
	createTime: email.createTime,
	isDel: email.isDel,
	hasCalendar,
	content: sql`CASE WHEN trim(coalesce(${email.text}, '')) != '' THEN NULL ELSE ${sqlStripWhitespace(email.content)} END`.as('content'),
	text: sql`substr(coalesce(${email.text}, ''), 1, ${EMAIL_LIST_TEXT_LEN})`.as('text'),
};
