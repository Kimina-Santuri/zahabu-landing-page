-- Mixes: audio uploaded from the Stories editor (comms.zahabu.co.ke) and played in stories through the "Mix" block.
-- The MP3 itself is in the zahabu-mixes R2 bucket at mixes/<id>.mp3, uploaded in parts (R2 multipart) so long mixes and
-- patchy connections work. The editor compresses WAV/AIFF/FLAC/big MP3s to 128 kbps in the browser before uploading.

CREATE TABLE IF NOT EXISTS mixes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  recorded TEXT NOT NULL DEFAULT '',
  artwork_id TEXT,                     -- story_images.id
  original_name TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER,
  bitrate_kbps INTEGER,
  size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  upload_id TEXT,                      -- R2 multipart upload id while uploading
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS mixes_status ON mixes (status, created_at);
