const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL není nastavená. Přidejte PostgreSQL plugin v Railway dashboardu.');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    pool.on('error', (err) => console.error('Chyba PostgreSQL poolu:', err));
  }
  return pool;
}

async function init() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id        SERIAL PRIMARY KEY,
      name      VARCHAR(100) NOT NULL,
      username  VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role      VARCHAR(20) NOT NULL DEFAULT 'vedoucí',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key        VARCHAR(100) PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS rozpisy (
      key          VARCHAR(20) PRIMARY KEY,
      month        INTEGER NOT NULL,
      year         INTEGER NOT NULL,
      label        VARCHAR(100) NOT NULL,
      data         TEXT NOT NULL,
      published_at TIMESTAMPTZ DEFAULT NOW(),
      published_by VARCHAR(100) NOT NULL
    )
  `);

  // Tabulka pro sessions
  await db.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL COLLATE "default",
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
    ) WITH (OIDS=FALSE)
  `).catch(() => {
    // Tabulka už existuje nebo constraint conflict - ignorujeme
  });
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`);

  // Seed: pokud nejsou žádní uživatelé, vytvoř admina
  const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM users');
  if (parseInt(rows[0].cnt, 10) === 0) {
    const bcrypt = require('bcryptjs');
    await db.query(
      'INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, $4)',
      ['Karel', 'Karel-Ave', bcrypt.hashSync('Karel.AVE', 10), 'admin']
    );
    console.log('Vytvořen výchozí admin: Karel-Ave / Karel.AVE');
  }

  console.log('Databáze připravena.');
}

module.exports = { getPool, init };
