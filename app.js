const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const { hostOf, linkify, render404, cleanUrl } = require('./lib/util');

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

app.use((req, res, next) => {
  res.locals.me = null;
  res.locals.hostOf = hostOf;
  res.locals.linkify = linkify;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  next();
});

app.use(require('./routes/auth'));
app.use(require('./routes/admin'));
app.use(require('./routes/groups'));
app.use(require('./routes/lists'));

app.use((req, res) => render404(res));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Something went wrong. Try again?' });
});

module.exports = { app, cleanUrl, linkify };
