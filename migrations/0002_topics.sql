ALTER TABLE sessions ADD COLUMN subject TEXT;
ALTER TABLE sessions ADD COLUMN subtopic TEXT;
CREATE TABLE study_menus (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, message_id INTEGER, choices TEXT NOT NULL, selected INTEGER, applied INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE INDEX study_menus_owner ON study_menus(user_id,active);
