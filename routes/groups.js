const express = require('express');
const db = require('../db');
const { wrap, clean, randomToken, render404, render403 } = require('../lib/util');
const { requireLogin } = require('../lib/auth');
const { membership, unshareAll } = require('../lib/access');

const router = express.Router();
router.use(requireLogin);

const inviteUrl = (req, group) => `${req.protocol}://${req.get('host')}/join/${group.invite_token}`;

async function adminCount(groupId) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM memberships WHERE group_id = $1 AND is_admin', [groupId]);
  return rows[0].n;
}

// Load the group from :id and check the current user's role in it.
function loadGroup({ admin = false } = {}) {
  return wrap(async (req, res, next) => {
    const { rows } = await db.query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
    const group = rows[0];
    const mine = group && (await membership(group.id, req.me.id));
    if (!mine) return render404(res);
    if (admin && !mine.is_admin) return render403(res, 'Only group admins can do that.');
    req.group = group;
    req.myMembership = mine;
    next();
  });
}

// Only people on the site admin's whitelist can create groups.
router.post('/groups', wrap(async (req, res) => {
  if (!req.me.can_create_groups) return render403(res, 'Ask the site admin to let you create groups.');
  const name = clean(req.body.name, 60);
  if (!name) return res.redirect('/');
  const { rows: [group] } = await db.query(
    'INSERT INTO groups (name, invite_token) VALUES ($1, $2) RETURNING *',
    [name, randomToken()]
  );
  await db.query('INSERT INTO memberships (group_id, user_id, is_admin) VALUES ($1, $2, true)', [group.id, req.me.id]);
  // Share all your lists with the new group (change per list later).
  await db.query(
    'INSERT INTO list_groups (list_id, group_id) SELECT id, $1 FROM lists WHERE owner_id = $2',
    [group.id, req.me.id]
  );
  req.session.flash = `Created ${name}. Share the invite link below to add people.`;
  res.redirect(`/g/${group.id}`);
}));

router.get('/g/:id', loadGroup(), wrap(async (req, res) => {
  const { rows: members } = await db.query(
    `SELECT u.id, u.name, u.can_create_groups, m.is_admin
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = $1 ORDER BY m.is_admin DESC, u.name`,
    [req.group.id]
  );
  res.render('group', {
    group: req.group,
    isAdmin: req.myMembership.is_admin,
    members,
    inviteUrl: inviteUrl(req, req.group),
    adminCount: members.filter((m) => m.is_admin).length,
  });
}));

router.post('/g/:id/rename', loadGroup({ admin: true }), wrap(async (req, res) => {
  const name = clean(req.body.name, 60);
  if (name) await db.query('UPDATE groups SET name = $1 WHERE id = $2', [name, req.group.id]);
  res.redirect(`/g/${req.group.id}`);
}));

router.post('/g/:id/invite/reset', loadGroup({ admin: true }), wrap(async (req, res) => {
  await db.query('UPDATE groups SET invite_token = $1 WHERE id = $2', [randomToken(), req.group.id]);
  req.session.flash = 'New invite link made. The old one no longer works.';
  res.redirect(`/g/${req.group.id}`);
}));

router.post('/g/:id/members/:uid/remove', loadGroup({ admin: true }), wrap(async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  if (uid === req.me.id) return render403(res, 'Use “Leave group” to remove yourself.');
  await db.query('DELETE FROM memberships WHERE group_id = $1 AND user_id = $2', [req.group.id, uid]);
  await unshareAll(req.group.id, uid);
  res.redirect(`/g/${req.group.id}`);
}));

router.post('/g/:id/members/:uid/admin', loadGroup({ admin: true }), wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.is_admin, u.can_create_groups FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = $1 AND m.user_id = $2`,
    [req.group.id, req.params.uid]
  );
  const target = rows[0];
  if (!target) return render404(res);
  if (target.is_admin) {
    if ((await adminCount(req.group.id)) <= 1) return render403(res, 'A group needs at least one admin.');
  } else if (!target.can_create_groups) {
    return render403(res, 'Only people the site admin has approved can be group admins.');
  }
  await db.query('UPDATE memberships SET is_admin = NOT is_admin WHERE group_id = $1 AND user_id = $2', [req.group.id, req.params.uid]);
  res.redirect(`/g/${req.group.id}`);
}));

router.post('/g/:id/leave', loadGroup(), wrap(async (req, res) => {
  const { rows: [{ n }] } = await db.query('SELECT COUNT(*)::int AS n FROM memberships WHERE group_id = $1', [req.group.id]);
  if (n === 1) {
    // Last person out: the group goes away.
    await db.query('DELETE FROM groups WHERE id = $1', [req.group.id]);
  } else {
    if (req.myMembership.is_admin && (await adminCount(req.group.id)) <= 1) {
      return render403(res, 'You’re the only admin. Make someone else an admin first, or delete the group.');
    }
    await db.query('DELETE FROM memberships WHERE group_id = $1 AND user_id = $2', [req.group.id, req.me.id]);
    await unshareAll(req.group.id, req.me.id);
  }
  req.session.flash = `You left ${req.group.name}.`;
  res.redirect('/');
}));

router.post('/g/:id/delete', loadGroup({ admin: true }), wrap(async (req, res) => {
  await db.query('DELETE FROM groups WHERE id = $1', [req.group.id]);
  req.session.flash = `Deleted ${req.group.name}.`;
  res.redirect('/');
}));

module.exports = router;
