ALTER TABLE work_dates ADD COLUMN event_name TEXT NOT NULL DEFAULT '';
ALTER TABLE work_dates ADD COLUMN work_type TEXT NOT NULL DEFAULT 'Event';
ALTER TABLE work_dates ADD COLUMN status TEXT NOT NULL DEFAULT 'Completed';
ALTER TABLE work_dates ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE work_dates ADD COLUMN approved_by TEXT NOT NULL DEFAULT '';
ALTER TABLE work_dates ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE work_dates ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE work_dates SET created_at = datetime('now'), updated_at = datetime('now') WHERE created_at = '';
