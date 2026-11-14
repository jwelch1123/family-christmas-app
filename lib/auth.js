const bcrypt = require('bcryptjs');
const db = require('../db');
const { wrap, clean, cleanEmail } = require('./util');

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const PIN_RE = /^\d{4,8}$/;

// Check an email + PIN. Failed attempts are stored in the database, so a
// restart doesn't reset the lockout.
async function authenticate(emailInput, pinInput) {
  const email = cleanEmail(emailInput);
  const pin = clean(pinInput, 20);
  const generic = { error: 'That email and PIN don’t match.' };
  if (!email || !pin) return generic;

  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) return generic;

  if (user.locked_until && user.locked_until > new Date()) {
    return { error: `Too many wrong tries. Try again in ${LOCK_MINUTES} minutes.` };
  }
  if (!(await bcrypt.compare(pin, user.pin_hash))) {
    const attempts = user.failed_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db.query(
        `UPDATE users SET failed_attempts = 0, locked_until = now() + interval '${LOCK_MINUTES} minutes' WHERE id = $1`,
        [user.id]
      );
    } else {
      await db.query('UPDATE users SET failed_attempts = $1 WHERE id = $2', [attempts, user.id]);
    }
    return generic;
  }
  await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
  return { user };
}

// Validate a new-account form. Returns { error } or { name, email, pin }.
function checkSignup(body) {
  const name = clean(body.name, 40);
  const email = cleanEmail(body.email);
  const pin = clean(body.pin, 20);
  if (!name) return { error: 'Enter your name.' };
  if (!email) return { error: 'Enter a valid email address.' };
  return checkPin(body) || { name, email, pin };
}

function checkPin(body) {
  const pin = clean(body.pin, 20);
  if (!PIN_RE.test(pin)) return { error: 'Choose a PIN of 4 to 8 digits.' };
  if (pin !== clean(body.pin_confirm, 20)) return { error: 'The two PINs don’t match.' };
  return null;
}

const hashPin = (pin) => bcrypt.hash(pin, 10);

// Create an account with a starter gift list and interests list.
async function createUser({ name, email, pin }, flags = {}) {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, pin_hash, is_site_admin, can_create_groups)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING RETURNING *`,
    [name, email, await hashPin(pin), !!flags.siteAdmin, !!flags.siteAdmin]
  );
  const user = rows[0];
  if (!user) return null; // email already taken
  await db.query(
    `INSERT INTO lists (owner_id, title, kind) VALUES ($1, 'My Wish List', 'gifts'), ($1, 'I''m interested in…', 'interests')`,
    [user.id]
  );
  return user;
}

const requireLogin = wrap(async (req, res, next) => {
  const id = req.session.userId;
  if (!id) return res.redirect('/login');
  const { rows } = await db.query('SELECT id, name, email, is_site_admin, can_create_groups FROM users WHERE id = $1', [id]);
  if (!rows[0]) {
    req.session = null;
    return res.redirect('/login');
  }
  req.me = res.locals.me = rows[0];
  next();
});

function requireSiteAdmin(req, res, next) {
  if (!req.me?.is_site_admin) return res.status(403).render('error', { message: 'Only the site admin can do that.' });
  next();
}

module.exports = { authenticate, checkSignup, checkPin, hashPin, createUser, requireLogin, requireSiteAdmin };
