const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { wrap, clean, idList, render404 } = require('../lib/util');
const { authenticate, checkSignup, checkPin, hashPin, createUser, requireLogin } = require('../lib/auth');
const { membership } = require('../lib/access');

const router = express.Router();
const SETUP_CODE = process.env.SETUP_CODE || (process.env.NODE_ENV === 'production' ? null : 'setup');

const userCount = async () => (await db.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;

// ---------- log in / out ----------

router.get('/login', wrap(async (req, res) => {
  if (req.session.userId) return res.redirect('/');
  if ((await userCount()) === 0) return res.redirect('/setup');
  res.render('login', { error: null, email: '' });
}));

router.post('/login', wrap(async (req, res) => {
  const { user, error } = await authenticate(req.body.email, req.body.pin);
  if (error) return res.status(400).render('login', { error, email: clean(req.body.email, 200) });
  req.session.userId = user.id;
  res.redirect('/');
}));

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ---------- first account (becomes the site admin) ----------

router.get('/setup', wrap(async (req, res) => {
  if ((await userCount()) > 0) return res.redirect('/login');
  res.render('setup', { error: null, form: {}, configured: !!SETUP_CODE });
}));

router.post('/setup', wrap(async (req, res) => {
  if ((await userCount()) > 0) return res.redirect('/login');
  const fail = (error) => res.status(400).render('setup', { error, form: req.body, configured: !!SETUP_CODE });
  if (!SETUP_CODE || clean(req.body.setup_code, 200) !== SETUP_CODE) return fail('That setup code is not right.');
  const data = checkSignup(req.body);
  if (data.error) return fail(data.error);
  const user = await createUser(data, { siteAdmin: true });
  req.session.userId = user.id;
  res.redirect('/');
}));

// ---------- invite links ----------

async function groupByToken(token) {
  const { rows } = await db.query('SELECT * FROM groups WHERE invite_token = $1', [token]);
  return rows[0] || null;
}

async function renderJoin(req, res, group, extra = {}) {
  const loggedIn = !!req.session.userId;
  let lists = [];
  let me = null;
  if (loggedIn) {
    me = (await db.query('SELECT id, name, email, is_site_admin FROM users WHERE id = $1', [req.session.userId])).rows[0];
    if (!me) { req.session = null; return res.redirect(req.originalUrl); }
    res.locals.me = me;
    if (await membership(group.id, me.id)) {
      req.session.flash = `You're already in ${group.name}.`;
      return res.redirect(`/#group-${group.id}`);
    }
    lists = (await db.query('SELECT id, title, kind FROM lists WHERE owner_id = $1 ORDER BY created_at, id', [me.id])).rows;
  }
  const { rows: [{ n }] } = await db.query('SELECT COUNT(*)::int AS n FROM memberships WHERE group_id = $1', [group.id]);
  res.status(extra.error ? 400 : 200).render('join', {
    group, memberCount: n, loggedIn, lists, error: null, form: {}, tab: 'new', ...extra,
  });
}

router.get('/join/:token', wrap(async (req, res) => {
  const group = await groupByToken(req.params.token);
  if (!group) return render404(res, 'That invite link isn’t valid anymore. Ask for a new one.');
  await renderJoin(req, res, group);
}));

router.post('/join/:token/signup', wrap(async (req, res) => {
  const group = await groupByToken(req.params.token);
  if (!group) return render404(res, 'That invite link isn’t valid anymore. Ask for a new one.');
  const data = checkSignup(req.body);
  if (data.error) return renderJoin(req, res, group, { error: data.error, form: req.body, tab: 'new' });
  const user = await createUser(data);
  if (!user) {
    return renderJoin(req, res, group, {
      error: 'There’s already an account with that email. Log in instead.', form: req.body, tab: 'existing',
    });
  }
  req.session.userId = user.id;
  res.redirect(`/join/${group.invite_token}`);
}));

router.post('/join/:token/login', wrap(async (req, res) => {
  const group = await groupByToken(req.params.token);
  if (!group) return render404(res, 'That invite link isn’t valid anymore. Ask for a new one.');
  const { user, error } = await authenticate(req.body.email, req.body.pin);
  if (error) return renderJoin(req, res, group, { error, form: req.body, tab: 'existing' });
  req.session.userId = user.id;
  res.redirect(`/join/${group.invite_token}`);
}));

router.post('/join/:token', requireLogin, wrap(async (req, res) => {
  const group = await groupByToken(req.params.token);
  if (!group) return render404(res, 'That invite link isn’t valid anymore. Ask for a new one.');
  await db.query(
    'INSERT INTO memberships (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [group.id, req.me.id]
  );
  // Share the lists they ticked (only ones they own).
  await db.query(
    `INSERT INTO list_groups (list_id, group_id)
     SELECT id, $1 FROM lists WHERE owner_id = $2 AND id = ANY($3)
     ON CONFLICT DO NOTHING`,
    [group.id, req.me.id, idList(req.body.list_ids)]
  );
  req.session.flash = `Welcome to ${group.name}! 🎄`;
  res.redirect(`/#group-${group.id}`);
}));

// ---------- PIN reset links (made by the site admin) ----------

async function userByResetToken(token) {
  const { rows } = await db.query('SELECT * FROM users WHERE reset_token = $1 AND reset_expires > now()', [token]);
  return rows[0] || null;
}

router.get('/reset/:token', wrap(async (req, res) => {
  const user = await userByResetToken(req.params.token);
  if (!user) return render404(res, 'That reset link has expired. Ask for a new one.');
  res.render('reset', { user, error: null });
}));

router.post('/reset/:token', wrap(async (req, res) => {
  const user = await userByResetToken(req.params.token);
  if (!user) return render404(res, 'That reset link has expired. Ask for a new one.');
  const bad = checkPin(req.body);
  if (bad) return res.status(400).render('reset', { user, error: bad.error });
  await db.query(
    `UPDATE users SET pin_hash = $1, reset_token = NULL, reset_expires = NULL,
            failed_attempts = 0, locked_until = NULL WHERE id = $2`,
    [await hashPin(clean(req.body.pin, 20)), user.id]
  );
  req.session.userId = user.id;
  req.session.flash = 'New PIN saved.';
  res.redirect('/');
}));

// ---------- my account ----------

router.get('/account', requireLogin, (req, res) => res.render('account', { error: null }));

router.post('/account/name', requireLogin, wrap(async (req, res) => {
  const name = clean(req.body.name, 40);
  if (name) await db.query('UPDATE users SET name = $1 WHERE id = $2', [name, req.me.id]);
  req.session.flash = 'Name updated.';
  res.redirect('/account');
}));

router.post('/account/pin', requireLogin, wrap(async (req, res) => {
  const { rows: [user] } = await db.query('SELECT pin_hash FROM users WHERE id = $1', [req.me.id]);
  if (!(await bcrypt.compare(clean(req.body.current_pin, 20), user.pin_hash))) {
    return res.status(400).render('account', { error: 'Your current PIN isn’t right.' });
  }
  const bad = checkPin(req.body);
  if (bad) return res.status(400).render('account', { error: bad.error });
  await db.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [await hashPin(clean(req.body.pin, 20)), req.me.id]);
  req.session.flash = 'PIN changed.';
  res.redirect('/account');
}));

module.exports = router;
