-- Stories: articles written by the comms team at photos.zahabu.co.ke/admin/stories and published at zahabu.co.ke/stories,
-- plus newsletter subscribers (double opt-in, then synced to a Brevo list that the newsletter is sent to).

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,                    -- set on first publish (from the title unless staff typed one)
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  cover_id TEXT,                       -- story_images.id
  cover_alt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '[]',     -- JSON blocks, validated by stories.mjs (never raw HTML)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  newsletter_sent_at TEXT,             -- claimed before calling Brevo, so a story is never sent twice
  newsletter_sent_by TEXT,
  newsletter_campaign_id TEXT,
  newsletter_error TEXT
);
CREATE INDEX IF NOT EXISTS stories_published ON stories (status, published_at);

CREATE TABLE IF NOT EXISTS story_images (
  id TEXT PRIMARY KEY,                 -- R2: stories/<id>-1600.jpg and stories/<id>-800.jpg
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,          -- stored lower-case
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  token TEXT NOT NULL,                 -- confirmation link token
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  ip_hash TEXT,
  source TEXT NOT NULL DEFAULT 'website',
  brevo_synced_at TEXT,
  brevo_error TEXT
);
CREATE INDEX IF NOT EXISTS subscribers_ip ON subscribers (ip_hash, created_at);
