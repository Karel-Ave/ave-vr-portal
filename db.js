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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_skin VARCHAR(30) DEFAULT 'default'
  `);
  await db.query(`
    ALTER TABLE users ALTER COLUMN theme_skin SET DEFAULT 'default'
  `);
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_skin_light VARCHAR(30) DEFAULT 'indigo'
  `);
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_skin_dark VARCHAR(30) DEFAULT 'green'
  `);
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)
  `);
  await db.query(`
    ALTER TABLE users ALTER COLUMN theme_skin_light SET DEFAULT 'indigo'
  `);
  await db.query(`
    ALTER TABLE users ALTER COLUMN theme_skin_dark SET DEFAULT 'green'
  `);
  await db.query(`
    UPDATE users
       SET theme_skin_light = 'indigo'
     WHERE theme_skin_light IS NULL OR theme_skin_light IN ('default', 'mono')
  `);
  await db.query(`
    UPDATE users
       SET theme_skin_dark = 'green'
     WHERE theme_skin_dark IS NULL OR theme_skin_dark IN ('default', 'mono')
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
  await db.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS default_public_hotel VARCHAR(80) DEFAULT NULL`);
  await db.query(`ALTER TABLE user_preferences ALTER COLUMN default_public_hotel TYPE VARCHAR(80)`);
  await db.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS auto_logout_minutes INTEGER DEFAULT 30`);
  await db.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS default_views TEXT DEFAULT NULL`);

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
  // Přidej sloupec sublist (podlist), pokud ještě neexistuje
  await db.query(`ALTER TABLE permission_groups ADD COLUMN IF NOT EXISTS sublist VARCHAR(50) DEFAULT 'VR'`);

  // Individuální přepisy oprávnění pro uživatele
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS perm_overrides TEXT DEFAULT NULL`);

  // Seed výchozích skupin
  const adminPerms  = JSON.stringify({
    raspis: { enabled: true, visible: true, buttons: {
      tab_nastaveni: true, tab_tvorba: true, tab_rozpis_vr: true, tab_rozpis: true, tab_denni: true, tab_pozadavky: true,
      filters: true, show_qualified: true, mark: true, undo_redo: true, colors: true,
      fonds: true, paste_excel: true, import: true, unmatched: true, publish: true,
      delete: true, trash: true, edit: true, archive: true, log: true, export: true,
      req_create: true, req_edit: true, req_toggle_reception: true, req_send_tvorba: true, req_delete: true, req_archive: true,
      hotel_manager: true, settings_monthly: true, settings_add_staff: true, settings_clear_overrides: true
    } },
    priplatky: { enabled: true, visible: true, buttons: { viewAll: true, add: true, edit: true, delete: true, export: true, template: true, settings: true, manageReceptionists: true, manageTexts: true, internalNote: true } },
    blacklist: { enabled: true, visible: true, buttons: { view: true, add: true, remove: true, edit: true, export_pdf: true, export_email: true, edit_intro: true, history: true, history_delete: true } },
    admin: { enabled: true, visible: true, buttons: { users_add: true, users_edit: true, users_delete: true, user_permissions: true, groups_manage: true, logs_view: true, logs_delete: true } }
  });
  const vedPerms    = JSON.stringify({
    raspis: { enabled: true, visible: true, buttons: {
      tab_nastaveni: true, tab_tvorba: true, tab_rozpis_vr: true, tab_rozpis: true, tab_denni: true, tab_pozadavky: true,
      filters: true, show_qualified: true, mark: true, undo_redo: true, colors: false,
      fonds: true, paste_excel: true, import: false, unmatched: true, publish: true,
      delete: false, trash: false, edit: true, archive: false, log: false, export: true,
      req_create: true, req_edit: true, req_toggle_reception: true, req_send_tvorba: true, req_delete: false, req_archive: true,
      hotel_manager: false, settings_monthly: true, settings_add_staff: true, settings_clear_overrides: false
    } },
    priplatky: { enabled: true, visible: true, buttons: { viewAll: false, add: true, edit: true, delete: false, export: true, template: false, settings: false, manageReceptionists: false, manageTexts: false, internalNote: true } },
    blacklist: { enabled: true, visible: true, buttons: { view: true, add: true, remove: true, edit: true, export_pdf: true, export_email: true, edit_intro: false, history: true, history_delete: false } },
    admin: { enabled: false, visible: false, buttons: { users_add: false, users_edit: false, users_delete: false, user_permissions: false, groups_manage: false, logs_view: false, logs_delete: false } }
  });
  const hotelPerms = JSON.stringify({
    raspis: { enabled: true, visible: true, buttons: {
      tab_nastaveni: false, tab_tvorba: false, tab_rozpis_vr: false, tab_rozpis: false, tab_denni: true, tab_pozadavky: false,
      filters: false, show_qualified: false, mark: false, undo_redo: false, colors: false,
      fonds: false, paste_excel: false, import: false, unmatched: false, publish: false,
      delete: false, trash: false, edit: false, archive: false, log: false, export: false,
      req_create: false, req_edit: false, req_toggle_reception: false, req_send_tvorba: false, req_delete: false, req_archive: false,
      hotel_manager: false, settings_monthly: false, settings_add_staff: false, settings_clear_overrides: false
    } },
    priplatky: { enabled: false, visible: false, buttons: { viewAll: false, add: false, edit: false, delete: false, export: false, template: false, settings: false, manageReceptionists: false, manageTexts: false, internalNote: false } },
    blacklist: { enabled: false, visible: false, buttons: { view: false, add: false, remove: false, edit: false, export_pdf: false, export_email: false, edit_intro: false, history: false, history_delete: false } },
    admin: { enabled: false, visible: false, buttons: { users_add: false, users_edit: false, users_delete: false, user_permissions: false, groups_manage: false, logs_view: false, logs_delete: false } }
  });
  const recepPerms  = JSON.stringify({
    raspis: { enabled: true, visible: true, buttons: {
      tab_nastaveni: false, tab_tvorba: false, tab_rozpis_vr: false, tab_rozpis: true, tab_denni: true, tab_pozadavky: true,
      filters: true, show_qualified: false, mark: false, undo_redo: false, colors: false,
      fonds: false, paste_excel: false, import: false, unmatched: false, publish: false,
      delete: false, trash: false, edit: false, archive: false, log: false, export: false,
      req_create: false, req_edit: false, req_toggle_reception: false, req_send_tvorba: false, req_delete: false, req_archive: false,
      hotel_manager: false, settings_monthly: false, settings_add_staff: false, settings_clear_overrides: false
    } },
    priplatky: { enabled: true, visible: true, buttons: { viewAll: false, add: true, edit: true, delete: false, export: true, template: false, settings: false, manageReceptionists: false, manageTexts: false, internalNote: false } },
    blacklist: { enabled: true, visible: true, buttons: { view: true, add: false, remove: false, edit: false, export_pdf: false, export_email: false, edit_intro: false, history: false, history_delete: false } },
    admin: { enabled: false, visible: false, buttons: { users_add: false, users_edit: false, users_delete: false, user_permissions: false, groups_manage: false, logs_view: false, logs_delete: false } }
  });
  const pb6Perms = JSON.stringify({
    raspis: { enabled: true, visible: true, buttons: {
      tab_nastaveni: false, tab_tvorba: false, tab_rozpis_vr: false, tab_rozpis: false, tab_denni: true, tab_pozadavky: true,
      filters: true, show_qualified: false, mark: false, undo_redo: false, colors: false,
      fonds: false, paste_excel: false, import: false, unmatched: false, publish: false,
      delete: false, trash: false, edit: false, archive: false, log: false, export: false,
      req_create: false, req_edit: true, req_toggle_reception: false, req_send_tvorba: false, req_delete: false, req_archive: false,
      hotel_manager: false, settings_monthly: false, settings_add_staff: false, settings_clear_overrides: false
    } },
    priplatky: { enabled: false, visible: false, buttons: { viewAll: false, add: false, edit: false, delete: false, export: false, template: false, settings: false, manageReceptionists: false, manageTexts: false, internalNote: false } },
    blacklist: { enabled: false, visible: false, buttons: { view: false, add: false, remove: false, edit: false, export_pdf: false, export_email: false, edit_intro: false, history: false, history_delete: false } },
    admin: { enabled: false, visible: false, buttons: { users_add: false, users_edit: false, users_delete: false, user_permissions: false, groups_manage: false, logs_view: false, logs_delete: false } }
  });
  await db.query(`INSERT INTO permission_groups (name, display_name, perms, sublist) VALUES ('admin','Admin',$1,'VR'),('vedoucí','VR',$2,'VR'),('recepční','Recepční',$3,'Recepční'),('pb6','PB6',$5,'PB6'),('hotely','Hotely',$4,'Hotely') ON CONFLICT (name) DO NOTHING`, [adminPerms, vedPerms, recepPerms, hotelPerms, pb6Perms]);
  await db.query(`UPDATE users SET role='hotely' WHERE role='widget'`);
  await db.query(`DELETE FROM permission_groups WHERE name='widget' AND NOT EXISTS (SELECT 1 FROM users WHERE role='widget')`);
  async function mergeGroupPermDefaults(groupName, defaults) {
    const { rows } = await db.query('SELECT perms FROM permission_groups WHERE name = $1', [groupName]);
    if (!rows.length) return;
    let current = {};
    try { current = rows[0].perms ? JSON.parse(rows[0].perms) : {}; } catch(e) { current = {}; }
    let changed = false;
    for (const [appKey, appDef] of Object.entries(defaults)) {
      if (!current[appKey]) {
        current[appKey] = appDef;
        changed = true;
        continue;
      }
      for (const key of ['enabled', 'visible']) {
        if (appDef[key] !== undefined && current[appKey][key] === undefined) {
          current[appKey][key] = appDef[key];
          changed = true;
        }
      }
      current[appKey].buttons = current[appKey].buttons || {};
      for (const [btnKey, btnVal] of Object.entries(appDef.buttons || {})) {
        if (current[appKey].buttons[btnKey] === undefined) {
          current[appKey].buttons[btnKey] = btnVal;
          changed = true;
        }
      }
    }
    if (changed) {
      await db.query('UPDATE permission_groups SET perms = $1 WHERE name = $2', [JSON.stringify(current), groupName]);
    }
  }
  await mergeGroupPermDefaults('admin', JSON.parse(adminPerms));
  await mergeGroupPermDefaults('vedoucí', JSON.parse(vedPerms));
  await mergeGroupPermDefaults('recepční', JSON.parse(recepPerms));
  await mergeGroupPermDefaults('hotely', JSON.parse(hotelPerms));
  await db.query(`UPDATE permission_groups SET display_name='PB6', perms=$1, sublist='PB6' WHERE name='pb6'`, [pb6Perms]);
  // Nastav sublists pro existující skupiny (pokud ještě mají DEFAULT hodnotu nebo NULL)
  await db.query(`UPDATE permission_groups SET sublist='VR'        WHERE name IN ('admin','vedoucí') AND (sublist IS NULL OR sublist='VR')`);
  await db.query(`UPDATE permission_groups SET sublist='PB6'       WHERE name='pb6'      AND (sublist IS NULL OR sublist='VR')`);
  await db.query(`UPDATE permission_groups SET display_name='Hotely', sublist='Hotely' WHERE name='hotely'`);
  await db.query(`UPDATE permission_groups SET sublist='Recepční'  WHERE name='recepční' AND (sublist IS NULL OR sublist='VR')`);

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

  // ── Log změn rozpisu ──────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS schedule_change_log (
      id          BIGSERIAL PRIMARY KEY,
      raspis_key  VARCHAR(20) NOT NULL,
      timestamp   TIMESTAMPTZ DEFAULT NOW(),
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name   VARCHAR(100) NOT NULL,
      is_saved    BOOLEAN NOT NULL DEFAULT FALSE,
      change_type VARCHAR(10) NOT NULL DEFAULT 'cell',
      staff_name  VARCHAR(100) NOT NULL,
      day         INTEGER,
      dn          VARCHAR(1),
      old_value   TEXT,
      new_value   TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_scl_key ON schedule_change_log (raspis_key, timestamp DESC)`);

  // ── Příplatky a pokuty: mapování login ↔ celé jméno ─────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS receptionist_logins (
      id        SERIAL PRIMARY KEY,
      login     VARCHAR(50) UNIQUE NOT NULL,
      full_name VARCHAR(200) NOT NULL,
      active    BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);

  // ── Příplatky a pokuty: záznamy ──────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS priplatky_zaznamy (
      id           SERIAL PRIMARY KEY,
      rok          INTEGER NOT NULL,
      mesic        INTEGER NOT NULL CHECK (mesic BETWEEN 1 AND 12),
      sekce        VARCHAR(50) NOT NULL CHECK (sekce IN ('braní směn','ostatní','recenze','školení','pokuta')),
      login        VARCHAR(50) NOT NULL,
      datum        DATE NOT NULL,
      hotel        VARCHAR(10),
      castka       INTEGER NOT NULL DEFAULT 0,
      poznamka     TEXT,
      partner      VARCHAR(20),
      klient       VARCHAR(200),
      koho_skolil  VARCHAR(200),
      vlozil       VARCHAR(100) NOT NULL,
      vlozeno_kdy  TIMESTAMPTZ DEFAULT NOW(),
      upravil      VARCHAR(100),
      upraveno_kdy TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pz_rok_mesic ON priplatky_zaznamy (rok, mesic)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pz_login    ON priplatky_zaznamy (login)`);
  await db.query(`ALTER TABLE priplatky_zaznamy ADD COLUMN IF NOT EXISTS internal_note TEXT`);

  // ── Příplatky a pokuty: předdefinované poznámky ──────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS priplatky_poznamky (
      id     SERIAL PRIMARY KEY,
      text   VARCHAR(500) NOT NULL,
      poradi INTEGER NOT NULL DEFAULT 0,
      typ    VARCHAR(20) NOT NULL DEFAULT 'brani'
    )
  `);
  // Migration: add typ column if it doesn't exist yet
  await db.query(`ALTER TABLE priplatky_poznamky ADD COLUMN IF NOT EXISTS typ VARCHAR(20) NOT NULL DEFAULT 'brani'`);
  // Migration: add built_in flag
  await db.query(`ALTER TABLE priplatky_poznamky ADD COLUMN IF NOT EXISTS built_in BOOLEAN NOT NULL DEFAULT FALSE`);
  // Seed: built-in brani entries (only if not already present)
  await db.query(`
    INSERT INTO priplatky_poznamky (text, typ, poradi, built_in)
    SELECT v.text, 'brani', v.poradi, TRUE
    FROM (VALUES ('Směna navíc', -2), ('Pohotovost', -1)) AS v(text, poradi)
    WHERE NOT EXISTS (
      SELECT 1 FROM priplatky_poznamky WHERE text = v.text AND typ = 'brani'
    )
  `);

  // Seed: receptionist_logins (65 recepčních) — jen pokud je tabulka prázdná
  {
    const { rows: rlRows } = await db.query('SELECT COUNT(*) AS cnt FROM receptionist_logins');
    if (parseInt(rlRows[0].cnt, 10) === 0) {
      const SEED = [
        ['MABS','Absolon Marek'],['ANTD','Antipin Dmitrii'],['AUGP','Augustin Patrik'],
        ['BAID','Baidiuk Dmytrii'],['MINA','Bartošková Mína'],['LIZA','Bendos Elizaveta'],
        ['BST','Beránek Stanislav'],['BERN','Bernat Luboš'],['BICI','Bičišťová Klaudie'],
        ['RADEK','Blahout Radek'],['BOGD','Bogdanovich Olesia'],['BRIS','Brisudová Anna'],
        ['BRO','Brovko Vjačeslav'],['BURD','Burda Tomáš'],['GLEB','Buslaev Gleb'],
        ['CIPL','Ciple Anna Mária'],['CAD','Čada Štěpán'],['CEH','Čermáková Helena'],
        ['CERN','Černocká Marie'],['DOGM','Dognal Mark'],['DUBI','Dubinina Viktorie'],
        ['FAL','Fialová Alena'],['FORT','Fořt David'],['HOP','Hoppeová Klára'],
        ['HUDK','Hudečková Kateřina'],['GIUS','Ielitro Giuseppe'],['SASHA','Ivanov Alexandr'],
        ['JANAJ','Juklová Jana'],['KLIM','Klimchenko Darya'],['KOCH','Kochurikhina Valeriia'],
        ['KONO','Konovalenko Yuriy'],['KRJ','Korejs Martin'],['KOAL','Kovářová Alice'],
        ['KUK','Kukelková Martina'],['KUUL','Kuular Saiana'],['LESL','Lesnichenka Lizaveta'],
        ['LINH','Linhartová Jana'],['LITV','Litvínov Vladimír'],['MAKH','Makhanova Malika'],
        ['MOTE','Motejlková Barbora'],['Jaroslav','Nechvátal Jaroslav'],['NERM','Nermesanová Manuela'],
        ['NGUY','Nguyen Thi Nhung'],['ROMANA','Nováková Romana'],['PAVE','Pavelka Filip'],
        ['PESS','Pešek Stanislav'],['POLA','Polášková Blanka'],['PROA','Prokhorian Anna'],
        ['SKR','Skřivánek Jan'],['SMOK','Smolová Kristýna'],['SMJ','Smrčková Jitka'],
        ['SEZ','Smutná Petra'],['OLES','Stalchenko Oleksandra'],['STEN','Stéblová Natálie'],
        ['IVAS','Stempak Ivan'],['SMEI','Šmejkalová Iva'],['STEO','Štěpánek Ondřej'],
        ['JUN','Štochlová Gabriela'],['TATA','Tatara Juraj'],['THA','Tremlová Hana'],
        ['TSAR','Tsarkov Valentin'],['VALE','Valeyeva Kristina'],['ALEKS','Viktorenkov Aleksei'],
        ['VORO','Voropaeva Anastasiia'],['VRAM','Vránek Matyáš'],
      ];
      for (const [login, full_name] of SEED) {
        await db.query(
          'INSERT INTO receptionist_logins (login, full_name) VALUES ($1,$2) ON CONFLICT (login) DO NOTHING',
          [login, full_name]
        );
      }
      console.log('Seed: receptionist_logins — vloženo', SEED.length, 'záznamů.');
    }
  }

  // ── Pracovní smlouvy: seznam recepčních ──────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS receptionist (
      id         SERIAL PRIMARY KEY,
      jmeno      VARCHAR(200) NOT NULL,
      login      VARCHAR(100) UNIQUE NOT NULL,
      telefon    VARCHAR(50),
      aktivni    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Pracovní smlouvy: rozpracované (drafts) ──────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS smlouvy_drafts (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      jmeno      VARCHAR(200),
      login      VARCHAR(100),
      data       JSONB NOT NULL,
      saved_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Master staff (globální seznam recepčních sdílený přes všechny uživatele) ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS master_staff (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      data        JSONB NOT NULL DEFAULT '[]',
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT  master_staff_single_row CHECK (id = 1)
    )
  `);

  // ── Raspis Test: separátní tabulky (nezávislá data) ────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS rt_drafts (
      id       SERIAL PRIMARY KEY,
      user_id  INTEGER NOT NULL,
      month    INTEGER NOT NULL,
      year     INTEGER NOT NULL,
      data     TEXT NOT NULL,
      saved_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, month, year)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rt_drafts_trash (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      original_id INTEGER,
      month       INTEGER NOT NULL,
      year        INTEGER NOT NULL,
      data        TEXT NOT NULL,
      deleted_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rt_schedules (
      key          VARCHAR(20) PRIMARY KEY,
      month        INTEGER NOT NULL,
      year         INTEGER NOT NULL,
      label        VARCHAR(100) NOT NULL,
      data         TEXT NOT NULL,
      published_at TIMESTAMPTZ DEFAULT NOW(),
      published_by VARCHAR(100) NOT NULL
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rt_schedules_trash (
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS rt_change_log (
      id           BIGSERIAL PRIMARY KEY,
      schedule_key VARCHAR(20) NOT NULL,
      timestamp    TIMESTAMPTZ DEFAULT NOW(),
      user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name    VARCHAR(100) NOT NULL,
      is_saved     BOOLEAN NOT NULL DEFAULT FALSE,
      change_type  VARCHAR(10) NOT NULL DEFAULT 'cell',
      staff_name   VARCHAR(100) NOT NULL,
      day          INTEGER,
      dn           VARCHAR(1),
      old_value    TEXT,
      new_value    TEXT
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rt_requirements (
      key              VARCHAR(20) PRIMARY KEY,
      month            INTEGER NOT NULL,
      year             INTEGER NOT NULL,
      label            VARCHAR(100) NOT NULL,
      data             TEXT NOT NULL,
      status           VARCHAR(20) NOT NULL DEFAULT 'draft',
      allow_duplicates BOOLEAN NOT NULL DEFAULT TRUE,
      xy_locks         TEXT NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      created_by       VARCHAR(100),
      updated_by       VARCHAR(100),
      opened_at        TIMESTAMPTZ,
      closed_at        TIMESTAMPTZ,
      sent_to_tvorba_at TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rt_requirements_log (
      id        BIGSERIAL PRIMARY KEY,
      req_key   VARCHAR(20) NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name VARCHAR(100) NOT NULL,
      action    VARCHAR(50) NOT NULL,
      details   TEXT
    )
  `);
  await db.query(`ALTER TABLE rt_requirements ADD COLUMN IF NOT EXISTS allow_duplicates BOOLEAN NOT NULL DEFAULT TRUE`);
  await db.query(`ALTER TABLE rt_requirements ADD COLUMN IF NOT EXISTS xy_locks TEXT NOT NULL DEFAULT '{}'`);
  await db.query(`ALTER TABLE rt_requirements ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE rt_requirements ADD COLUMN IF NOT EXISTS archived_by VARCHAR(100)`);
  await db.query(`ALTER TABLE rt_requirements ADD COLUMN IF NOT EXISTS sent_to_tvorba_at TIMESTAMPTZ`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_rtcl_key ON rt_change_log (schedule_key, timestamp DESC)`);

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

  // ── Receptionist user accounts migration ─────────────────────────────────────
  {
    const { rows: recCheck } = await db.query("SELECT COUNT(*) AS cnt FROM users WHERE username = 'MABS'");
    if (parseInt(recCheck[0].cnt, 10) === 0) {
      const bcrypt = require('bcryptjs');
      const RECEPTIONIST_SEED = [
        ['MABS',    'Absolon Marek',           'Denní', 'DPP'],
        ['ANTD',    'Antipin Dmitrii',          'Noční', 'HPP'],
        ['AUGP',    'Augustin Patrik',          'Denní', 'HPP'],
        ['BAID',    'Baidiuk Dmytrii',          'Obojí', 'HPP'],
        ['MINA',    'Bartošková Mína',          'Denní', 'DPP'],
        ['LIZA',    'Bendos Elizaveta',         'Obojí', 'HPP'],
        ['BST',     'Beránek Stanislav',        'Denní', 'HPP'],
        ['BERN',    'Bernat Luboš',             'Denní', 'DPČ'],
        ['BICI',    'Bičišťová Klaudie',        'Denní', 'HPP'],
        ['RADEK',   'Blahout Radek',            'Denní', 'HPP'],
        ['BOGD',    'Bogdanovich Olesia',       'Noční', 'ZPP'],
        ['BRIS',    'Brisudová Anna',           'Noční', 'ZPP'],
        ['BRO',     'Brovko Vjačeslav',         'Denní', 'HPP'],
        ['BURD',    'Burda Tomáš',              'Noční', 'HPP'],
        ['GLEB',    'Buslaev Gleb',             'Denní', 'DPP'],
        ['CIPL',    'Ciple Anna Maria',         'Noční', 'HPP'],
        ['CAD',     'Čada Štěpán',              'Denní', 'HPP'],
        ['CEH',     'Čermáková Helena',         'Denní', 'ZPP'],
        ['CERN',    'Černocká Marie',           'Denní', 'DPČ'],
        ['DOGM',    'Dognal Mark',              'Noční', 'HPP'],
        ['DUBI',    'Dubinina Viktorie',        'Noční', 'HPP'],
        ['FAL',     'Fialová Alena',            'Denní', 'HPP'],
        ['FORT',    'Fořt David',               'Noční', 'HPP'],
        ['HOP',     'Hoppeová Klára',           'Denní', 'HPP'],
        ['HUDK',    'Hudečková Kateřina',       'Denní', 'DPČ'],
        ['GIUS',    'Ielitro Giuseppe',         'Denní', 'HPP'],
        ['SASHA',   'Ivanov Alexandr',          'Noční', 'HPP'],
        ['JANAJ',   'Juklová Jana',             'Denní', 'ZPP'],
        ['KLIM',    'Klimchenko Darya',         'Denní', 'HPP'],
        ['KOCH',    'Kochurikhina Valeriia',    'Noční', 'HPP'],
        ['KONO',    'Konovalenko Yuriy',        'Denní', 'HPP'],
        ['KRJ',     'Korejs Martin',            'Noční', 'HPP'],
        ['KOAL',    'Kovářová Alice',           'Denní', 'HPP'],
        ['KUK',     'Kukelková Martina',        'Denní', 'HPP'],
        ['KUUL',    'Kuular Saiana',            'Noční', 'HPP'],
        ['LESL',    'Lesnichenka Liza',         'Denní', 'DPČ'],
        ['LINH',    'Linhartová Jana',          'Denní', 'ZPP'],
        ['LITV',    'Litvínov Vladimír',        'Obojí', 'HPP'],
        ['MAKH',    'Makhanova Malika',         'Noční', 'HPP'],
        ['MOTE',    'Motejlková Barbora',       'Denní', 'HPP'],
        ['JAROSLAV','Nechvátal Jaroslav',       'Noční', 'HPP'],
        ['NERM',    'Nermesanová Manuela',      'Obojí', 'HPP'],
        ['NGUY',    'Nguyen Thi Nhung',         'Noční', 'ZPP'],
        ['ROMANA',  'Nováková Romana',          'Denní', 'HPP'],
        ['PAVE',    'Pavelka Filip',            'Denní', 'HPP'],
        ['PESS',    'Pešek Stanislav',          'Noční', 'DPČ'],
        ['POLA',    'Polášková Blanka',         'Denní', 'HPP'],
        ['PROA',    'Prokhorian Anna',          'Denní', 'HPP'],
        ['SKR',     'Skřivánek Jan',            'Denní', 'HPP'],
        ['SMOK',    'Smolová Kristýna',         'Noční', 'DPČ'],
        ['SMJ',     'Smrčková Jitka',           'Denní', 'ZPP'],
        ['SEZ',     'Smutná Petra',             'Denní', 'HPP'],
        ['OLES',    'Stalchenko Oleksandra',    'Obojí', 'HPP'],
        ['STEN',    'Stéblová Natálie',          'Denní', 'DPP'],
        ['IVAS',    'Stempak Ivan',             'Noční', 'DPČ'],
        ['SMEI',    'Šmejkalová Iva',           'Noční', 'HPP'],
        ['STEO',    'Štěpánek Ondřej',          'Denní', 'HPP'],
        ['JUN',     'Štochlová Gabriela',       'Denní', 'HPP'],
        ['TATA',    'Tatara Juraj',             'Denní', 'ZPP'],
        ['THA',     'Tremlová Hana',            'Denní', 'HPP'],
        ['TSAR',    'Tsarkov Valentin',         'Noční', 'HPP'],
        ['VALE',    'Valeyeva Kristina',        'Denní', 'HPP'],
        ['ALEKS',   'Viktorenkov Aleksei',      'Noční', 'HPP'],
        ['VORO',    'Voropaeva Anastasiia',     'Obojí', 'HPP'],
        ['VRAM',    'Vránek Matyáš',            'Denní', 'DPP'],
      ];
      for (const [login, name, type, contract] of RECEPTIONIST_SEED) {
        const hash = await bcrypt.hash(login + '123', 10);
        const { rows: ins } = await db.query(
          `INSERT INTO users (name, username, password_hash, role)
           VALUES ($1, $2, $3, 'vedoucí')
           ON CONFLICT (username) DO NOTHING
           RETURNING id`,
          [name, login, hash]
        );
        if (ins.length > 0) {
          const overrides = JSON.stringify({
            raspis_staff: {
              active: true,
              displayName: name,
              login,
              type,
              contract,
              activeFrom: { month: 5, year: 2026 }
            }
          });
          await db.query('UPDATE users SET perm_overrides = $1 WHERE id = $2', [overrides, ins[0].id]);
        }
      }
      console.log('Seed: vytvořeno', RECEPTIONIST_SEED.length, 'účtů recepčních.');
    }
  }

  // ── Migrace: přesun recepčních z role vedoucí → recepční ─────────────────
  {
    const { rows: migRows } = await db.query(
      `UPDATE users SET role = 'recepční'
       WHERE role = 'vedoucí'
         AND perm_overrides IS NOT NULL
         AND perm_overrides::text LIKE '%"raspis_staff"%'
       RETURNING id`
    );
    if (migRows.length > 0) console.log(`Migrace: ${migRows.length} recepčních přesunuto do skupiny recepční.`);
  }

  // ── Oprava překlepů v jménech recepčních ──────────────────────────────────
  {
    const namefixes = [
      ['Baiduk Dmytrii',   'Baidiuk Dmytrii',  'BAID'],
      ['Steblová Natálie', 'Stéblová Natálie',  'STEN'],
    ];
    for (const [oldName, newName, login] of namefixes) {
      const { rows } = await db.query(
        `SELECT id, perm_overrides FROM users WHERE username = $1`, [login]
      );
      if (rows.length && rows[0].perm_overrides) {
        let ov = typeof rows[0].perm_overrides === 'string'
          ? JSON.parse(rows[0].perm_overrides) : rows[0].perm_overrides;
        if (ov?.raspis_staff?.displayName === oldName) {
          ov.raspis_staff.displayName = newName;
          await db.query(
            `UPDATE users SET name = $1, perm_overrides = $2 WHERE id = $3`,
            [newName, JSON.stringify(ov), rows[0].id]
          );
          console.log(`Opraveno jméno: ${oldName} → ${newName}`);
        }
      }
    }
  }

  console.log('Databáze připravena.');
}

module.exports = { getPool, init };
