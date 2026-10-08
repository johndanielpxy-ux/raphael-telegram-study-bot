ALTER TABLE cards ADD COLUMN learning_order INTEGER NOT NULL DEFAULT 0 CHECK(learning_order >= 0);
