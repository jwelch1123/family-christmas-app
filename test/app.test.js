// Run with: DATABASE_URL=postgres://.../christmas_test npm test  (wipes that database)
//
// Scenario: James (site admin) runs the "Welch" group with Mom.
// Sam is in Welch too, and also runs the "Smith" group with Linda (Sam's mom).
// So Mom and Linda can both see Sam's lists, but don't share a group.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.SETUP_CODE = 'north-pole';
const db = require('../db');
const { app, cleanUrl, linkify } = require('../app');

const agents = {};
const ids = {};
let welch, smith; // { id, token }

const form = (agent, url, body = {}) => agent.post(url).type('form').send(body);

async function joinVia(token, name, listChoice) {
  const agent = request.agent(app);
  const email = `${name.toLowerCase()}@example.com`;
  await form(agent, `/join/${token}/signup`, { name, email, pin: '1234', pin_confirm: '1234' }).expect(302);
  const page = await agent.get(`/join/${token}`).expect(200);
  const listIds = [...page.text.matchAll(/name="list_ids" value="(\d+)"/g)].map((m) => m[1]);
  await form(agent, `/join/${token}`, { list_ids: listChoice ? listChoice(listIds) : listIds }).expect(302);
  agents[name] = agent;
  ids[name] = (await db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
}

async function createGroup(agent, name) {
  const res = await form(agent, '/groups', { name }).expect(302);
  const id = parseInt(res.headers.location.split('/').pop(), 10);
  const token = (await db.query('SELECT invite_token FROM groups WHERE id = $1', [id])).rows[0].invite_token;
  return { id, token };
}

async function giftList(userId) {
  return (await db.query("SELECT id FROM lists WHERE owner_id = $1 AND kind = 'gifts' ORDER BY id LIMIT 1", [userId])).rows[0].id;
}

before(async () => {
  await db.query('DROP TABLE IF EXISTS comments, claims, items, list_groups, lists, memberships, groups, users CASCADE');
  await db.init();
});
after(() => db.pool.end());

test('first visit goes to setup; setup code required; becomes site admin', async () => {
  await request(app).get('/login').expect(302).expect('Location', '/setup');
  const agent = request.agent(app);
  const body = { name: 'James', email: 'James@Example.com ', pin: '1234', pin_confirm: '1234' };
  const bad = await form(agent, '/setup', { ...body, setup_code: 'wrong' });
  assert.match(bad.text, /setup code is not right/);
  await form(agent, '/setup', { ...body, setup_code: 'north-pole' }).expect(302);
  const { rows } = await db.query('SELECT * FROM users');
  assert.strictEqual(rows[0].email, 'james@example.com');
  assert.ok(rows[0].is_site_admin && rows[0].can_create_groups);
  agents.James = agent;
  ids.James = rows[0].id;
  // Setup is closed now.
  await request(app).get('/setup').expect(302).expect('Location', '/login');
});

test('groups and invites', async () => {
  welch = await createGroup(agents.James, 'Welch');
  await joinVia(welch.token, 'Mom');
  await joinVia(welch.token, 'Sam');
  // Sam can't create a group until approved.
  await form(agents.Sam, '/groups', { name: 'Smith' }).expect(403);
  await form(agents.James, `/admin/users/${ids.Sam}/whitelist`).expect(302);
  smith = await createGroup(agents.Sam, 'Smith');
  // Linda only shares her gift list.
  await joinVia(smith.token, 'Linda', (listIds) => listIds.slice(0, 1));
  const shared = await db.query('SELECT COUNT(*)::int AS n FROM list_groups lg JOIN lists l ON l.id = lg.list_id WHERE l.owner_id = $1', [ids.Linda]);
  assert.strictEqual(shared.rows[0].n, 1);
  // A bad token is rejected; signing up without an invite isn't possible.
  await request(app).get('/join/nope').expect(404);
});

test('login with email + PIN; lockout survives in the database', async () => {
  const fresh = request.agent(app);
  await form(fresh, '/login', { email: 'MOM@example.com', pin: '1234' }).expect(302).expect('Location', '/');
  for (let i = 0; i < 5; i++) await form(request(app), '/login', { email: 'linda@example.com', pin: '0000' });
  const locked = await form(request(app), '/login', { email: 'linda@example.com', pin: '1234' });
  assert.match(locked.text, /Too many wrong tries/);
  await db.query('UPDATE users SET locked_until = NULL WHERE id = $1', [ids.Linda]);
});

test('home shows Me and Groups sections with the right people', async () => {
  const res = await agents.Sam.get('/').expect(200);
  assert.match(res.text, /My lists/);
  assert.match(res.text, /Welch[\s\S]*Smith|Smith[\s\S]*Welch/);
  const mom = await agents.Mom.get('/');
  assert.doesNotMatch(mom.text, /Linda/);
});

test('you only see lists shared with a group you share', async () => {
  // Mom and Linda share no group.
  await agents.Mom.get(`/u/${ids.Linda}`).expect(404);
  await agents.Linda.get(`/u/${ids.Mom}`).expect(404);
  // Sam makes a list visible only to Smith.
  await form(agents.Sam, '/lists', { kind: 'gifts', title: 'Smith-only list' }).expect(302);
  const smithOnly = (await db.query("SELECT id FROM lists WHERE title = 'Smith-only list'")).rows[0].id;
  await form(agents.Sam, `/lists/${smithOnly}/share`, { group_ids: [String(smith.id)] }).expect(302);
  await form(agents.Sam, `/lists/${smithOnly}/items`, { title: 'Hidden thing' }).expect(302);
  const momView = await agents.Mom.get(`/u/${ids.Sam}`).expect(200);
  const lindaView = await agents.Linda.get(`/u/${ids.Sam}`).expect(200);
  assert.doesNotMatch(momView.text, /Smith-only list/);
  assert.match(lindaView.text, /Smith-only list/);
  // Mom can't claim from it by guessing the id either.
  const hiddenItem = (await db.query("SELECT id FROM items WHERE title = 'Hidden thing'")).rows[0].id;
  await form(agents.Mom, `/items/${hiddenItem}/claim`).expect(404);
  // Owner sees who each list is shared with.
  const samView = await agents.Sam.get(`/u/${ids.Sam}`);
  assert.match(samView.text, /👥 Smith\s*</);
});

test('claims: names inside your groups, anonymous outside, hidden from owner', async () => {
  const list = await giftList(ids.Sam);
  await form(agents.Sam, `/lists/${list}/items`, { title: 'Headlamp', url: 'example.com/lamp' }).expect(302);
  const item = (await db.query("SELECT id FROM items WHERE title = 'Headlamp'")).rows[0].id;
  await form(agents.Mom, `/items/${item}/claim`).expect(302);

  assert.match((await agents.James.get(`/u/${ids.Sam}`)).text, /Claimed by Mom/);
  const linda = (await agents.Linda.get(`/u/${ids.Sam}`)).text;
  assert.match(linda, /Held by someone outside your groups/);
  assert.doesNotMatch(linda, /Mom/);
  assert.match((await agents.Mom.get(`/u/${ids.Sam}`)).text, /You're giving this/);
  assert.doesNotMatch((await agents.Sam.get(`/u/${ids.Sam}`)).text, /Claimed|Held by|getting this/);
  // Double claim blocked; owner can't claim.
  await form(agents.Linda, `/items/${item}/claim`).expect(302);
  assert.strictEqual((await db.query('SELECT claimer_id FROM claims WHERE item_id = $1', [item])).rows[0].claimer_id, ids.Mom);
  await form(agents.Sam, `/items/${item}/claim`).expect(403);
});

test('comments: only from people in your groups, never to the owner', async () => {
  const item = (await db.query("SELECT id FROM items WHERE title = 'Headlamp'")).rows[0].id;
  await form(agents.Mom, `/items/${item}/comments`, { body: 'MOM-NOTE' }).expect(302);
  await form(agents.Linda, `/items/${item}/comments`, { body: 'LINDA-NOTE' }).expect(302);
  const james = (await agents.James.get(`/u/${ids.Sam}`)).text;
  assert.match(james, /MOM-NOTE/);
  assert.doesNotMatch(james, /LINDA-NOTE/);
  const linda = (await agents.Linda.get(`/u/${ids.Sam}`)).text;
  assert.match(linda, /LINDA-NOTE/);
  assert.doesNotMatch(linda, /MOM-NOTE/);
  assert.doesNotMatch((await agents.Sam.get(`/u/${ids.Sam}`)).text, /MOM-NOTE|LINDA-NOTE/);
});

test('interests lists: note visible, comments follow the same rules', async () => {
  const id = (await db.query("SELECT id FROM lists WHERE owner_id = $1 AND kind = 'interests'", [ids.Sam])).rows[0].id;
  await form(agents.Sam, `/lists/${id}/body`, { body: 'Bouldering https://example.com/shoes' }).expect(302);
  await form(agents.Sam, `/lists/${id}/items`, { title: 'x' }).expect(400);
  await form(agents.Mom, `/lists/${id}/comments`, { body: 'CLASS-PLAN' }).expect(302);
  const james = (await agents.James.get(`/u/${ids.Sam}`)).text;
  assert.match(james, /<a href="https:\/\/example.com\/shoes"/);
  assert.match(james, /CLASS-PLAN/);
  assert.doesNotMatch((await agents.Linda.get(`/u/${ids.Sam}`)).text, /CLASS-PLAN/);
  assert.doesNotMatch((await agents.Sam.get(`/u/${ids.Sam}`)).text, /CLASS-PLAN/);
});

test('others cannot edit your lists or items', async () => {
  const list = await giftList(ids.Sam);
  await form(agents.Mom, `/lists/${list}/rename`, { title: 'Hacked' }).expect(403);
  await form(agents.Mom, `/lists/${list}/share`, { group_ids: [] }).expect(403);
  const item = (await db.query("SELECT id FROM items WHERE title = 'Headlamp'")).rows[0].id;
  await form(agents.Mom, `/items/${item}/delete`).expect(403);
});

test('group admin rules', async () => {
  // Mom isn't approved, so can't be made admin.
  await form(agents.James, `/g/${welch.id}/members/${ids.Mom}/admin`).expect(403);
  // Non-admins can't manage.
  await form(agents.Mom, `/g/${welch.id}/invite/reset`).expect(403);
  // Only admin can't leave.
  await form(agents.James, `/g/${welch.id}/leave`).expect(403);
  // Sam is approved, so can be made admin; then James can leave... but we keep him.
  await form(agents.James, `/g/${welch.id}/members/${ids.Sam}/admin`).expect(302);
  assert.ok((await db.query('SELECT is_admin FROM memberships WHERE group_id = $1 AND user_id = $2', [welch.id, ids.Sam])).rows[0].is_admin);
  // Resetting the invite link kills the old one.
  await form(agents.James, `/g/${welch.id}/invite/reset`).expect(302);
  await request(app).get(`/join/${welch.token}`).expect(404);
  welch.token = (await db.query('SELECT invite_token FROM groups WHERE id = $1', [welch.id])).rows[0].invite_token;
  // Unapproving Sam removes their admin roles.
  await form(agents.James, `/admin/users/${ids.Sam}/whitelist`).expect(302);
  assert.strictEqual((await db.query('SELECT COUNT(*)::int AS n FROM memberships WHERE user_id = $1 AND is_admin', [ids.Sam])).rows[0].n, 0);
});

test('removing someone stops sharing their lists with that group', async () => {
  await form(agents.James, `/g/${welch.id}/members/${ids.Mom}/remove`).expect(302);
  await agents.James.get(`/u/${ids.Mom}`).expect(404);
  await agents.Mom.get(`/u/${ids.Sam}`).expect(404);
  // Mom's claim stays, and she can still release it from home.
  assert.match((await agents.Mom.get('/')).text, /Headlamp/);
});

test('site admin PIN reset link', async () => {
  const res = await form(agents.James, `/admin/users/${ids.Linda}/reset`).expect(302);
  const page = await agents.James.get('/admin');
  const url = page.text.match(/value="https?:\/\/[^"]+(\/reset\/[^"]+)"/)[1];
  const agent = request.agent(app);
  await form(agent, url, { pin: '5555', pin_confirm: '5555' }).expect(302);
  await form(request(app), '/login', { email: 'linda@example.com', pin: '5555' }).expect(302).expect('Location', '/');
  await request(app).get(url).expect(404); // single use
  await form(agents.Mom, `/admin/users/${ids.Linda}/reset`).expect(403);
});

test('account: change PIN needs the current PIN', async () => {
  const bad = await form(agents.Linda, '/account/pin', { current_pin: '0000', pin: '9999', pin_confirm: '9999' });
  assert.match(bad.text, /current PIN isn/);
});

test('unsafe input', async () => {
  assert.strictEqual(cleanUrl('javascript:alert(1)'), null);
  assert.strictEqual(linkify('<b>hi</b>'), '&lt;b&gt;hi&lt;/b&gt;');
  assert.doesNotMatch(linkify('https://a.com/"onmouseover="x'), /"onmouseover/);
  const list = await giftList(ids.Sam);
  await form(agents.Sam, `/lists/${list}/items`, { title: '<script>x</script>' });
  assert.doesNotMatch((await agents.James.get(`/u/${ids.Sam}`)).text, /<script>x<\/script>/);
  await request(app).get('/').expect(302).expect('Location', '/login');
});

test('link previews: Open Graph tags, with the group name on invite links', async () => {
  const login = await request(app).get('/login');
  assert.match(login.text, /<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/og-image\.png">/);
  const join = await request(app).get(`/join/${smith.token}`);
  assert.match(join.text, /<meta property="og:title" content="Join Smith on Family Gifts">/);
  await request(app).get('/og-image.png').expect(200).expect('Content-Type', /png/);
});
