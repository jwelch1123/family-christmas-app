const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

const FAMILY_CODE = process.env.FAMILY_CODE || 'christmas';
const isProd = process.env.NODE_ENV === 'production';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // Heroku terminates TLS at its router

app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(
  cookieSession({
    name: 'gifts',
    secret: process.env.SESSION_SECRET || 'dev-only-secret',
    maxAge: 365 * 24 * 60 * 60 * 1000, // stay logged in on your phone
    sameSite: 'lax', // blocks cross-site form posts (CSRF)
    httpOnly: true,
    secure: isProd,
  })
);

// ---------- helpers ----------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clean(str, max = 500) {
  return String(str || '').trim().slice(0, max);
}

// Only allow http(s) links so nobody can sneak in javascript: URLs.
function cleanUrl(str) {
  let url = clean(str, 2000);
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

app.use((req, res, next) => {
  res.locals.me = null;
  res.locals.hostOf = hostOf;
  res.locals.flash = req.session.flash || null;
  if (req.session) req.session.flash = null;
  next();
});

const requireLogin = wrap(async (req, res, next) => {
  const id = req.session.userId;
  if (!id) return res.redirect('/login');
  const { rows } = await db.query('SELECT id, name FROM users WHERE id = $1', [id]);
  if (!rows[0]) {
    req.session = null;
    return res.redirect('/login');
  }
  req.me = res.locals.me = rows[0];
  next();
});

// Load an item along with who owns it.
async function loadItem(itemId) {
  const { rows } = await db.query(
    `SELECT i.*, l.owner_id FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = $1`,
    [itemId]
  );
  return rows[0] || null;
}

function notFound(res) {
  return res.status(404).render('error', { message: "That doesn't exist anymore." });
}

// ---------- login ----------

const failedAttempts = new Map(); // userId -> { count, until }

app.get('/login', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT id, name, pin_hash IS NOT NULL AS has_pin FROM users ORDER BY name');
  res.render('login', { users: rows, error: null, selected: null });
}));

app.post('/login', wrap(async (req, res) => {
  const { rows: users } = await db.query('SELECT id, name, pin_hash IS NOT NULL AS has_pin FROM users ORDER BY name');
  const userId = parseInt(req.body.user_id, 10);
  const pin = clean(req.body.pin, 20);
  const fail = (error) => res.status(400).render('login', { users, error, selected: userId });

  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) return fail('Pick your name.');

  const lock = failedAttempts.get(user.id);
  if (lock && lock.until > Date.now()) return fail('Too many tries. Wait a few minutes and try again.');

  if (!user.pin_hash) {
    // First time: set a PIN, gated by the family code so strangers can't grab a name.
    if (clean(req.body.family_code, 100).toLowerCase() !== FAMILY_CODE.toLowerCase()) {
      return fail('That family code is not right.');
    }
    if (!/^\d{4,8}$/.test(pin)) return fail('Choose a PIN of 4 to 8 digits.');
    if (pin !== clean(req.body.pin_confirm, 20)) return fail("The two PINs don't match.");
    await db.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [await bcrypt.hash(pin, 10), user.id]);
  } else if (!(await bcrypt.compare(pin, user.pin_hash))) {
    const count = (lock?.count || 0) + 1;
    failedAttempts.set(user.id, { count, until: count >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
    return fail('Wrong PIN.');
  }

  failedAttempts.delete(user.id);
  req.session.userId = user.id;
  res.redirect('/');
}));

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ---------- pages ----------

app.get('/', requireLogin, wrap(async (req, res) => {
  // Claim counts only for OTHER people's lists, so you never learn about your own.
  const { rows: people } = await db.query(
    `SELECT u.id, u.name,
            COUNT(i.id)::int AS item_count,
            CASE WHEN u.id = $1 THEN NULL ELSE COUNT(c.item_id)::int END AS claimed_count
       FROM users u
       LEFT JOIN lists l ON l.owner_id = u.id
       LEFT JOIN items i ON i.list_id = l.id
       LEFT JOIN claims c ON c.item_id = i.id
      GROUP BY u.id
      ORDER BY (u.id = $1) DESC, u.name`,
    [req.me.id]
  );
  const { rows: myClaims } = await db.query(
    `SELECT i.id, i.title, i.url, u.id AS owner_id, u.name AS owner_name
       FROM claims c
       JOIN items i ON i.id = c.item_id
       JOIN lists l ON l.id = i.list_id
       JOIN users u ON u.id = l.owner_id
      WHERE c.claimer_id = $1
      ORDER BY u.name, i.title`,
    [req.me.id]
  );
  res.render('home', { people, myClaims });
}));

app.get('/u/:id', requireLogin, wrap(async (req, res) => {
  const { rows: [person] } = await db.query('SELECT id, name FROM users WHERE id = $1', [req.params.id]);
  if (!person) return notFound(res);
  const isOwner = person.id === req.me.id;

  const { rows: lists } = await db.query(
    'SELECT * FROM lists WHERE owner_id = $1 ORDER BY created_at, id',
    [person.id]
  );
  const { rows: items } = await db.query(
    `SELECT i.* FROM items i JOIN lists l ON l.id = i.list_id
      WHERE l.owner_id = $1 ORDER BY i.starred DESC, i.created_at, i.id`,
    [person.id]
  );

  // The important part: claims & comments are never even queried for the owner.
  let claims = new Map();
  let comments = new Map();
  if (!isOwner && items.length) {
    const ids = items.map((i) => i.id);
    const { rows: c } = await db.query(
      `SELECT c.item_id, c.claimer_id, u.name AS claimer_name
         FROM claims c JOIN users u ON u.id = c.claimer_id WHERE c.item_id = ANY($1)`,
      [ids]
    );
    claims = new Map(c.map((r) => [r.item_id, r]));
    const { rows: cm } = await db.query(
      `SELECT c.*, u.name AS author_name
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.item_id = ANY($1) ORDER BY c.created_at`,
      [ids]
    );
    for (const row of cm) {
      if (!comments.has(row.item_id)) comments.set(row.item_id, []);
      comments.get(row.item_id).push(row);
    }
  }

  for (const list of lists) {
    list.items = items
      .filter((i) => i.list_id === list.id)
      .map((i) => ({ ...i, claim: claims.get(i.id) || null, comments: comments.get(i.id) || [] }));
  }

  res.render('person', { person, lists, isOwner });
}));

// ---------- owner actions: lists ----------

async function ownList(req, res) {
  const { rows } = await db.query('SELECT * FROM lists WHERE id = $1', [req.params.id]);
  const list = rows[0];
  if (!list) { notFound(res); return null; }
  if (list.owner_id !== req.me.id) { res.status(403).render('error', { message: "That's not your list." }); return null; }
  return list;
}

app.post('/lists', requireLogin, wrap(async (req, res) => {
  const title = clean(req.body.title, 80) || 'New List';
  const { rows } = await db.query('INSERT INTO lists (owner_id, title) VALUES ($1, $2) RETURNING id', [req.me.id, title]);
  res.redirect(`/u/${req.me.id}#list-${rows[0].id}`);
}));

app.post('/lists/:id/rename', requireLogin, wrap(async (req, res) => {
  const list = await ownList(req, res);
  if (!list) return;
  const title = clean(req.body.title, 80);
  if (title) await db.query('UPDATE lists SET title = $1 WHERE id = $2', [title, list.id]);
  res.redirect(`/u/${req.me.id}#list-${list.id}`);
}));

app.post('/lists/:id/delete', requireLogin, wrap(async (req, res) => {
  const list = await ownList(req, res);
  if (!list) return;
  await db.query('DELETE FROM lists WHERE id = $1', [list.id]);
  res.redirect(`/u/${req.me.id}`);
}));

// ---------- owner actions: items ----------

app.post('/lists/:id/items', requireLogin, wrap(async (req, res) => {
  const list = await ownList(req, res);
  if (!list) return;
  const title = clean(req.body.title, 200);
  const url = cleanUrl(req.body.url);
  if (!title && !url) return res.redirect(`/u/${req.me.id}#list-${list.id}`);
  const { rows } = await db.query(
    'INSERT INTO items (list_id, title, url, notes) VALUES ($1, $2, $3, $4) RETURNING id',
    [list.id, title || hostOf(url), url, clean(req.body.notes, 1000) || null]
  );
  res.redirect(`/u/${req.me.id}#item-${rows[0].id}`);
}));

async function ownItem(req, res) {
  const item = await loadItem(req.params.id);
  if (!item) { notFound(res); return null; }
  if (item.owner_id !== req.me.id) { res.status(403).render('error', { message: "That's not your item." }); return null; }
  return item;
}

app.post('/items/:id/edit', requireLogin, wrap(async (req, res) => {
  const item = await ownItem(req, res);
  if (!item) return;
  const url = cleanUrl(req.body.url);
  const title = clean(req.body.title, 200) || (url ? hostOf(url) : item.title);
  await db.query('UPDATE items SET title = $1, url = $2, notes = $3 WHERE id = $4', [
    title, url, clean(req.body.notes, 1000) || null, item.id,
  ]);
  res.redirect(`/u/${req.me.id}#item-${item.id}`);
}));

app.post('/items/:id/star', requireLogin, wrap(async (req, res) => {
  const item = await ownItem(req, res);
  if (!item) return;
  await db.query('UPDATE items SET starred = NOT starred WHERE id = $1', [item.id]);
  res.redirect(`/u/${req.me.id}#item-${item.id}`);
}));

app.post('/items/:id/delete', requireLogin, wrap(async (req, res) => {
  const item = await ownItem(req, res);
  if (!item) return;
  await db.query('DELETE FROM items WHERE id = $1', [item.id]);
  res.redirect(`/u/${req.me.id}#list-${item.list_id}`);
}));

// ---------- everyone-else actions: claims & comments ----------

async function othersItem(req, res) {
  const item = await loadItem(req.params.id);
  if (!item) { notFound(res); return null; }
  if (item.owner_id === req.me.id) { res.status(403).render('error', { message: 'No peeking at your own gifts!' }); return null; }
  return item;
}

app.post('/items/:id/claim', requireLogin, wrap(async (req, res) => {
  const item = await othersItem(req, res);
  if (!item) return;
  const { rowCount } = await db.query(
    'INSERT INTO claims (item_id, claimer_id) VALUES ($1, $2) ON CONFLICT (item_id) DO NOTHING',
    [item.id, req.me.id]
  );
  if (!rowCount) req.session.flash = 'Someone else already claimed that one.';
  res.redirect(`/u/${item.owner_id}#item-${item.id}`);
}));

app.post('/items/:id/unclaim', requireLogin, wrap(async (req, res) => {
  const item = await othersItem(req, res);
  if (!item) return;
  await db.query('DELETE FROM claims WHERE item_id = $1 AND claimer_id = $2', [item.id, req.me.id]);
  if (req.body.from === 'home') return res.redirect('/');
  res.redirect(`/u/${item.owner_id}#item-${item.id}`);
}));

app.post('/items/:id/comments', requireLogin, wrap(async (req, res) => {
  const item = await othersItem(req, res);
  if (!item) return;
  const body = clean(req.body.body, 1000);
  if (body) await db.query('INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, $3)', [item.id, req.me.id, body]);
  res.redirect(`/u/${item.owner_id}#item-${item.id}`);
}));

app.post('/comments/:id/delete', requireLogin, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, l.owner_id FROM comments c JOIN items i ON i.id = c.item_id
       JOIN lists l ON l.id = i.list_id WHERE c.id = $1`,
    [req.params.id]
  );
  const c = rows[0];
  if (!c) return notFound(res);
  if (c.author_id !== req.me.id) return res.status(403).render('error', { message: 'You can only delete your own comments.' });
  await db.query('DELETE FROM comments WHERE id = $1', [c.id]);
  res.redirect(`/u/${c.owner_id}#item-${c.item_id}`);
}));

// ---------- errors ----------

app.use((req, res) => notFound(res));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Something went wrong. Try again?' });
});

module.exports = { app, cleanUrl };
