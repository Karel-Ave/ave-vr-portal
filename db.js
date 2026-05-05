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
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`);

  // Koncepty (Tvorba rozpisu) — jeden na uživatele × měsíc/rok
  await db.query(`
    CREATE TABLE IF NOT EXISTS drafts (
      id       SERIAL PRIMARY KEY,
      user_id  INTEGER NOT NULL,
      month    INTEGER NOT NULL,
      year     INTEGER NOT NULL,
      data     TEXT NOT NULL,
      saved_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, month, year)
    )
  `);

  // Koš smazaných konceptů
  await db.query(`
    CREATE TABLE IF NOT EXISTS drafts_trash (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      original_id INTEGER,
      month       INTEGER NOT NULL,
      year        INTEGER NOT NULL,
      data        TEXT NOT NULL,
      deleted_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Koš smazaných publikovaných rozpisů
  await db.query(`
    CREATE TABLE IF NOT EXISTS rozpisy_trash (
      id           SERIAL PRIMARY KEY,
      key          VARCHAR(20) NOT NULL,
      month        INTEGER NOT NULL,
      year         INTEGER NOT NULL,
      label        VARCHAR(100) NOT NULL,
      data         TEXT NOT NULL,
      published_at TIMESTAMPTZ,
      published_by VARCHAR(100),
      deleted_at   TIMESTAMPTZ DEFAULT NOW(),
      deleted_by   VARCHAR(100) NOT NULL
    )
  `);

  // Uživatelské preference (výchozí rozpis)
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id          INTEGER PRIMARY KEY,
      default_raspis_key VARCHAR(20),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Skupiny oprávnění
  await db.query(`
    CREATE TABLE IF NOT EXISTS permission_groups (
      name         VARCHAR(50) PRIMARY KEY,
      display_name VARCHAR(100) NOT NULL,
      perms        TEXT NOT NULL DEFAULT '{}'
    )
  `);

  // Individuální přepisy oprávnění pro uživatele
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS perm_overrides TEXT DEFAULT NULL`);

  // Seed výchozích skupin
  const adminPerms  = JSON.stringify({ raspis: { enabled: true, buttons: { import: true, delete: true, trash: true, edit: true, export: true } } });
  const vedPerms    = JSON.stringify({ raspis: { enabled: true, buttons: { import: false, delete: false, trash: false, edit: true, export: true } } });
  await db.query(`INSERT INTO permission_groups (name, display_name, perms) VALUES ('admin','Admin',$1),('vedoucí','VR',$2) ON CONFLICT (name) DO NOTHING`, [adminPerms, vedPerms]);

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
