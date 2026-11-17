CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`received_at` text NOT NULL,
	`from_address` text,
	`to_address` text,
	`cc` text,
	`subject` text,
	`snippet` text,
	`text` text NOT NULL,
	`html` text NOT NULL,
	`label_ids` text NOT NULL,
	`attachments` text NOT NULL,
	`headers` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logs_at` ON `logs` (`at`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`order_id` integer NOT NULL,
	`email_id` text NOT NULL,
	`status` text,
	`at` text NOT NULL,
	`subject` text,
	PRIMARY KEY(`order_id`, `email_id`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY NOT NULL,
	`merchant` text,
	`order_number` text,
	`order_number_key` text,
	`status` text,
	`items` text NOT NULL,
	`carrier` text,
	`tracking_number` text,
	`tracking_number_key` text,
	`tracking_url` text,
	`estimated_delivery` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `orders_order_number_key` ON `orders` (`order_number_key`);--> statement-breakpoint
CREATE INDEX `orders_tracking_number_key` ON `orders` (`tracking_number_key`);