// Site admin: approve who can create groups / be group admins, and make PIN reset links.
const express = require('express');
const db = require('../db');
const { wrap, randomToken, render404, render403 } = require('../lib/util');
const { requireLogin, requireSiteAdmin } = require('../lib/auth');

const router = express.Router();
router.use('/admin', requireLogin, requireSiteAdmin);

router.get('/admin', wrap(async (req, res) => {
  const { rows: users } = await db.query(
    `SELECT u.id, u.name, u.email, u.is_site_admin, u.can_create_groups,
            u.locked_until > now() AS locked,
            COALESCE(string_agg(g.name, ', ' ORDER BY g.name), '') AS group_names
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN groups g ON g.id = m.group_id
      GROUP BY u.id ORDER BY u.name`
  );
  const resetLink = req.session.resetLink || null;
  req.session.resetLink = null;
  res.render('admin', { users, resetLink });
}));

router.post('/admin/users/:id/whitelist', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const user = rows[0];
  if (!user) return render404(res);
  if (user.is_site_admin) return render403(res, 'The site admin can always create groups.');
  await db.query('UPDATE users SET can_create_groups = NOT can_create_groups WHERE id = $1', [user.id]);
  // Taking someone off the list also removes their group admin roles.
  if (user.can_create_groups) await db.query('UPDATE memberships SET is_admin = false WHERE user_id = $1', [user.id]);
  res.redirect('/admin');
}));

router.post('/admin/users/:id/reset', wrap(async (req, res) => {
  const token = randomToken(24);
  const { rows } = await db.query(
    `UPDATE users SET reset_token = $1, reset_expires = now() + interval '7 days',
            failed_attempts = 0, locked_until = NULL
      WHERE id = $2 RETURNING name`,
    [token, req.params.id]
  );
  if (!rows[0]) return render404(res);
  req.session.resetLink = { name: rows[0].name, url: `${req.protocol}://${req.get('host')}/reset/${token}` };
  res.redirect('/admin');
}));

module.exports = router;
