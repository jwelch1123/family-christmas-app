// Usage: heroku run node scripts/reset-pin.js "Name"
// Clears that person's PIN so they can set a new one (with the family code).
const db = require('../db');
const name = process.argv[2];
if (!name) {
  console.log('Usage: node scripts/reset-pin.js "Name"');
  process.exit(1);
}
db.query('UPDATE users SET pin_hash = NULL WHERE lower(name) = lower($1)', [name])
  .then(({ rowCount }) => {
    console.log(rowCount ? `PIN cleared for ${name}.` : `No one named ${name}.`);
    process.exit(0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
