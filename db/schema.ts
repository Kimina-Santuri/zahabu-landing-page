import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const workDates = sqliteTable('work_dates', {
  id: text('id').primaryKey(),
  date: text('date').notNull().unique(),
  lead: text('lead').notNull(),
  supports: text('supports').notNull(),
});
