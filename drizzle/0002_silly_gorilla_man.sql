CREATE TABLE `shared_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(160) NOT NULL,
	`url` varchar(2048) NOT NULL,
	`category` varchar(48) NOT NULL DEFAULT 'General',
	`notes` text,
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shared_links_id` PRIMARY KEY(`id`)
);
