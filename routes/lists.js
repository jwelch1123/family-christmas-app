const express = require('express');
const db = require('../db');
const { wrap, clean, cleanUrl, hostOf, idList, render404, render403 } = require('../lib/util');
const { requireLogin } = require('../lib/auth');
const { listVisibleSql, groupmateIds, canSeeList, myGroups } = require('../lib/access');

const router = express.Router();
router.use(requireLogin);

// ---------- home ----------

router.get('/', wrap(async (req, res) => {
  const me = req.me.id;
  const { rows: [mine] } = await db.query(
    `SELECT (SELECT COUNT(*) FROM lists WHERE owner_id = $1)::int AS list_count,
            (SELECT COUNT(*) FROM items i JOIN lists l ON l.id = i.list_id WHERE l.owner_id = $1)::int AS item_count`,
    [me]
  );
  const groups = await myGroups(me);

  // Counts only cover lists shared with that group. Your own claims are never counted.
  const { rows: members } = await db.query(
    `SELECT m.group_id, u.id, u.name, m.is_admin,
            (SELECT COUNT(*) FROM lists l JOIN list_groups lg ON lg.list_id = l.id AND lg.group_id = m.group_id
              WHERE l.owner_id = u.id)::int AS list_count,
            (SELECT COUNT(*) FROM items i JOIN list_groups lg ON lg.list_id = i.list_id AND lg.group_id = m.group_id
               JOIN lists l ON l.id = i.list_id WHERE l.owner_id = u.id)::int AS item_count,
            (SELECT COUNT(*) FROM items i JOIN list_groups lg ON lg.list_id = i.list_id AND lg.group_id = m.group_id
               JOIN lists l ON l.id = i.list_id JOIN claims c ON c.item_id = i.id WHERE l.owner_id = u.id)::int AS claimed_count
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ANY($1) AND u.id <> $2
      ORDER BY u.name`,
    [groups.map((g) => g.id), me]
  );
  for (const g of groups) g.members = members.filter((m) => m.group_id === g.id);

  const { rows: myClaims } = await db.query(
    `SELECT i.id, i.title, u.id AS owner_id, u.name AS owner_name
       FROM claims c
       JOIN items i ON i.id = c.item_id
       JOIN lists l ON l.id = i.list_id
       JOIN users u ON u.id = l.owner_id
      WHERE c.claimer_id = $1
      ORDER BY u.name, i.title`,
    [me]
  );
  res.render('home', { mine, groups, myClaims });
}));

// ---------- a person's page ----------

router.get('/u/:id', wrap(async (req, res) => {
  const { rows: [person] } = await db.query('SELECT id, name FROM users WHERE id = $1', [req.params.id]);
  if (!person) return render404(res);
  const isOwner = person.id === req.me.id;
  const mates = await groupmateIds(req.me.id);
  if (!isOwner && !mates.has(person.id)) return render404(res);

  const { rows: lists } = isOwner
    ? await db.query('SELECT * FROM lists WHERE owner_id = $1 ORDER BY created_at, id', [person.id])
    : await db.query(
        `SELECT l.* FROM lists l WHERE l.owner_id = $1 AND ${listVisibleSql('l', '$2')} ORDER BY l.created_at, l.id`,
        [person.id, req.me.id]
      );
  const listIds = lists.map((l) => l.id);
  const { rows: items } = await db.query(
    'SELECT * FROM items WHERE list_id = ANY($1) ORDER BY starred DESC, created_at, id',
    [listIds]
  );

  // Claims & comments are never even queried for the owner.
  const claims = new Map();
  const itemComments = new Map();
  const listComments = new Map();
  if (!isOwner) {
    const { rows: c } = await db.query(
      `SELECT c.item_id, c.claimer_id, u.name AS claimer_name
         FROM claims c JOIN users u ON u.id = c.claimer_id WHERE c.item_id = ANY($1)`,
      [items.map((i) => i.id)]
    );
    for (const row of c) {
      // Name the claimer only if you share a group with them.
      const label = row.claimer_id === req.me.id ? 'me' : mates.has(row.claimer_id) ? row.claimer_name : null;
      claims.set(row.item_id, { ...row, label });
    }
    const { rows: cm } = await db.query(
      `SELECT c.*, u.name AS author_name
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE (c.item_id = ANY($1) OR c.list_id = ANY($2)) AND c.author_id = ANY($3)
        ORDER BY c.created_at`,
      [items.map((i) => i.id), listIds, [...mates]]
    );
    for (const row of cm) {
      const [map, key] = row.item_id ? [itemComments, row.item_id] : [listComments, row.list_id];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
  }

  // For the owner: which groups each list is shared with.
  const groups = isOwner ? await myGroups(req.me.id) : [];
  const sharing = new Map();
  if (isOwner) {
    const { rows } = await db.query('SELECT list_id, group_id FROM list_groups WHERE list_id = ANY($1)', [listIds]);
    for (const r of rows) {
      if (!sharing.has(r.list_id)) sharing.set(r.list_id, new Set());
      sharing.get(r.list_id).add(r.group_id);
    }
  }

  for (const list of lists) {
    list.comments = listComments.get(list.id) || [];
    list.sharedWith = sharing.get(list.id) || new Set();
    list.items = items
      .filter((i) => i.list_id === list.id)
      .map((i) => ({ ...i, claim: claims.get(i.id) || null, comments: itemComments.get(i.id) || [] }));
  }

  res.render('person', { person, lists, isOwner, groups });
}));

// ---------- owner actions: lists ----------

async function ownList(req, res) {
  const { rows } = await db.query('SELECT * FROM lists WHERE id = $1', [req.params.id]);
  const list = rows[0];
  if (!list) { render404(res); return null; }
  if (list.owner_id !== req.me.id) { render403(res, "That's not your list."); return null; }
  return list;
}

router.post('/lists', wrap(async (req, res) => {
  const kind = req.body.kind === 'interests' ? 'interests' : 'gifts';
  const title = clean(req.body.title, 80) || (kind === 'interests' ? "I'm interested in…" : 'New List');
  const { rows } = await db.query(
    'INSERT INTO lists (owner_id, title, kind) VALUES ($1, $2, $3) RETURNING id',
    [req.me.id, title, kind]
  );
  // New lists are shared with all your groups; change it per list.
  await db.query(
    'INSERT INTO list_groups (list_id, group_id) SELECT $1, group_id FROM memberships WHERE user_id = $2',
    [rows[0].id, req.me.id]
  );
  res.redirect(`/u/${req.me.id}#list-${rows[0].id}`);
}));

router.post('/lists/:id/rename', wrap(async (req, res) => {
  const list = await ownList(req, res);
  if (!list) return;
  const title = clean(req.body.title, 80);
  if (title) await db.query('UPDATE lists SET title = $1 WHERE id = $2', [title, list.id]);
  res.redirect(`/u/${req.me.id}#list-${list.id}`);
}));

router.post('/lists/:id/share', wrap(async (req, res) => {
  const list = await ownList(req, res);
  if (!list) return;
  await db.query('DELETE FROM list_groups WHERE list_id = $1', [list.id]);
  // Only groups you're actually in.
  await db.query(
    `INSERT INTO list_groups (list_id, group_id)
     SELECT $1, group_id FROM memberships WHERE user_id = $2 AND group_id = ANY($3)`,
    [list.id, req.me.id, idList(req.body.group_ids)]
  );
  res.redirect(`/u/${req.me.id}#list-${list.id}`);
}));

router.post('/lists/:id/body', wrap(async (req, res) => {
  const list = await ownList(req, res);
  if (!list) return;
  await db.query('UPDATE lists SET body = $1 WHERE id = $2', [clean(req.body.body, 5000) || null, list.id]);
  res.redirect(`/u/${req.me.id}#list-${list.id}`);
}));

router.post('/lists/:id/delete', wrap(async (req, res) => {
  const list = await ownList(req, res);
  if (!list) return;
  await db.query('DELETE FROM lists WHERE id = $1', [list.id]);
  res.redirect(`/u/${req.me.id}`);
}));

// ---------- owner actions: items ----------

router.post('/lists/:id/items', wrap(async (req, res) => {
  const list = await ownList(req, res);
  if (!list) return;
  if (list.kind !== 'gifts') return res.status(400).render('error', { message: 'That list is a free-form note.' });
  const title = clean(req.body.title, 200);
  const url = cleanUrl(req.body.url);
  if (!title && !url) return res.redirect(`/u/${req.me.id}#list-${list.id}`);
  const { rows } = await db.query(
    'INSERT INTO items (list_id, title, url, notes) VALUES ($1, $2, $3, $4) RETURNING id',
    [list.id, title || hostOf(url), url, clean(req.body.notes, 1000) || null]
  );
  res.redirect(`/u/${req.me.id}#item-${rows[0].id}`);
}));

async function loadItem(itemId) {
  const { rows } = await db.query(
    'SELECT i.*, l.owner_id FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = $1',
    [itemId]
  );
  return rows[0] || null;
}

async function ownItem(req, res) {
  const item = await loadItem(req.params.id);
  if (!item) { render404(res); return null; }
  if (item.owner_id !== req.me.id) { render403(res, "That's not your item."); return null; }
  return item;
}

router.post('/items/:id/edit', wrap(async (req, res) => {
  const item = await ownItem(req, res);
  if (!item) return;
  const url = cleanUrl(req.body.url);
  const title = clean(req.body.title, 200) || (url ? hostOf(url) : item.title);
  await db.query('UPDATE items SET title = $1, url = $2, notes = $3 WHERE id = $4', [
    title, url, clean(req.body.notes, 1000) || null, item.id,
  ]);
  res.redirect(`/u/${req.me.id}#item-${item.id}`);
}));

router.post('/items/:id/star', wrap(async (req, res) => {
  const item = await ownItem(req, res);
  if (!item) return;
  await db.query('UPDATE items SET starred = NOT starred WHERE id = $1', [item.id]);
  res.redirect(`/u/${req.me.id}#item-${item.id}`);
}));

router.post('/items/:id/delete', wrap(async (req, res) => {
  const item = await ownItem(req, res);
  if (!item) return;
  await db.query('DELETE FROM items WHERE id = $1', [item.id]);
  res.redirect(`/u/${req.me.id}#list-${item.list_id}`);
}));

// ---------- everyone-else actions: claims & comments ----------

// Someone else's item that you're allowed to see.
async function othersItem(req, res) {
  const item = await loadItem(req.params.id);
  if (!item || (item.owner_id !== req.me.id && !(await canSeeList(req.me.id, item.list_id)))) {
    render404(res);
    return null;
  }
  if (item.owner_id === req.me.id) { render403(res, 'No peeking at your own gifts!'); return null; }
  return item;
}

router.post('/items/:id/claim', wrap(async (req, res) => {
  const item = await othersItem(req, res);
  if (!item) return;
  const { rowCount } = await db.query(
    'INSERT INTO claims (item_id, claimer_id) VALUES ($1, $2) ON CONFLICT (item_id) DO NOTHING',
    [item.id, req.me.id]
  );
  if (!rowCount) req.session.flash = 'Someone else already claimed that one.';
  res.redirect(`/u/${item.owner_id}#item-${item.id}`);
}));

// You can always release your own claim, even if you've lost access to the list.
router.post('/items/:id/unclaim', wrap(async (req, res) => {
  const item = await loadItem(req.params.id);
  if (!item) return render404(res);
  await db.query('DELETE FROM claims WHERE item_id = $1 AND claimer_id = $2', [item.id, req.me.id]);
  if (req.body.from === 'home') return res.redirect('/');
  res.redirect(`/u/${item.owner_id}#item-${item.id}`);
}));

router.post('/items/:id/comments', wrap(async (req, res) => {
  const item = await othersItem(req, res);
  if (!item) return;
  const body = clean(req.body.body, 1000);
  if (body) await db.query('INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, $3)', [item.id, req.me.id, body]);
  res.redirect(`/u/${item.owner_id}#item-${item.id}`);
}));

router.post('/lists/:id/comments', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM lists WHERE id = $1', [req.params.id]);
  const list = rows[0];
  if (!list || (list.owner_id !== req.me.id && !(await canSeeList(req.me.id, list.id)))) return render404(res);
  if (list.owner_id === req.me.id) return render403(res, 'No peeking at your own gifts!');
  const body = clean(req.body.body, 1000);
  if (body) await db.query('INSERT INTO comments (list_id, author_id, body) VALUES ($1, $2, $3)', [list.id, req.me.id, body]);
  res.redirect(`/u/${list.owner_id}#list-${list.id}`);
}));

router.post('/comments/:id/delete', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, l.owner_id FROM comments c
       LEFT JOIN items i ON i.id = c.item_id
       JOIN lists l ON l.id = COALESCE(c.list_id, i.list_id)
      WHERE c.id = $1`,
    [req.params.id]
  );
  const c = rows[0];
  if (!c) return render404(res);
  if (c.author_id !== req.me.id) return render403(res, 'You can only delete your own comments.');
  await db.query('DELETE FROM comments WHERE id = $1', [c.id]);
  res.redirect(`/u/${c.owner_id}#` + (c.item_id ? `item-${c.item_id}` : `list-${c.list_id}`));
}));

module.exports = router;
