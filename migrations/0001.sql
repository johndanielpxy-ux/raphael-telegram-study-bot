CREATE TABLE cards (id TEXT PRIMARY KEY, subject TEXT NOT NULL, subtopic TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, source TEXT NOT NULL, state TEXT, due INTEGER NOT NULL DEFAULT 0);
CREATE INDEX cards_due ON cards(due);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, card_id TEXT, position INTEGER NOT NULL DEFAULT 0, seen TEXT NOT NULL DEFAULT '[]', revealed INTEGER NOT NULL DEFAULT 0, message_id INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX one_active_session ON sessions(user_id) WHERE active=1;
CREATE TABLE reviews (update_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL, card_id TEXT NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 4), reviewed_at INTEGER NOT NULL, before_state TEXT, after_state TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id,position));
CREATE TABLE updates (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', failures INTEGER NOT NULL DEFAULT 0);
CREATE TABLE drain_lock (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires INTEGER NOT NULL DEFAULT 0);
INSERT INTO drain_lock(id) VALUES(1);
