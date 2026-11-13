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
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  pin_hash   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lists (
  id         SERIAL PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- Secret comments on an item. Never shown to the item's owner.
CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lists_owner_idx   ON lists(owner_id);
CREATE INDEX IF NOT EXISTS items_list_idx    ON items(list_id);
CREATE INDEX IF NOT EXISTS comments_item_idx ON comments(item_id);
`;

async function init(memberNames) {
  await pool.query(SCHEMA);
  for (const name of memberNames) {
    const { rows } = await pool.query(
      `INSERT INTO users (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING RETURNING id`,
      [name]
    );
    // Give every new person a starter list so their page isn't empty.
    if (rows[0]) {
      await pool.query(`INSERT INTO lists (owner_id, title) VALUES ($1, 'My Wish List')`, [rows[0].id]);
    }
  }
}

module.exports = { pool, query: (text, params) => pool.query(text, params), init };
