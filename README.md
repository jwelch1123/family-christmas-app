# 🎄 Family Gifts

Christmas wish lists for families and groups, built for phones.

- **Lists.** Everyone has their own page with as many lists as they want. There are two kinds:
  - **🎁 Gift lists:** specific items, each with a title, a link and notes. ★ marks the ones you really want. Others can claim them.
  - **💭 Interests:** a free-form note like "I'm interested in…" or "Exploring…". Links in it become clickable. Others can comment on it.
- **Groups.** You join a group from an invite link and choose which of your lists that group can see. You can be in several groups (your family, your in-laws…) and change sharing on each list.
- **Surprises stay hidden.** The owner of a list never sees claims or comments on it.
  - If someone in your groups claims something, you see their name. If someone outside your groups claims it, you see "Held by someone outside your groups", so nobody buys it twice.
  - You only see comments from people who share a group with you.
- **Home page.** It has a **Me** section (your lists, and the gifts you're giving) and a **Groups** section (open a group to see its people).

## Accounts and admins

- **Logging in:** email + PIN (4–8 digits). After 5 wrong PINs, that account is locked for 15 minutes.
- **Signing up:** only from an invite link, so strangers can't create accounts.
- **Site admin:** the first account, created with the `SETUP_CODE`. The **Admin** page lets the site admin:
  - **Approve** who may create groups and be group admins.
  - Make **PIN reset links** for people who forget their PIN.
- **Group admins** can:
  - Share the invite link, or make a new one (the old one then stops working).
  - Remove people, rename the group, or delete it.
  - Make other *approved* people admins.

Accounts are tied to email addresses, so "Sign in with Google" can be added later without losing anyone's lists.

## Deploy to Heroku

**From your phone:** open
`https://www.heroku.com/deploy?template=https://github.com/jwelch1123/family-christmas-app/tree/claude/zen-albattani-71pwcb`
(this needs a public repo), or use the Heroku dashboard:
1. Create an app.
2. Add **Heroku Postgres** (Essential 0).
3. Set these config vars: `NODE_ENV=production`, `SETUP_CODE=<anything>` and `SESSION_SECRET=<long random string>`.
4. On the Deploy tab, connect GitHub and deploy this branch.

**From a computer:**
```bash
heroku create my-family-gifts
heroku addons:create heroku-postgresql:essential-0
heroku config:set NODE_ENV=production SETUP_CODE="pick-something" SESSION_SECRET="$(openssl rand -hex 32)"
git push heroku claude/zen-albattani-71pwcb:main
```

Then open the app. You'll be asked for the setup code to create your (site admin) account. Create a group and share its invite link.

The database tables are created automatically. If you deployed the earlier single-family version, run `heroku pg:reset DATABASE_URL` first (this deletes the old data).

## Run locally

```bash
createdb christmas
npm install
DATABASE_URL=postgres://user:pass@localhost/christmas npm start   # http://localhost:3000, setup code "setup"
```

Tests (they wipe the database you point them at, so use a scratch one):
```bash
createdb christmas_test
DATABASE_URL=postgres://user:pass@localhost/christmas_test npm test
```
