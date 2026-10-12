CREATE TABLE IF NOT EXISTS inventory_items (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	category TEXT NOT NULL DEFAULT '',
	brand TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL DEFAULT '',
	serial_number TEXT NOT NULL DEFAULT '',
	asset_tag TEXT NOT NULL DEFAULT '',
	quantity INTEGER NOT NULL DEFAULT 1,
	location TEXT NOT NULL DEFAULT '',
	condition TEXT NOT NULL DEFAULT 'working',
	last_tested TEXT,
	last_maintained TEXT,
	check_every_days INTEGER,
	notes TEXT NOT NULL DEFAULT '',
	cover_photo_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	updated_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS inventory_items_name_idx ON inventory_items (name);

CREATE TABLE IF NOT EXISTS inventory_photos (
	id TEXT PRIMARY KEY NOT NULL,
	item_id TEXT NOT NULL,
	width INTEGER NOT NULL,
	height INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	created_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS inventory_photos_item_idx ON inventory_photos (item_id, created_at);

-- One row per check, maintenance job, repair, condition change or edit, newest first per item.
CREATE TABLE IF NOT EXISTS inventory_log (
	id TEXT PRIMARY KEY NOT NULL,
	item_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	date TEXT NOT NULL,
	note TEXT NOT NULL DEFAULT '',
	done_by TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_log_item_idx ON inventory_log (item_id, date, created_at);
