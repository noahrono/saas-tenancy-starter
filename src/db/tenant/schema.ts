import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Example tenant-scoped resource. `created_by` is a central user id; Postgres can't enforce it across databases. */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
