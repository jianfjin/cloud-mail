import {index, integer, sqliteTable, text, uniqueIndex} from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';

export const calendarResponse = sqliteTable('calendar_response', {
	responseId: integer('response_id').primaryKey({autoIncrement: true}),
	emailId: integer('email_id').notNull(),
	eventUid: text('event_uid').notNull(),
	recurrenceId: text('recurrence_id').notNull().default(''),
	accountId: integer('account_id').notNull(),
	userId: integer('user_id').notNull(),
	participationStatus: text('participation_status').notNull(),
	organizer: text('organizer').notNull(),
	deliveryState: text('delivery_state').notNull().default('dispatching'),
	providerReceipt: text('provider_receipt').notNull().default(''),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`),
	updateTime: text('update_time').notNull().default(sql`CURRENT_TIMESTAMP`),
	dispatchedTime: text('dispatched_time'),
	deliveredTime: text('delivered_time'),
}, table => ({
	identity: uniqueIndex('idx_calendar_response_identity').on(
		table.emailId,
		table.eventUid,
		table.recurrenceId,
		table.accountId,
		table.participationStatus,
	),
	email: index('idx_calendar_response_email').on(table.emailId),
	userState: index('idx_calendar_response_user_state').on(table.userId, table.deliveryState),
}));

export default calendarResponse;
