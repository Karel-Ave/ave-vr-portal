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
  // Safe migration: add theme column if it doesn't exist yet
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS theme VARCHAR(5) DEFAULT 'light'
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

  // Uživatelské preference (výchozí rozpis, pořadí aplikací)
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id          INTEGER PRIMARY KEY,
      default_raspis_key VARCHAR(20),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS app_order TEXT DEFAULT NULL`);

  // ── Blacklist ─────────────────────────────────────────────────────────────

  await db.query(`
    CREATE TABLE IF NOT EXISTS blacklist_entries (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       VARCHAR(200) NOT NULL,
      hotel      VARCHAR(100),
      birth_date TEXT,
      damage     VARCHAR(200),
      stay_date  DATE,
      reason     TEXT NOT NULL,
      added_at   TIMESTAMPTZ DEFAULT NOW(),
      added_by   VARCHAR(200) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS blacklist_removed (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      original_id         UUID,
      original_name       VARCHAR(200),
      original_hotel      VARCHAR(100),
      original_birth_date TEXT,
      original_damage     VARCHAR(200),
      original_stay_date  DATE,
      original_reason     TEXT,
      original_added_at   TIMESTAMPTZ,
      original_added_by   VARCHAR(200),
      removal_reason      TEXT NOT NULL,
      removed_at          TIMESTAMPTZ DEFAULT NOW(),
      removed_by          VARCHAR(200) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS blacklist_intro (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      content    TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by VARCHAR(200)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS blacklist_audit (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action            VARCHAR(20) NOT NULL,
      payload           JSONB NOT NULL,
      user_name         VARCHAR(200) NOT NULL,
      timestamp         TIMESTAMPTZ DEFAULT NOW(),
      notified_by_email BOOLEAN DEFAULT FALSE
    )
  `);

  // Záznamy (logy) systémových akcí
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id         SERIAL PRIMARY KEY,
      timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name  VARCHAR(100) NOT NULL,
      action     VARCHAR(50)  NOT NULL,
      details    JSONB        NOT NULL DEFAULT '{}'
    )
  `);

  // Seed: výchozí úvodní text
  const introCheck = await db.query('SELECT COUNT(*) AS cnt FROM blacklist_intro');
  if (parseInt(introCheck.rows[0].cnt, 10) === 0) {
    const defaultIntro = `<p>Tyto hosty v žádném případě neubytovávat!!! Ani v případě, kdy tvrdí, že jsme jim ubytování potvrdili.</p><p>Pokud posoudíte, že jste schopni od bývalých hostů níže vybrat dlužnou částku při kasírování „nové" <u>fiktivní</u> rezervace a poté je až odmítnout učiňte tak. Pokud se však obáváte konfliktu, nepouštějte se do něj a rovnou je odmítněte ubytovat, až poté je požádejte o uhrazení dlužné částky.</p><p>V případě potíží při odmítnutí ubytovat hosta či stížností na vybranou částku za předešlé škody, volejte VRQ.</p>`;
    await db.query(`INSERT INTO blacklist_intro (id, content) VALUES (1, $1)`, [defaultIntro]);
  }

  // Seed: počáteční data (199 osob) pokud je tabulka prázdná
  const blCheck = await db.query('SELECT COUNT(*) AS cnt FROM blacklist_entries');
  if (parseInt(blCheck.rows[0].cnt, 10) === 0) {
    const seedData = require('./seed_data.json');
    for (const entry of seedData) {
      const stayDate = entry.stayDate && /^\d{4}-\d{2}-\d{2}$/.test(entry.stayDate) ? entry.stayDate : null;
      const birthDate = entry.birthDate != null ? String(entry.birthDate) : null;
      const damage = entry.damage != null ? String(entry.damage) : null;
      await db.query(
        `INSERT INTO blacklist_entries (name, hotel, birth_date, damage, stay_date, reason, added_at, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
        [entry.name, entry.hotel || null, birthDate, damage, stayDate, entry.reason, 'Import (původní Excel)']
      );
    }
    console.log(`Blacklist: importováno ${seedData.length} záznamů.`);
  }

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

  // ── Zprávy pro uživatele ──────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name VARCHAR(100) NOT NULL,
      content     TEXT NOT NULL,
      target_type VARCHAR(20) NOT NULL DEFAULT 'all',
      target_ids  TEXT NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ DEFAULT NULL
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at    TIMESTAMPTZ DEFAULT NOW(),
      dismissed  BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (message_id, user_id)
    )
  `);

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
