CREATE TABLE card_progress (user_id TEXT NOT NULL, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, state TEXT, due INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,card_id));
CREATE INDEX card_progress_due ON card_progress(user_id,due);
CREATE TABLE friend_access (slot INTEGER PRIMARY KEY CHECK(slot=1), user_id TEXT NOT NULL UNIQUE, added_at INTEGER NOT NULL);
