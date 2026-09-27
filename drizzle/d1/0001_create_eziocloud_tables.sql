CREATE TABLE IF NOT EXISTS google_drive_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connectionKey TEXT NOT NULL UNIQUE,
  accountEmail TEXT,
  accessToken TEXT NOT NULL,
  refreshToken TEXT,
  scope TEXT,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  notes TEXT,
  createdBy TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS shared_links_category_updated_idx
  ON shared_links (category, updatedAt DESC);
