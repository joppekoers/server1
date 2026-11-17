CREATE TABLE `email_extractions` (
	`email_id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`result` text,
	`extracted_at` text NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action
);
