CREATE TABLE book (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  title TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'ja'
);
INSERT INTO book (id, title) VALUES (1, '自然言語処理の基礎');

CREATE TABLE sections (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT REFERENCES sections(id),
  kind TEXT NOT NULL CHECK (kind IN ('chapter','section','subsection','exercises','symbols','bibliography','frontmatter')),
  number TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  body TEXT NOT NULL DEFAULT '',
  print_from INTEGER,
  print_to INTEGER,
  print_label TEXT,
  source_file TEXT,
  source_from INTEGER,
  source_to INTEGER,
  status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','draft','review','verified')),
  published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0,1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  action TEXT NOT NULL DEFAULT 'create',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (print_to IS NULL OR (print_from IS NOT NULL AND print_to >= print_from)),
  CHECK (source_to IS NULL OR (source_from IS NOT NULL AND source_to >= source_from)),
  CHECK (status <> 'missing' OR length(body) = 0)
);
CREATE INDEX sections_tree ON sections(parent_id, position, id);

CREATE TABLE revisions (
  section_id TEXT NOT NULL REFERENCES sections(id),
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (section_id, revision)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  section_id TEXT NOT NULL REFERENCES sections(id),
  mime TEXT NOT NULL CHECK (mime IN ('image/webp','image/png','image/jpeg')),
  caption TEXT NOT NULL,
  alt TEXT NOT NULL,
  source_file TEXT,
  source_page INTEGER,
  print_page INTEGER,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1500000),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX assets_section ON assets(section_id, deleted, id);
CREATE TABLE asset_chunks (
  asset_id TEXT NOT NULL REFERENCES assets(id),
  part INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (asset_id, part)
);

CREATE TABLE content_stamp (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO content_stamp (id) VALUES (1);

CREATE TABLE viewer_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0,
  salt TEXT,
  verifier TEXT,
  updated_at INTEGER
);
INSERT INTO viewer_settings (id) VALUES (1);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','admin')),
  generation INTEGER,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires);

CREATE TABLE auth_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX auth_limits_expiry ON auth_limits(expires);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  challenge TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires);

CREATE VIEW visible_sections AS
WITH RECURSIVE visible(id) AS (
  SELECT id FROM sections WHERE parent_id IS NULL AND published = 1 AND deleted = 0
  UNION ALL
  SELECT s.id FROM sections s JOIN visible v ON v.id = s.parent_id
  WHERE s.published = 1 AND s.deleted = 0
)
SELECT id FROM visible;

CREATE VIRTUAL TABLE search_index USING fts5(title, body, content='sections', content_rowid='rowid', tokenize='trigram');

CREATE VIEW section_snapshots AS
SELECT id, revision, updated_at, action, json_object(
  'id', id, 'parent_id', parent_id, 'kind', kind, 'number', number, 'title', title, 'position', position,
  'body', body, 'print_from', print_from, 'print_to', print_to, 'print_label', print_label,
  'source_file', source_file, 'source_from', source_from, 'source_to', source_to, 'status', status,
  'published', published, 'deleted', deleted, 'revision', revision, 'created_at', created_at, 'updated_at', updated_at
) AS snapshot FROM sections;

CREATE TRIGGER section_insert AFTER INSERT ON sections BEGIN
  INSERT INTO revisions SELECT id, revision, updated_at, action, snapshot FROM section_snapshots WHERE id = NEW.id;
  INSERT INTO search_index(rowid, title, body) VALUES (NEW.rowid, NEW.title, NEW.body);
  UPDATE content_stamp SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER section_changed AFTER UPDATE ON sections BEGIN
  INSERT INTO revisions SELECT id, revision, updated_at, action, snapshot FROM section_snapshots WHERE id = NEW.id;
  INSERT INTO search_index(search_index, rowid, title, body) VALUES ('delete', OLD.rowid, OLD.title, OLD.body);
  INSERT INTO search_index(rowid, title, body) VALUES (NEW.rowid, NEW.title, NEW.body);
  UPDATE content_stamp SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER asset_insert AFTER INSERT ON assets BEGIN
  UPDATE content_stamp SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER asset_changed AFTER UPDATE ON assets BEGIN
  UPDATE content_stamp SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER book_changed AFTER UPDATE ON book BEGIN
  UPDATE content_stamp SET version = version + 1 WHERE id = 1;
END;
