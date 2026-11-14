const { app } = require('./app');
const db = require('./db');

const port = process.env.PORT || 3000;

db.init()
  .then(() => app.listen(port, () => console.log(`🎄 Gift lists running on port ${port}`)))
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
