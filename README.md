# 🎄 Family Gifts

Christmas wish lists for the family, built for phones.

- Each person gets a page with as many lists as they want, and they can rename them.
- Each item can have a title, a link and notes. ★ marks the ones you really want.
- Everyone else can **claim** an item ("I'll get this") and leave **comments** like "want to split it?".
- **The list owner never sees claims or comments.** The server never sends that data to them.
- "Gifts I'm getting" on the home page lists everything you've claimed.
- Add it to your phone's home screen and it opens like an app.

## Deploy to Heroku

```bash
heroku create my-family-gifts
heroku addons:create heroku-postgresql:essential-0
heroku config:set NODE_ENV=production \
  FAMILY_MEMBERS="Mom,Dad,Alex,Sam,Jordan,Taylor" \
  FAMILY_CODE="something-only-family-knows" \
  SESSION_SECRET="$(openssl rand -hex 32)"
git push heroku main
heroku open
```

The database tables are created automatically on startup. To add someone later, add their name to `FAMILY_MEMBERS` (Heroku restarts the app for you).
Renaming someone in `FAMILY_MEMBERS` creates a new person. It doesn't rename the old one.

## Logging in

1. Tap your name.
2. **First time:** enter the family code and choose a 4–8 digit PIN.
3. After that, just your PIN. You stay logged in on that phone for a year.

Forgot your PIN? Run `heroku run node scripts/reset-pin.js "Name"`, then set a new one with the family code.

**Put it on your home screen:** in Safari, tap Share → *Add to Home Screen*. In Chrome on Android, tap ⋮ → *Add to Home screen*.

## Run locally

```bash
createdb christmas
npm install
DATABASE_URL=postgres://user:pass@localhost/christmas npm start   # http://localhost:3000
```
The default family code locally is `christmas`.

Tests (they wipe the database you point them at, so use a scratch one):
```bash
createdb christmas_test
DATABASE_URL=postgres://user:pass@localhost/christmas_test npm test
```
