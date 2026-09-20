import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const workDates = sqliteTable('work_dates', {
  id: text('id').primaryKey(),
  date: text('date').notNull().unique(),
  lead: text('lead').notNull(),
  supports: text('supports').notNull(),
  eventName: text('event_name').notNull().default(''),
  workType: text('work_type').notNull().default('Event'),
  status: text('status').notNull().default('Completed'),
  notes: text('notes').notNull().default(''),
  approvedBy: text('approved_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
