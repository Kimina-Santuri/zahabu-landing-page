import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
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
export const communityPhotos = sqliteTable('community_photos', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('pending'),
  credit: text('credit').notNull().default(''),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  ipHash: text('ip_hash').notNull().default(''),
  createdAt: text('created_at').notNull(),
  reviewedAt: text('reviewed_at'),
  reviewedBy: text('reviewed_by'),
});
