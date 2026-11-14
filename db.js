const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgres://localhost/christmas';
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  // Heroku Postgres requires SSL but uses certs node won't verify by default.
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

const SCHEMA = `
-- People are identified by email so "Sign in with Google" can be added later
-- by matching on the same address.
CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE,
  pin_hash          TEXT NOT NULL,
  is_site_admin     BOOLEAN NOT NULL DEFAULT false,
  can_create_groups BOOLEAN NOT NULL DEFAULT false, -- the admin whitelist
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  reset_token       TEXT UNIQUE,
  reset_expires     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  invite_token TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- kind: 'gifts' (claimable items) or 'interests' (one free-form note)
CREATE TABLE IF NOT EXISTS lists (
  id         SERIAL PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'gifts',
  body       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which groups can see which lists.
CREATE TABLE IF NOT EXISTS list_groups (
  list_id  INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, group_id)
);

CREATE TABLE IF NOT EXISTS items (
  id         SERIAL PRIMARY KEY,
  list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  url        TEXT,
  notes      TEXT,
  starred    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One claim per item. Never shown to the item's owner.
CREATE TABLE IF NOT EXISTS claims (
  item_id    INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  claimer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comments on an item or on an interests list. Never shown to the owner,
-- and only shown to people who share a group with the author.
CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE,
  list_id    INTEGER REFERENCES lists(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
CREATE INDEX IF NOT EXISTS lists_owner_idx      ON lists(owner_id);
CREATE INDEX IF NOT EXISTS list_groups_group_idx ON list_groups(group_id);
CREATE INDEX IF NOT EXISTS items_list_idx       ON items(list_id);
CREATE INDEX IF NOT EXISTS comments_item_idx    ON comments(item_id);
CREATE INDEX IF NOT EXISTS comments_list_idx    ON comments(list_id);
`;

async function init() {
  // The first version of the app (single family, no emails) used a different
  // users table. Refuse to start rather than half-migrate it.
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'users'
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'users' AND column_name = 'email')`
  );
  if (rows.length) {
    throw new Error(
      'This database is from the old single-family version. Reset it with ' +
        '`heroku pg:reset DATABASE_URL` (this deletes the old data) and restart.'
    );
  }
  await pool.query(SCHEMA);
}

module.exports = { pool, query: (text, params) => pool.query(text, params), init };
