const { app } = require('./app');
const db = require('./db');

const members = (process.env.FAMILY_MEMBERS || 'Mom,Dad,Alex,Sam,Jordan,Taylor')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const port = process.env.PORT || 3000;

db.init(members)
  .then(() => app.listen(port, () => console.log(`🎄 Gift lists running on port ${port}`)))
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
