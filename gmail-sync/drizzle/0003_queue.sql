CREATE TABLE `queue` (
	`id` integer PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`source` text NOT NULL,
	`enqueued_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_message_id_unique` ON `queue` (`message_id`);