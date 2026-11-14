// Who can see what. Every visibility rule lives here.
//
// - You can see someone's list if the list is shared with a group you're both in.
// - Claims and comments are never shown to the list's owner.
// - A claim by someone you don't share a group with shows as "someone outside your groups".
// - Comments are only shown if you share a group with the author.
const db = require('../db');

// SQL condition: list `alias` is visible to the user in parameter `viewer`.
// Also checks the owner is still in the group, in case sharing rows go stale.
const listVisibleSql = (alias, viewer) => `EXISTS (
  SELECT 1 FROM list_groups lg
    JOIN memberships mv ON mv.group_id = lg.group_id AND mv.user_id = ${viewer}
    JOIN memberships mo ON mo.group_id = lg.group_id AND mo.user_id = ${alias}.owner_id
   WHERE lg.list_id = ${alias}.id)`;

// Everyone who shares at least one group with userId, plus userId.
async function groupmateIds(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT m2.user_id FROM memberships m1
       JOIN memberships m2 ON m2.group_id = m1.group_id
      WHERE m1.user_id = $1`,
    [userId]
  );
  const ids = new Set(rows.map((r) => r.user_id));
  ids.add(userId);
  return ids;
}

async function canSeeList(viewerId, listId) {
  const { rows } = await db.query(`SELECT 1 FROM lists l WHERE l.id = $1 AND ${listVisibleSql('l', '$2')}`, [listId, viewerId]);
  return rows.length > 0;
}

async function myGroups(userId) {
  const { rows } = await db.query(
    `SELECT g.*, m.is_admin FROM groups g JOIN memberships m ON m.group_id = g.id
      WHERE m.user_id = $1 ORDER BY g.name, g.id`,
    [userId]
  );
  return rows;
}

async function membership(groupId, userId) {
  const { rows } = await db.query('SELECT * FROM memberships WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  return rows[0] || null;
}

// When someone leaves or is removed from a group, stop sharing their lists with it.
async function unshareAll(groupId, userId) {
  await db.query(
    `DELETE FROM list_groups lg USING lists l
      WHERE lg.list_id = l.id AND l.owner_id = $1 AND lg.group_id = $2`,
    [userId, groupId]
  );
}

module.exports = { listVisibleSql, groupmateIds, canSeeList, myGroups, membership, unshareAll };
