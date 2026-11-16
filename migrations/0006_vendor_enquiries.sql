-- Vendor enquiries from vendors.html (food & drink stalls, market stalls, sponsors).
-- Photos live in the community photos R2 bucket under vendors/<id>/<n>.jpg and are only served under /admin.
CREATE TABLE IF NOT EXISTS vendor_enquiries (
	id TEXT PRIMARY KEY NOT NULL,
	vendor_type TEXT NOT NULL,
	business TEXT NOT NULL,
	name TEXT NOT NULL,
	email TEXT NOT NULL,
	phone TEXT NOT NULL,
	links TEXT NOT NULL DEFAULT '',
	nights TEXT NOT NULL DEFAULT '',
	power TEXT NOT NULL DEFAULT '',
	message TEXT NOT NULL,
	photo_count INTEGER NOT NULL DEFAULT 0,
	ip_hash TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	emailed_at TEXT,
	email_error TEXT
);
CREATE INDEX IF NOT EXISTS vendor_enquiries_ip_idx ON vendor_enquiries (ip_hash, created_at);
