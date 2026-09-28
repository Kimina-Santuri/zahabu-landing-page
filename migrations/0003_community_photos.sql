CREATE TABLE IF NOT EXISTS community_photos (
	id TEXT PRIMARY KEY NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	credit TEXT NOT NULL DEFAULT '',
	width INTEGER NOT NULL,
	height INTEGER NOT NULL,
	ip_hash TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	reviewed_at TEXT,
	reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS community_photos_status_idx ON community_photos (status, reviewed_at);
CREATE INDEX IF NOT EXISTS community_photos_ip_idx ON community_photos (ip_hash, created_at);
