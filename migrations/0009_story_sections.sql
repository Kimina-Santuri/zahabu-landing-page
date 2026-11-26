-- Story sections (like Substack sections): each story can sit in one. Managed by staff in the editor's Sections tab.
-- The slug is set when a section is created and kept when it's renamed, so section links don't break.

CREATE TABLE IF NOT EXISTS story_sections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

ALTER TABLE stories ADD COLUMN section_id TEXT;
CREATE INDEX IF NOT EXISTS stories_section ON stories (section_id, status, published_at);

INSERT OR IGNORE INTO story_sections (id, slug, name, description, position, created_at) VALUES
  ('sec-news', 'news', 'News', 'Announcements: new nights, openings and changes at the garden.', 1, '2026-11-26T00:00:00.000Z'),
  ('sec-features', 'features', 'Features', 'Longer pieces about the garden, the artists, the food and the culture around Zahabu.', 2, '2026-11-26T00:00:00.000Z'),
  ('sec-interviews', 'interviews', 'Interviews', 'Conversations with the DJs, artists, vendors and team who make Zahabu.', 3, '2026-11-26T00:00:00.000Z'),
  ('sec-mixes', 'mixes-and-music', 'Mixes & music', 'Recorded sets, playlists and residents'' mixes.', 4, '2026-11-26T00:00:00.000Z');
