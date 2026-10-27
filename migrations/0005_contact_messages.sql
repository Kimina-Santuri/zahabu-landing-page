CREATE TABLE IF NOT EXISTS contact_messages (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	email TEXT NOT NULL,
	phone TEXT NOT NULL DEFAULT '',
	reason TEXT NOT NULL,
	event_date TEXT,
	message TEXT NOT NULL,
	ip_hash TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	emailed_at TEXT,
	email_error TEXT
);
CREATE INDEX IF NOT EXISTS contact_messages_ip_idx ON contact_messages (ip_hash, created_at);
