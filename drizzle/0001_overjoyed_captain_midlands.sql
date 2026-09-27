CREATE TABLE `google_drive_connections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`connectionKey` varchar(64) NOT NULL,
	`accountEmail` varchar(320),
	`accessToken` text NOT NULL,
	`refreshToken` text,
	`scope` text,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `google_drive_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `google_drive_connections_connectionKey_unique` UNIQUE(`connectionKey`)
);
