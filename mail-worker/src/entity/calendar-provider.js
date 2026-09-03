import {integer, sqliteTable, text, uniqueIndex} from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';

export const calendarProvider = sqliteTable('calendar_provider', {
	providerId: integer('provider_id').primaryKey({autoIncrement: true}),
	host: text('host').notNull(),
	label: text('label').notNull(),
	enabled: integer('enabled').notNull().default(1),
	createdByUserId: integer('created_by_user_id').notNull().default(0),
	updatedByUserId: integer('updated_by_user_id').notNull().default(0),
	createTime: text('create_time').notNull().default(sql`CURRENT_TIMESTAMP`),
	updateTime: text('update_time').notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => ({
	host: uniqueIndex('idx_calendar_provider_host_nocase').on(table.host),
}));

export default calendarProvider;
