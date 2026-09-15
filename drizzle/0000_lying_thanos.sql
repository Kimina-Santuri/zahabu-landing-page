CREATE TABLE `work_dates` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`lead` text NOT NULL,
	`supports` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_dates_date_unique` ON `work_dates` (`date`);