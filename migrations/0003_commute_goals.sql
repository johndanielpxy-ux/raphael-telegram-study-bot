ALTER TABLE sessions ADD COLUMN goal INTEGER NOT NULL DEFAULT 10 CHECK(goal IN (5,10));
CREATE TABLE rewards (review_id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, card_id TEXT NOT NULL, day TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 10 CHECK(xp=10), UNIQUE(user_id,day,card_id));
CREATE INDEX rewards_user_day ON rewards(user_id,day);
CREATE TABLE study_preferences (user_id TEXT PRIMARY KEY, weekly_goal INTEGER NOT NULL DEFAULT 4 CHECK(weekly_goal BETWEEN 1 AND 7));
