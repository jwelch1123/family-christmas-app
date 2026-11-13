// Run with: DATABASE_URL=postgres://.../christmas_test npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.FAMILY_CODE = 'jingle';
const db = require('../db');
const { app, cleanUrl } = require('../app');

async function login(name, pin = '1234') {
  const agent = request.agent(app);
  const { rows } = await db.query('SELECT id, pin_hash FROM users WHERE name = $1', [name]);
  const body = { user_id: rows[0].id, pin };
  if (!rows[0].pin_hash) Object.assign(body, { family_code: 'Jingle', pin_confirm: pin });
  const res = await agent.post('/login').type('form').send(body);
  assert.strictEqual(res.status, 302, `login for ${name} failed`);
  return { agent, id: rows[0].id };
}

let alice, bob, cara, listId, itemId;

before(async () => {
  await db.query('DROP TABLE IF EXISTS comments, claims, items, lists, users CASCADE');
  await db.init(['Alice', 'Bob', 'Cara']);
  alice = await login('Alice');
  bob = await login('Bob');
  cara = await login('Cara');
  listId = (await db.query('SELECT id FROM lists WHERE owner_id = $1', [alice.id])).rows[0].id;
});
after(() => db.pool.end());

test('first login needs the family code; wrong PIN is rejected', async () => {
  await db.query("INSERT INTO users (name) VALUES ('Dan')");
  const { rows } = await db.query("SELECT id FROM users WHERE name = 'Dan'");
  let res = await request(app).post('/login').type('form').send({ user_id: rows[0].id, pin: '1111', pin_confirm: '1111', family_code: 'nope' });
  assert.match(res.text, /family code is not right/);
  res = await request(app).post('/login').type('form').send({ user_id: alice.id, pin: '9999' });
  assert.match(res.text, /Wrong PIN/);
});

test('owner can add, rename and edit', async () => {
  await alice.agent.post(`/lists/${listId}/rename`).type('form').send({ title: 'Books' }).expect(302);
  await alice.agent.post(`/lists/${listId}/items`).type('form')
    .send({ title: 'Dune', url: 'example.com/dune', notes: 'Hardcover please' }).expect(302);
  const item = (await db.query('SELECT * FROM items WHERE list_id = $1', [listId])).rows[0];
  itemId = item.id;
  assert.strictEqual(item.url, 'https://example.com/dune');
  const page = await alice.agent.get(`/u/${alice.id}`);
  assert.match(page.text, /Books/);
  assert.match(page.text, /Hardcover please/);
});

test('others cannot edit your lists', async () => {
  await bob.agent.post(`/lists/${listId}/rename`).type('form').send({ title: 'Hacked' }).expect(403);
  await bob.agent.post(`/items/${itemId}/delete`).type('form').expect(403);
});

test('claims and comments are visible to others but hidden from the owner', async () => {
  await bob.agent.post(`/items/${itemId}/claim`).type('form').expect(302);
  await bob.agent.post(`/items/${itemId}/comments`).type('form').send({ body: 'SECRET-NOTE' }).expect(302);

  const caraView = await cara.agent.get(`/u/${alice.id}`);
  assert.match(caraView.text, /Claimed by Bob/);
  assert.match(caraView.text, /SECRET-NOTE/);

  const bobView = await bob.agent.get(`/u/${alice.id}`);
  assert.match(bobView.text, /You're getting this/);

  const aliceView = await alice.agent.get(`/u/${alice.id}`);
  assert.doesNotMatch(aliceView.text, /Claimed|SECRET-NOTE|getting this/);
  const aliceHome = await alice.agent.get('/');
  const myCard = aliceHome.text.match(/<a class="person-card mine"[\s\S]*?<\/a>/)[0];
  assert.doesNotMatch(myCard, /claimed/);
  assert.doesNotMatch(aliceHome.text, /Dune/);
});

test('owner cannot claim or comment on own items; double claims are blocked', async () => {
  await alice.agent.post(`/items/${itemId}/claim`).type('form').expect(403);
  await alice.agent.post(`/items/${itemId}/comments`).type('form').send({ body: 'x' }).expect(403);
  await cara.agent.post(`/items/${itemId}/claim`).type('form').expect(302);
  const { rows } = await db.query('SELECT claimer_id FROM claims WHERE item_id = $1', [itemId]);
  assert.strictEqual(rows[0].claimer_id, bob.id);
  // Cara can't release Bob's claim
  await cara.agent.post(`/items/${itemId}/unclaim`).type('form').expect(302);
  assert.strictEqual((await db.query('SELECT 1 FROM claims WHERE item_id = $1', [itemId])).rowCount, 1);
});

test('home page shows my claims', async () => {
  const res = await bob.agent.get('/');
  assert.match(res.text, /Dune/);
  assert.match(res.text, /for Alice/);
});

test('unsafe links are rejected and HTML is escaped', async () => {
  assert.strictEqual(cleanUrl('javascript:alert(1)'), null);
  await alice.agent.post(`/lists/${listId}/items`).type('form').send({ title: '<script>x</script>' });
  const res = await bob.agent.get(`/u/${alice.id}`);
  assert.doesNotMatch(res.text, /<script>x<\/script>/);
});

test('logged-out visitors are sent to login', async () => {
  await request(app).get('/').expect(302).expect('Location', '/login');
});
