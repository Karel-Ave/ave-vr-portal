const express     = require('express');
const session     = require('express-session');
const bcrypt      = require('bcryptjs');
const path        = require('path');
const PDFDocument = require('pdfkit');
const { getPool, init } = require('./db');

const app  = express();
const PORT = process.env.PORT || 8080;
const SESSION_MAX_AGE = 10 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_LIGHT_SKIN = 'indigo';
const DEFAULT_DARK_SKIN = 'green';
const THEME_SKINS = new Set(['default','mono','graphite','slate','blue','teal','green','olive','amber','rose','violet','indigo','cyan','mint','lime','yellow','orange','red','pink','plum','coffee','navy']);
const AUTO_LOGOUT_ALLOWED_MINUTES = new Set([0, 30, 60, 720]);

function normalizeThemeSkin(skin, fallback = 'default') {
  const raw = String(skin || fallback || 'default').toLowerCase();
  if (!THEME_SKINS.has(raw)) return fallback || 'default';
  return raw === 'mono' ? 'default' : raw;
}

function selectedModeSkin(theme, lightSkin, darkSkin) {
  return theme === 'dark'
    ? normalizeThemeSkin(darkSkin, DEFAULT_DARK_SKIN)
    : normalizeThemeSkin(lightSkin, DEFAULT_LIGHT_SKIN);
}

function sessionUserFromDbUser(user) {
  const theme = user.theme === 'dark' ? 'dark' : 'light';
  const legacySkin = normalizeThemeSkin(user.theme_skin, theme === 'dark' ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN);
  const lightSkin = normalizeThemeSkin(user.theme_skin_light, DEFAULT_LIGHT_SKIN);
  const darkSkin = normalizeThemeSkin(user.theme_skin_dark, DEFAULT_DARK_SKIN);
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    theme,
    theme_skin: selectedModeSkin(theme, lightSkin || legacySkin, darkSkin || legacySkin),
    theme_skin_light: lightSkin || DEFAULT_LIGHT_SKIN,
    theme_skin_dark: darkSkin || DEFAULT_DARK_SKIN
  };
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

// Statické soubory
app.use('/static', express.static(path.join(__dirname, 'public')));
// Apple touch icon (pro iOS Oblíbené/plochu)
app.get('/apple-touch-icon.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon.png')));
app.get('/apple-touch-icon-precomposed.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon.png')));

// Sessions uložené v PostgreSQL
const pgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new pgSession({
    pool: getPool(),
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'ave-portal-2026-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: SESSION_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ── Auth helpery ──────────────────────────────────────────────────────────────

const requireLogin = (req, res, next) =>
  req.session.user ? next() : res.redirect('/');

const requireAdmin = (req, res, next) =>
  req.session.user?.role === 'admin' ? next() : res.redirect('/portal');

const requirePortalAccess = (req, res, next) => {
  if (!req.session.user) return res.redirect('/');
  return next();
};

// ── In-memory zámky (zabrání dvěma uživatelům editovat zároveň) ──────────────

function releaseUserLocks(userId) {
  Object.keys(locks).forEach(k => {
    if (locks[k]?.userId === userId) {
      delete locks[k];
      if (lockTimers[k]) {
        clearTimeout(lockTimers[k]);
        delete lockTimers[k];
      }
    }
  });
}

function sessionExpiredResponse(req, res) {
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, expired: true });
  return res.redirect('/?expired=1');
}

async function getAutoLogoutMinutes(userId) {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT auto_logout_minutes FROM user_preferences WHERE user_id = $1',
    [userId]
  );
  const minutes = Number(rows[0]?.auto_logout_minutes);
  return AUTO_LOGOUT_ALLOWED_MINUTES.has(minutes) ? minutes : 60;
}

async function destroyAllSessionsForUser(userId) {
  const db = getPool();
  await db.query(
    `DELETE FROM session WHERE sess::json->'user'->>'id' = $1`,
    [String(userId)]
  );
}

app.use(async (req, res, next) => {
  const user = req.session.user;
  if (!user?.id) return next();
  if (req.path === '/logout') return next();

  try {
    const minutes = await getAutoLogoutMinutes(user.id);
    if (minutes === 0) return next();

    const now = Date.now();
    const lastActivity = Number(req.session.lastActivityAt || req.session.loginAt || now);
    if (now - lastActivity > minutes * 60 * 1000) {
      releaseUserLocks(user.id);
      await destroyAllSessionsForUser(user.id);
      return req.session.destroy(() => sessionExpiredResponse(req, res));
    }

    const methodTouches = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const pathTouches = req.path === '/api/session/activity' || (!req.path.startsWith('/api/') && req.method === 'GET');
    if (methodTouches || pathTouches) req.session.lastActivityAt = now;
    return next();
  } catch (err) {
    console.error('Auto logout check error:', err.message);
    return next();
  }
});

const locks = {};
const lockTimers = {};
const LOCK_TTL = 10 * 60 * 1000; // 10 minut

// ── Widget SSE ─────────────────────────────────────────────────────────────────
const widgetSseClients = new Set();

function broadcastWidgetUpdate() {
  const msg = 'data: update\n\n';
  for (const res of widgetSseClients) {
    try { res.write(msg); } catch (e) { widgetSseClients.delete(res); }
  }
}

function setLockTimer(key) {
  if (lockTimers[key]) clearTimeout(lockTimers[key]);
  lockTimers[key] = setTimeout(() => { delete locks[key]; delete lockTimers[key]; }, LOCK_TTL);
}

// ── Logging helper ────────────────────────────────────────────────────────────

async function logEvent(userId, userName, action, details = {}) {
  if (action !== 'login') return;
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO logs (user_id, user_name, action, details) VALUES ($1, $2, $3, $4)`,
      [userId || null, userName, action, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('logEvent chyba:', err.message);
  }
}

// ── Pomocné funkce oprávnění ──────────────────────────────────────────────────

function _parseJson(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return {}; }
}

async function getUserEffectivePerms(user) {
  const db = getPool();
  const [gr, ur] = await Promise.all([
    db.query('SELECT perms FROM permission_groups WHERE name = $1', [user.role]),
    db.query('SELECT perm_overrides FROM users WHERE id = $1', [user.id])
  ]);
  const groupPerms = gr.rows.length ? _parseJson(gr.rows[0].perms) : {};
  const userOv     = (ur.rows.length && ur.rows[0].perm_overrides) ? _parseJson(ur.rows[0].perm_overrides) : {};
  return { groupPerms, userOv };
}

function getEffectiveBtnPerm(groupPerms, userOv, appKey, btnKey) {
  const gp = groupPerms[appKey] || {};
  const uo = userOv[appKey]     || {};
  const gb = (gp.buttons || {})[btnKey];
  const ub = (uo.buttons || {})[btnKey];
  const val = (ub != null) ? ub : (gb != null ? gb : true);
  return val !== false;
}

function getEffectiveBtnPermDefault(groupPerms, userOv, appKey, btnKey, defaultValue = true) {
  const gp = groupPerms[appKey] || {};
  const uo = userOv[appKey]     || {};
  const gb = (gp.buttons || {})[btnKey];
  const ub = (uo.buttons || {})[btnKey];
  const val = (ub != null) ? ub : (gb != null ? gb : defaultValue);
  return val === true;
}

function userIdentityValues(user) {
  return [...new Set([user?.username, user?.login, user?.name, user?.full_name]
    .filter(Boolean)
    .map(v => String(v).trim().toLowerCase())
    .filter(Boolean))];
}

function formatPhoneForStorage(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '+') return null;
  let prefix = '+420';
  let rest = raw;
  const match = raw.match(/^\s*(\+\d{1,4})\s*(.*)$/);
  if (match) {
    prefix = match[1];
    rest = match[2] || '';
  }
  const digits = rest.replace(/\D/g, '');
  if (!digits) return null;
  return `${prefix} ${digits.replace(/(.{3})(?=.)/g, '$1 ')}`.trim();
}

async function canViewAllPriplatky(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const { groupPerms, userOv } = await getUserEffectivePerms(user);
  return getEffectiveBtnPermDefault(groupPerms, userOv, 'priplatky', 'viewAll', false);
}

async function canUsePriplatkyInternalNote(user) {
  return hasButtonPerm(user, 'priplatky', 'internalNote', false);
}

async function hasButtonPerm(user, appKey, btnKey, defaultValue = true) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const { groupPerms, userOv } = await getUserEffectivePerms(user);
  return getEffectiveBtnPermDefault(groupPerms, userOv, appKey, btnKey, defaultValue);
}

function requirePermDefault(appKey, btnKey, defaultValue = true) {
  return async (req, res, next) => {
    try {
      if (await hasButtonPerm(req.session.user, appKey, btnKey, defaultValue)) return next();
      return res.status(403).json({ ok: false, msg: 'Nemáte oprávnění pro tuto akci.' });
    } catch (e) {
      console.error('Chyba ověření oprávnění:', e);
      return res.status(500).json({ ok: false, msg: 'Chyba ověření oprávnění.' });
    }
  };
}

async function priplatkyOwnFilter(user, alias = 'z', joinedAlias = 'rl') {
  if (await canViewAllPriplatky(user)) return { where: '', params: [] };
  const ids = userIdentityValues(user);
  if (!ids.length) return { where: ' AND 1=0', params: [] };
  return {
    where: ` AND (LOWER(${alias}.login) = ANY($IDX::text[]) OR LOWER(COALESCE(${joinedAlias}.full_name,'')) = ANY($IDX::text[]))`,
    params: [ids]
  };
}

async function canTouchPriplatkyLogin(req, login) {
  if (await canViewAllPriplatky(req.session.user)) return true;
  return userIdentityValues(req.session.user).includes(String(login || '').trim().toLowerCase());
}

async function canTouchPriplatkyRecord(req, db, id) {
  if (await canViewAllPriplatky(req.session.user)) return true;
  const ids = userIdentityValues(req.session.user);
  if (!ids.length) return false;
  const { rows } = await db.query(
    `SELECT z.id
     FROM priplatky_zaznamy z
     LEFT JOIN receptionist_logins rl ON rl.login = z.login
     WHERE z.id = $1
       AND (LOWER(z.login) = ANY($2::text[]) OR LOWER(COALESCE(rl.full_name,'')) = ANY($2::text[]))`,
    [id, ids]
  );
  return rows.length > 0;
}

// Middleware: vyžaduje oprávnění pro danou aplikaci a tlačítko
function parsePermOverridesValue(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return {}; }
  }
  return value || {};
}

async function loadPortalReceptionistNameMap(db) {
  const { rows } = await db.query(
    `SELECT name, username, perm_overrides
     FROM users
     WHERE perm_overrides IS NOT NULL`
  );
  const out = new Map();
  for (const u of rows) {
    const overrides = parsePermOverridesValue(u.perm_overrides);
    const rs = overrides?.raspis_staff;
    if (!rs || !rs.active) continue;
    const login = String(rs.login || u.username || '').trim();
    if (!login) continue;
    out.set(login.toLowerCase(), rs.displayName || u.name || login);
  }
  return out;
}

function applyPortalReceptionistNames(rows, nameMap) {
  (rows || []).forEach(row => {
    const login = String(row.login || '').trim().toLowerCase();
    if (login && nameMap.has(login)) row.full_name = nameMap.get(login);
  });
  return rows;
}

async function syncReceptionistLoginFromUser(db, userId, previousLogin = null) {
  const { rows } = await db.query(
    'SELECT name, username, perm_overrides FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length) return;
  const u = rows[0];
  const overrides = parsePermOverridesValue(u.perm_overrides);
  const rs = overrides?.raspis_staff;
  if (!rs || !rs.active) return;
  const login = String(rs.login || u.username || '').trim().toUpperCase();
  const fullName = String(rs.displayName || u.name || login).trim();
  if (!login || !fullName) return;
  await db.query(
    `INSERT INTO receptionist_logins (login, full_name, active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (login) DO UPDATE SET full_name = EXCLUDED.full_name, active = TRUE`,
    [login, fullName]
  );
  const oldLogin = String(previousLogin || '').trim().toUpperCase();
  if (oldLogin && oldLogin !== login) {
    await db.query(
      `INSERT INTO receptionist_logins (login, full_name, active)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (login) DO UPDATE SET full_name = EXCLUDED.full_name, active = FALSE`,
      [oldLogin, fullName]
    );
  }
}

function requirePerm(appKey, btnKey) {
  return async (req, res, next) => {
    const user = req.session.user;
    if (user.role === 'admin') return next();
    try {
      const { groupPerms, userOv } = await getUserEffectivePerms(user);
      if (getEffectiveBtnPerm(groupPerms, userOv, appKey, btnKey)) return next();
      return res.json({ ok: false, msg: 'Nemáte oprávnění pro tuto akci.' });
    } catch (e) {
      console.error('Chyba ověření oprávnění:', e);
      return res.json({ ok: false, msg: 'Chyba ověření oprávnění.' });
    }
  };
}

// ── Stránky ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (!req.session.user) return res.sendFile(path.join(__dirname, 'views', 'login.html'));
  return res.redirect('/portal');
});

app.get('/portal', requirePortalAccess, (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'portal.html'))
);

app.get('/admin', requireLogin, requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'admin.html'))
);

// Tvorba rozpisu — pouze admin
app.get('/tvorba-rozpisu', requireLogin, requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'raspis.html'))
);

// Zobrazení/editace hotového rozpisu — admin i vedoucí
app.get('/rozpis-view', requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'raspis.html'))
);

// Samostatná karta Rozpis (recepční pohled) — dedikovaná lehká stránka
app.get('/rozpis', requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'rozpis-recep.html'))
);

// Raspis Test — nová samostatná karta (separátní data)
app.get('/raspis-test', requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'raspis-test.html'))
);

app.get('/dovolene', requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'dovolene.html'))
);

// Stará adresa widgetu zůstává funkční jako přesměrování do portálu.
app.get('/widget', requireLogin, (req, res) => res.redirect('/portal'));

// ── API: Auth ─────────────────────────────────────────────────────────────────

app.get('/api/me', requireLogin, (req, res) => res.json(req.session.user));

app.get('/api/session/status', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  res.json({ ok: true });
});

app.post('/api/session/activity', requireLogin, (req, res) => {
  req.session.lastActivityAt = Date.now();
  res.json({ ok: true });
});

// Save theme preference for the current user
app.patch('/api/me/theme', requireLogin, async (req, res) => {
  const theme = req.body.theme === 'dark' ? 'dark' : 'light';
  const currentLight = req.session.user.theme_skin_light || DEFAULT_LIGHT_SKIN;
  const currentDark = req.session.user.theme_skin_dark || DEFAULT_DARK_SKIN;
  let lightSkin = normalizeThemeSkin(req.body.theme_skin_light || req.body.lightSkin || currentLight, DEFAULT_LIGHT_SKIN);
  let darkSkin = normalizeThemeSkin(req.body.theme_skin_dark || req.body.darkSkin || currentDark, DEFAULT_DARK_SKIN);
  if (req.body.skin) {
    const skin = normalizeThemeSkin(req.body.skin, theme === 'dark' ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN);
    if (theme === 'dark') darkSkin = skin;
    else lightSkin = skin;
  }
  const selectedSkin = selectedModeSkin(theme, lightSkin, darkSkin);
  try {
    const db = getPool();
    await db.query(
      'UPDATE users SET theme = $1, theme_skin = $2, theme_skin_light = $3, theme_skin_dark = $4 WHERE id = $5',
      [theme, selectedSkin, lightSkin, darkSkin, req.session.user.id]
    );
    req.session.user.theme = theme;
    req.session.user.theme_skin = selectedSkin;
    req.session.user.theme_skin_light = lightSkin;
    req.session.user.theme_skin_dark = darkSkin;
    res.json({ ok: true, theme, theme_skin: selectedSkin, theme_skin_light: lightSkin, theme_skin_dark: darkSkin });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.redirect('/?error=1');
    }
    req.session.user = sessionUserFromDbUser(user);
    req.session.loginAt = Date.now();
    req.session.lastActivityAt = req.session.loginAt;
    req.session.cookie.maxAge = SESSION_MAX_AGE;
    logEvent(user.id, user.username, 'login', { role: user.role });
    const next = req.body.next || '';
    const target = (next && next.startsWith('/') && next !== '/widget') ? next : '/portal';
    req.session.save(err => {
      if (err) {
        console.error('Chyba ulozeni session:', err);
        return res.redirect('/?error=1');
      }
      res.redirect(target);
    });
  } catch (err) {
    console.error('Chyba přihlášení:', err);
    res.redirect('/?error=1');
  }
});

app.get('/logout', async (req, res) => {
  const userId = req.session.user?.id;
  if (userId) {
    // Uvolni zámky
    Object.keys(locks).forEach(k => {
      if (locks[k]?.userId === userId) delete locks[k];
    });
    // Smaž VŠECHNY session tohoto uživatele z DB (odhlášení ze všech zařízení)
    try {
      const db = getPool();
      await db.query(
        `DELETE FROM session WHERE sess::json->'user'->>'id' = $1`,
        [String(userId)]
      );
    } catch(e) {
      console.error('Global logout error:', e.message);
    }
  }
  req.session.destroy(() => res.redirect('/'));
});

app.post('/api/change-password', requireLogin, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 5) {
    return res.json({ ok: false, msg: 'Nové heslo musí mít alespoň 5 znaků.' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = rows[0];
    if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
      return res.json({ ok: false, msg: 'Současné heslo není správné.' });
    }
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2',
      [bcrypt.hashSync(newPassword, 10), user.id]);
    res.json({ ok: true, msg: 'Heslo bylo změněno.' });
  } catch (err) {
    console.error('Chyba změny hesla:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ── API: Správa uživatelů (admin) ─────────────────────────────────────────────

app.get('/api/users', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, name, username, role, phone, created_at, perm_overrides FROM users ORDER BY LOWER(name), LOWER(username), id'
    );
    res.json(rows);
  } catch (err) {
    console.error('Chyba načtení uživatelů:', err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const { name, username, password, role, phone } = req.body;
  if (!name?.trim() || !username?.trim() || !password || !role) {
    return res.json({ ok: false, msg: 'Vyplňte všechna pole.' });
  }
  if (password.length < 5) {
    return res.json({ ok: false, msg: 'Heslo musí mít alespoň 5 znaků.' });
  }
  try {
    const db = getPool();
    const { rows: validRoles } = await db.query('SELECT name FROM permission_groups');
    if (!validRoles.some(r => r.name === role)) {
      return res.json({ ok: false, msg: 'Neplatná skupina.' });
    }
    const { rows: inserted } = await db.query(
      'INSERT INTO users (name, username, password_hash, role, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name.trim(), username.trim(), bcrypt.hashSync(password, 10), role, formatPhoneForStorage(phone)]
    );
    res.json({ ok: true, id: inserted[0].id });
  } catch (err) {
    if (err.code === '23505') return res.json({ ok: false, msg: 'Uživatelské jméno již existuje.' });
    console.error('Chyba vytvoření uživatele:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.patch('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, role, password, username, phone } = req.body;

  if (id === req.session.user.id && role && role !== 'admin') {
    return res.json({ ok: false, msg: 'Nemůžete si sami odebrat roli admina.' });
  }

  try {
    const db = getPool();
    const { rows: beforeRows } = await db.query('SELECT username FROM users WHERE id = $1', [id]);
    const previousLogin = beforeRows[0]?.username || null;
    if (username) {
      // Check username not taken by someone else
      const { rows: taken } = await db.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2', [username.trim(), id]
      );
      if (taken.length > 0) return res.json({ ok: false, msg: 'Toto uživatelské jméno je již obsazeno.' });
      await db.query('UPDATE users SET username = $1 WHERE id = $2', [username.trim(), id]);
    }
    if (name) await db.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), id]);
    if (role) await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    if (phone !== undefined) await db.query('UPDATE users SET phone = $1 WHERE id = $2', [formatPhoneForStorage(phone), id]);
    await syncReceptionistLoginFromUser(db, id, previousLogin);
    if (password) {
      if (password.length < 5) return res.json({ ok: false, msg: 'Heslo musí mít alespoň 5 znaků.' });
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2',
        [bcrypt.hashSync(password, 10), id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba úpravy uživatele:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.delete('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.user.id) {
    return res.json({ ok: false, msg: 'Nemůžete smazat vlastní účet.' });
  }
  try {
    const db = getPool();
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba smazání uživatele:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ── API: Oprávnění skupin ─────────────────────────────────────────────────────

app.get('/api/admin/groups', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT name, display_name, perms, sublist FROM permission_groups ORDER BY name');
    res.json(rows.map(r => ({ name: r.name, displayName: r.display_name, perms: JSON.parse(r.perms || '{}'), sublist: r.sublist || 'VR' })));
  } catch(err) { res.json([]); }
});

app.post('/api/admin/groups', requireLogin, requireAdmin, async (req, res) => {
  const { name, displayName, sublist } = req.body;
  if (!name || !displayName) return res.json({ ok: false, msg: 'Chybí data.' });
  try {
    const db = getPool();
    await db.query('INSERT INTO permission_groups (name, display_name, sublist) VALUES ($1, $2, $3)', [name, displayName, sublist || 'VR']);
    res.json({ ok: true });
  } catch(err) { res.json({ ok: false, msg: 'Skupina s tímto klíčem již existuje.' }); }
});

app.delete('/api/admin/groups/:name', requireLogin, requireAdmin, async (req, res) => {
  const name = req.params.name;
  if (name === 'admin') return res.json({ ok: false, msg: 'Skupinu admin nelze smazat.' });
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT COUNT(*) AS cnt FROM users WHERE role = $1', [name]);
    if (parseInt(rows[0].cnt) > 0) return res.json({ ok: false, msg: 'Skupinu nelze smazat – jsou v ní uživatelé.' });
    await db.query('DELETE FROM permission_groups WHERE name = $1', [name]);
    res.json({ ok: true });
  } catch(err) { res.json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.put('/api/admin/groups/:name/perms', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    await db.query('UPDATE permission_groups SET perms = $1 WHERE name = $2', [JSON.stringify(req.body.perms || {}), req.params.name]);
    res.json({ ok: true });
  } catch(err) { res.json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.get('/api/admin/users/:id/overrides', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT perm_overrides FROM users WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.json({ ok: false });
    res.json({ ok: true, overrides: rows[0].perm_overrides ? JSON.parse(rows[0].perm_overrides) : null });
  } catch(err) { res.json({ ok: false }); }
});

app.put('/api/admin/users/:id/overrides', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const { rows: beforeRows } = await db.query('SELECT username, perm_overrides FROM users WHERE id = $1', [req.params.id]);
    const beforeOverrides = parsePermOverridesValue(beforeRows[0]?.perm_overrides);
    const previousLogin = beforeOverrides?.raspis_staff?.login || beforeRows[0]?.username || null;
    const val = req.body.overrides ? JSON.stringify(req.body.overrides) : null;
    await db.query('UPDATE users SET perm_overrides = $1 WHERE id = $2', [val, req.params.id]);
    await syncReceptionistLoginFromUser(db, req.params.id, previousLogin);
    res.json({ ok: true });
  } catch(err) { res.json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.get('/api/admin/logs', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, timestamp, user_id, user_name, action, details
       FROM logs WHERE action = 'login' ORDER BY timestamp DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// Smazat všechny logy (nebo starší než N dní)
app.delete('/api/admin/logs', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const days = parseInt(req.query.days);
    if (days > 0) {
      await db.query(`DELETE FROM logs WHERE timestamp < NOW() - INTERVAL '${days} days'`);
    } else {
      await db.query(`DELETE FROM logs`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.get('/api/my-permissions', requireLogin, async (req, res) => {
  try {
    const db   = getPool();
    const user = req.session.user;
    const { rows: gr } = await db.query('SELECT perms FROM permission_groups WHERE name = $1', [user.role]);
    const groupPerms   = gr.length ? JSON.parse(gr[0].perms || '{}') : {};
    const { rows: ur } = await db.query('SELECT perm_overrides FROM users WHERE id = $1', [user.id]);
    const userOv       = (ur.length && ur[0].perm_overrides) ? JSON.parse(ur[0].perm_overrides) : {};
    const result = {};
    const requirementProxy = userOv.requirements_proxy && typeof userOv.requirements_proxy === 'object'
      ? userOv.requirements_proxy
      : {};
    const isAdm = user.role === 'admin';
    const isManager = isAdm || String(user.role || '').toLowerCase().includes('ved');
    const DEFAULTS = {
      raspis: { enabled: true, visible: true, buttons: {
        tab_nastaveni: isManager,
        tab_tvorba: isManager,
        tab_rozpis_vr: isManager,
        tab_rozpis: true,
        tab_denni: true,
        tab_pozadavky: true,
        filters: true,
        show_qualified: isManager,
        mark: isManager,
        undo_redo: isManager,
        paste_excel: isManager,
        unmatched: isManager,
        publish: isManager,
        delete: isAdm,
        trash: isAdm,
        edit: isManager,
        archive: isAdm,
        log: isAdm,
        req_create: isManager,
        req_edit: true,
        req_edit_all: isManager,
        req_toggle_reception: isManager,
        req_send_tvorba: isManager,
        req_delete: isAdm,
        req_archive: isManager,
        hotel_manager: isAdm,
        settings_monthly: isManager,
        settings_add_staff: isManager,
        settings_clear_overrides: isAdm
      } },
      priplatky: { enabled: true, visible: true, buttons: {
        viewAll: isAdm,
        add: true,
        edit: true,
        delete: isAdm,
        export: true,
        settings: isAdm,
        manageTexts: isAdm,
        internalNote: isManager
      } },
      dovolene: { enabled: true, visible: true, buttons: {
        viewAll: isManager,
        manage: isManager,
        manageBalances: isManager,
        delete: isManager,
        bulkDelete: isAdm,
        syncNote: isManager
      } },
      blacklist: { enabled: true, visible: true, buttons: {
        view: true,
        add: isManager,
        remove: isManager,
        edit: isManager,
        export_pdf: isManager,
        export_email: isManager,
        edit_intro: isAdm,
        history: isManager,
        history_delete: isAdm
      } },
      admin: { enabled: isAdm, visible: isAdm, buttons: {
        users_add: isAdm,
        users_edit: isAdm,
        users_delete: isAdm,
        user_permissions: isAdm,
        groups_manage: isAdm,
        logs_view: isAdm,
        logs_delete: isAdm
      } }
    };
    const allApps = new Set([...Object.keys(DEFAULTS), ...Object.keys(groupPerms), ...Object.keys(userOv)]
      .filter(k => !k.startsWith('__') && k !== 'requirements_proxy' && k !== 'raspis_staff'));
    for (const appKey of allApps) {
      const dp   = DEFAULTS[appKey] || { enabled: true, buttons: {} };
      const gp   = groupPerms[appKey] || dp;
      const uo   = userOv[appKey] || {};
      const enabled = (uo.enabled != null) ? uo.enabled : (gp.enabled != null ? gp.enabled : true);
      const visible = (uo.visible != null) ? uo.visible : (gp.visible != null ? gp.visible : true);
      const buttons = {};
      const allBtns = new Set([...Object.keys(dp.buttons || {}), ...Object.keys(gp.buttons || {}), ...Object.keys(uo.buttons || {})]);
      for (const btnKey of allBtns) {
        const db = (dp.buttons || {})[btnKey]; const gb = (gp.buttons || {})[btnKey]; const ub = (uo.buttons || {})[btnKey];
        buttons[btnKey] = (ub != null) ? ub : (gb != null ? gb : (db != null ? db : true));
      }
      if (isAdm && appKey === 'priplatky') buttons.viewAll = true;
      result[appKey] = { enabled, visible, buttons };
    }
    result.__defaultApp = userOv.__defaultApp || groupPerms.__defaultApp ||
      (['admin', 'vedoucí', 'recepční', 'pb6'].includes(user.role) ? 'raspis' : null);
    result.requirementsProxy = {
      allowedStaffLogins: Array.isArray(requirementProxy.allowedStaffLogins)
        ? requirementProxy.allowedStaffLogins.map(v => String(v || '').trim().toUpperCase()).filter(Boolean)
        : []
    };
    res.json(result);
  } catch(err) { console.error(err); res.json({}); }
});

// ── API: Zámky ────────────────────────────────────────────────────────────────

app.get('/api/lock/:app', requireLogin, (req, res) =>
  res.json({ lock: locks[req.params.app] || null })
);

app.post('/api/lock/:app/acquire', requireLogin, async (req, res) => {
  const key  = req.params.app;
  const user = req.session.user;
  // Pro raspis zámek ověř edit oprávnění (non-admin)
  if (key === 'raspis-view' && user.role !== 'admin') {
    try {
      const { groupPerms, userOv } = await getUserEffectivePerms(user);
      if (!getEffectiveBtnPerm(groupPerms, userOv, 'raspis', 'edit')) {
        return res.json({ ok: false, msg: 'Nemáte oprávnění editovat rozpis.' });
      }
    } catch(e) { return res.json({ ok: false, msg: 'Chyba ověření oprávnění.' }); }
  }
  if (locks[key] && locks[key].userId !== user.id) {
    return res.json({ ok: false, lock: locks[key] });
  }
  const now   = new Date();
  const until = new Date(now.getTime() + LOCK_TTL).toISOString();
  if (locks[key]?.userId === user.id) {
    locks[key].until = until;
    setLockTimer(key);
    return res.json({ ok: true, lock: locks[key] });
  }
  locks[key]  = { userId: user.id, userName: user.name, since: now.toISOString(), until };
  setLockTimer(key);
  res.json({ ok: true, lock: locks[key] });
});

app.post('/api/lock/:app/release', requireLogin, (req, res) => {
  const key = req.params.app;
  if (locks[key]?.userId === req.session.user.id) {
    delete locks[key];
    if (lockTimers[key]) { clearTimeout(lockTimers[key]); delete lockTimers[key]; }
  }
  res.json({ ok: true });
});

// ── API: Nastavení (sdílená data) ─────────────────────────────────────────────

app.get('/api/settings', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'main'");
    if (rows.length === 0) {
      return res.json({ staff: [], hotels: [], hotelOverrides: {}, customHotels: [] });
    }
    res.json(JSON.parse(rows[0].value));
  } catch (err) {
    console.error('Chyba načtení nastavení:', err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/settings', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'main'");
    const current = rows.length > 0 ? JSON.parse(rows[0].value) : {};
    const { staff, hotels, hotelOverrides, customHotels, mobileKeypadConfig, fondHpp, fondZpp, holidays } = req.body;
    if (staff !== undefined)        current.staff = staff;
    if (hotels !== undefined)       current.hotels = hotels;
    if (hotelOverrides !== undefined) current.hotelOverrides = hotelOverrides;
    if (customHotels !== undefined) current.customHotels = customHotels;
    if (mobileKeypadConfig !== undefined) current.mobileKeypadConfig = mobileKeypadConfig;
    if (fondHpp !== undefined)      current.fondHpp = fondHpp;
    if (fondZpp !== undefined)      current.fondZpp = fondZpp;
    if (holidays !== undefined)     current.holidays = holidays;
    await db.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('main', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [JSON.stringify(current)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba uložení nastavení:', err);
    res.status(500).json({ ok: false });
  }
});

// ── API: Rozpisy ──────────────────────────────────────────────────────────────

app.get('/api/rozpisy', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT key, month, year, label, published_at, published_by FROM rozpisy ORDER BY published_at DESC'
    );
    // Určíme "aktuální" jako nejnovější
    const current = rows.length > 0 ? rows[0].key : null;
    res.json({ current, history: rows });
  } catch (err) {
    console.error('Chyba načtení rozpisů:', err);
    res.status(500).json({ ok: false });
  }
});

// Koš publikovaných rozpisů
app.get('/api/rozpisy/trash', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, key, month, year, label, deleted_at, deleted_by FROM rozpisy_trash ORDER BY deleted_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json([]);
  }
});
// Obnovení z koše
app.post('/api/rozpisy/restore/:id', requireLogin, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rozpisy_trash WHERE id = $1', [id]);
    if (!rows.length) return res.json({ ok: false, msg: 'Nenalezeno.' });
    const r = rows[0];
    await db.query(
      `INSERT INTO rozpisy (key, month, year, label, data, published_at, published_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (key) DO UPDATE SET data = $5, published_at = $6, published_by = $7`,
      [r.key, r.month, r.year, r.label, r.data, r.published_at, r.published_by]
    );
    await db.query('DELETE FROM rozpisy_trash WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// Trvalé smazání z koše
app.delete('/api/rozpisy/perma/:id', requireLogin, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    await db.query('DELETE FROM rozpisy_trash WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.get('/api/rozpisy/:key', requireLogin, async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rozpisy WHERE key = $1', [key]);
    if (rows.length === 0) return res.status(404).json({ ok: false });
    res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    console.error('Chyba načtení rozpisu:', err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/rozpisy/publish', requireLogin, requirePermDefault('raspis', 'publish', false), async (req, res) => {
  const { month, year, data } = req.body;
  if (!month || !year || !data) return res.json({ ok: false, msg: 'Chybí data.' });
  const key   = `${String(month).padStart(2, '0')}/${year}`;
  const label = `Rozpis ${String(month).padStart(2, '0')}/${year}`;
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO rozpisy (key, month, year, label, data, published_at, published_by)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)
       ON CONFLICT (key) DO UPDATE SET data = $5, published_at = NOW(), published_by = $6`,
      [key, month, year, label, JSON.stringify(data), req.session.user.name]
    );
    logEvent(req.session.user.id, req.session.user.username, 'raspis_publish', { key, label });
    broadcastWidgetUpdate();
    res.json({ ok: true, key, label });
  } catch (err) {
    console.error('Chyba uložení rozpisu:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ── Widget API ─────────────────────────────────────────────────────────────────

// SSE stream — widget se připojí sem a čeká na "update"
app.get('/api/widget-events', requireLogin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  widgetSseClients.add(res);
  req.on('close', () => widgetSseClients.delete(res));
});

// Data rozpisu pro widget — volitelně ?day=X&month=Y&year=Z pro navigaci
function widgetMonthIndex(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{1,2})/);
    return m ? (parseInt(m[1], 10) * 12 + parseInt(m[2], 10)) : null;
  }
  const y = parseInt(value.year, 10);
  const mo = parseInt(value.month, 10);
  return Number.isFinite(y) && Number.isFinite(mo) ? (y * 12 + mo) : null;
}

function cleanWidgetName(name) {
  return String(name || '').trim().replace(/^z+\s+/i, '').trim();
}

function widgetHotelOrder(data, month, year) {
  const currentIdx = (+year * 12) + +month;
  const fallback = ['A','B','C','D','E','G','H','I','J','L','M','N','S','T','U'];
  const specials = ['P', 'Q'];
  const rows = Array.isArray(data?.hotels) ? data.hotels : [];
  const active = rows
    .filter(h => {
      if (!h || h.active === false || h.showInPanel === false) return false;
      const letter = String(h.letter || '').trim().toUpperCase();
      if (!letter) return false;
      const from = widgetMonthIndex(h.activeFrom);
      const inactive = widgetMonthIndex(h.inactiveFrom);
      if (from !== null && currentIdx < from) return false;
      if (inactive !== null && currentIdx >= inactive) return false;
      return true;
    })
    .map(h => ({
      letter: String(h.letter || '').trim().toUpperCase(),
      name: String(h.name || '').trim(),
      dayOnly: !!h.dayOnly
    }))
    .filter((h, idx, arr) => h.letter && arr.findIndex(x => x.letter === h.letter) === idx);

  const normal = active
    .filter(h => !specials.includes(h.letter))
    .sort((a, b) => a.letter.localeCompare(b.letter, 'cs', { sensitivity: 'base' }));
  const order = normal.length ? normal : fallback.map(letter => ({
    letter,
    name: '',
    dayOnly: ['J','L','N','S','U'].includes(letter)
  }));
  const specialRows = specials.map(letter =>
    active.find(h => h.letter === letter) || {
      letter,
      name: letter === 'P' ? 'Pohotovost' : 'Vedoucí',
      dayOnly: false
    }
  );
  return [...order, ...specialRows];
}

app.get('/api/widget-today', requireLogin, async (req, res) => {
  try {
    const now = new Date();
    const day = parseInt(req.query.day, 10) || now.getDate();
    const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const key = `RT:${String(month).padStart(2, '0')}/${year}`;

    const db = getPool();
    const { rows } = await db.query('SELECT data FROM rt_schedules WHERE key = $1', [key]);
    const rawData = rows.length ? rows[0].data : {};
    let data = typeof rawData === 'string' ? JSON.parse(rawData || '{}') : (rawData || {});
    data = await augmentRtDataWithActiveReceptionists(data, db);
    const staff = Array.isArray(data.staff) ? data.staff : [];
    const schedule = data.schedule || {};
    const hotels = widgetHotelOrder(data, month, year);
    const hotelMap = {};
    hotels.forEach(h => {
      hotelMap[h.letter] = {
        letter: h.letter,
        name: h.name || '',
        dayOnly: !!h.dayOnly,
        day: null,
        night: null
      };
    });

    const dayCol = (day - 1) * 2;
    const nightCol = dayCol + 1;
    staff.forEach((s, si) => {
      const name = cleanWidgetName(s.name);
      if (!name) return;
      const isStandbyPlaceholder = String(s.name || '').trim().toLowerCase() === 'pohotovost'
        || String(s.type || '').trim().toLowerCase() === 'pohotovost';
      const dayVal = String(schedule[`${si}_${dayCol}`] || '').trim().toUpperCase();
      const nightVal = String(schedule[`${si}_${nightCol}`] || '').trim().toUpperCase();
      if (hotelMap[dayVal] && !hotelMap[dayVal].day && !(dayVal === 'P' && isStandbyPlaceholder)) hotelMap[dayVal].day = name;
      if (hotelMap[nightVal] && !hotelMap[nightVal].night && !(nightVal === 'P' && isStandbyPlaceholder)) hotelMap[nightVal].night = name;
    });

    res.json({
      ok: true,
      day, month, year,
      hotels: hotelMap,
      hotels_order: hotels.map(h => h.letter)
    });
  } catch (err) {
    console.error('Widget today error:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.get('/api/widget-today-old', requireLogin, async (req, res) => {
  try {
    const now        = new Date();
    const todayDay   = parseInt(req.query.day)   || now.getDate();
    const todayMonth = parseInt(req.query.month) || now.getMonth() + 1;
    const todayYear  = parseInt(req.query.year)  || now.getFullYear();
    const key        = `${String(todayMonth).padStart(2, '0')}/${todayYear}`;

    const db = getPool();
    const { rows } = await db.query('SELECT data FROM rozpisy WHERE key = $1', [key]);

    let HOTELS        = ['A','B','C','D','E','G','H','I','J','L','M','N','S','T','U','P','Q'];
    const VALID_TYPES = new Set(['Denní','Noční','Obojí','Vedoucí']);

    const hotelMap = {};
    HOTELS.forEach(h => { hotelMap[h] = { day: null, night: null }; });

    if (rows.length) {
      const raw      = rows[0].data;
      const data     = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const staff    = data.staff    || [];
      const schedule = data.schedule || {};
      const monthIdx = (value) => {
        if (!value) return null;
        if (typeof value === 'string') {
          const m = value.match(/^(\d{4})-(\d{1,2})/);
          return m ? (parseInt(m[1], 10) * 12 + parseInt(m[2], 10)) : null;
        }
        const y = parseInt(value.year, 10);
        const mo = parseInt(value.month, 10);
        return Number.isFinite(y) && Number.isFinite(mo) ? (y * 12 + mo) : null;
      };
      const currentIdx = todayYear * 12 + todayMonth;
      const dataHotels = Array.isArray(data.hotels) ? data.hotels
        .filter(h => {
          if (!h || h.active === false) return false;
          const letter = String(h.letter || '').trim().toUpperCase();
          if (!letter) return false;
          const from = monthIdx(h.activeFrom);
          const inactive = monthIdx(h.inactiveFrom);
          if (from !== null && currentIdx < from) return false;
          if (inactive !== null && currentIdx >= inactive) return false;
          return true;
        })
        .map(h => String(h.letter || '').trim().toUpperCase())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'cs', { sensitivity: 'base' })) : [];
      if (dataHotels.length) {
        HOTELS = dataHotels;
        Object.keys(hotelMap).forEach(k => { delete hotelMap[k]; });
        HOTELS.forEach(h => { hotelMap[h] = { day: null, night: null }; });
      }
      const ci_day   = (todayDay - 1) * 2;
      const ci_night = (todayDay - 1) * 2 + 1;

      staff.forEach((s, si) => {
        if (!VALID_TYPES.has(s.type)) return;
        const dh = (schedule[`${si}_${ci_day}`]   || '').toUpperCase();
        const nh = (schedule[`${si}_${ci_night}`] || '').toUpperCase();
        if (dh && hotelMap[dh] !== undefined && !hotelMap[dh].day)   hotelMap[dh].day   = s.name;
        if (nh && hotelMap[nh] !== undefined && !hotelMap[nh].night) hotelMap[nh].night = s.name;
      });
    }

    res.json({
      ok: true,
      day: todayDay, month: todayMonth, year: todayYear,
      hotels: hotelMap,
      hotels_order: HOTELS
    });
  } catch (err) {
    console.error('Widget today error:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/rozpisy/delete', requireLogin, requireAdmin, async (req, res) => {
  const { key } = req.body;
  try {
    const db = getPool();
    await db.query('DELETE FROM rozpisy WHERE key = $1', [key]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba smazání rozpisu:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ── API: Koncepty (Tvorba rozpisu) ────────────────────────────────────────────

// DŮLEŽITÉ: přesné cesty musí být před /:id aby Express je zachytil správně

app.get('/api/drafts/trash', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const isAdmin = req.session.user.role === 'admin';
    const { rows } = isAdmin
      ? await db.query('SELECT id, user_id, month, year, deleted_at FROM drafts_trash ORDER BY deleted_at DESC')
      : await db.query('SELECT id, user_id, month, year, deleted_at FROM drafts_trash WHERE user_id = $1 ORDER BY deleted_at DESC', [req.session.user.id]);
    res.json(rows.map(r => ({
      ...r,
      label: `Koncept ${String(r.month).padStart(2,'0')}/${r.year}`
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

app.get('/api/drafts', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, month, year, saved_at FROM drafts WHERE user_id = $1 ORDER BY year DESC, month DESC',
      [req.session.user.id]
    );
    res.json(rows.map(r => ({
      ...r,
      label: `Koncept ${String(r.month).padStart(2,'0')}/${r.year}`
    })));
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

app.get('/api/drafts/:id', requireLogin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM drafts WHERE id = $1 AND user_id = $2',
      [id, req.session.user.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false });
    const r = rows[0];
    res.json({ ok: true, label: `Koncept ${String(r.month).padStart(2,'0')}/${r.year}`, data: JSON.parse(r.data) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/drafts/save', requireLogin, requirePerm('raspis', 'edit'), async (req, res) => {
  const { month, year, data } = req.body;
  if (!month || !year || !data) return res.json({ ok: false, msg: 'Chybí data.' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO drafts (user_id, month, year, data, saved_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, month, year) DO UPDATE SET data = $4, saved_at = NOW()
       RETURNING id`,
      [req.session.user.id, month, year, JSON.stringify(data)]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.delete('/api/drafts/:id', requireLogin, requirePerm('raspis', 'edit'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM drafts WHERE id = $1 AND user_id = $2',
      [id, req.session.user.id]
    );
    if (!rows.length) return res.json({ ok: false, msg: 'Nenalezeno.' });
    const r = rows[0];
    await db.query(
      'INSERT INTO drafts_trash (user_id, original_id, month, year, data) VALUES ($1, $2, $3, $4, $5)',
      [r.user_id, r.id, r.month, r.year, r.data]
    );
    await db.query('DELETE FROM drafts WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/drafts/restore/:id', requireLogin, requirePerm('raspis', 'edit'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM drafts_trash WHERE id = $1', [id]);
    if (!rows.length) return res.json({ ok: false, msg: 'Nenalezeno.' });
    const r = rows[0];
    await db.query(
      `INSERT INTO drafts (user_id, month, year, data, saved_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, month, year) DO UPDATE SET data = $4, saved_at = NOW()`,
      [r.user_id, r.month, r.year, r.data]
    );
    await db.query('DELETE FROM drafts_trash WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.delete('/api/drafts/perma/:id', requireLogin, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    await db.query('DELETE FROM drafts_trash WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ── API: Publikované rozpisy – rozšíření ──────────────────────────────────────

// Uložení změn do existujícího publikovaného rozpisu (editace v Raspisu)
app.post('/api/rozpisy/save-edits', requireLogin, async (req, res) => {
  const { key, data } = req.body;
  if (!key || !data) return res.json({ ok: false, msg: 'Chybí data.' });
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      'UPDATE rozpisy SET data = $1, published_at = NOW() WHERE key = $2',
      [JSON.stringify(data), key]
    );
    if (!rowCount) return res.json({ ok: false, msg: 'Raspis nenalezen.' });
    logEvent(req.session.user.id, req.session.user.username, 'raspis_save', { key });
    broadcastWidgetUpdate();
    const lockKey = 'raspis-view';
    if (locks[lockKey]?.userId === req.session.user.id) {
      locks[lockKey].until = new Date(Date.now() + LOCK_TTL).toISOString();
      setLockTimer(lockKey);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// Přesun do koše
app.delete('/api/rozpisy/:key', requireLogin, requireAdmin, async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rozpisy WHERE key = $1', [key]);
    if (!rows.length) return res.json({ ok: false, msg: 'Nenalezeno.' });
    const r = rows[0];
    await db.query(
      'INSERT INTO rozpisy_trash (key, month, year, label, data, published_at, published_by, deleted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.key, r.month, r.year, r.label, r.data, r.published_at, r.published_by, req.session.user.name]
    );
    await db.query('DELETE FROM rozpisy WHERE key = $1', [key]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// Odeslat zpět do Tvorby (vytvoří koncept pro admina)
app.post('/api/rozpisy/:key/to-tvorba', requireLogin, requireAdmin, async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rozpisy WHERE key = $1', [key]);
    if (!rows.length) return res.json({ ok: false, msg: 'Raspis nenalezen.' });
    const r = rows[0];
    await db.query(
      `INSERT INTO drafts (user_id, month, year, data, saved_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, month, year) DO UPDATE SET data = $4, saved_at = NOW()`,
      [req.session.user.id, r.month, r.year, r.data]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ── API: Uživatelské preference ───────────────────────────────────────────────

app.get('/api/user-prefs', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT default_raspis_key, default_public_hotel, default_views, auto_logout_minutes FROM user_preferences WHERE user_id = $1',
      [req.session.user.id]
    );
    let defaultViews = {};
    try { defaultViews = rows[0]?.default_views ? JSON.parse(rows[0].default_views) : {}; } catch { defaultViews = {}; }
    const autoLogoutMinutes = [0, 30, 60, 720].includes(Number(rows[0]?.auto_logout_minutes))
      ? Number(rows[0].auto_logout_minutes)
      : 60;
    res.json({
      default_raspis_key: rows[0]?.default_raspis_key || null,
      default_public_hotel: rows[0]?.default_public_hotel || 'ALL',
      default_views: defaultViews,
      auto_logout_minutes: autoLogoutMinutes
    });
  } catch (err) {
    res.json({ default_raspis_key: null, default_public_hotel: 'ALL', default_views: {}, auto_logout_minutes: 60 });
  }
});

// Pořadí aplikací na dashboardu
app.get('/api/user-prefs/app-order', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT app_order FROM user_preferences WHERE user_id = $1', [req.session.user.id]);
    const order = rows[0]?.app_order ? JSON.parse(rows[0].app_order) : [];
    res.json({ order });
  } catch (err) {
    res.json({ order: [] });
  }
});

app.put('/api/user-prefs/app-order', requireLogin, async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.json({ ok: false });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO user_preferences (user_id, app_order, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET app_order = $2, updated_at = NOW()`,
      [req.session.user.id, JSON.stringify(order)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/api/user-prefs/default', requireLogin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ ok: false, msg: 'Chybí klíč.' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO user_preferences (user_id, default_raspis_key, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET default_raspis_key = $2, updated_at = NOW()`,
      [req.session.user.id, key]
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/user-prefs/default-public-hotel', requireLogin, async (req, res) => {
  const raw = Array.isArray(req.body.hotels) ? req.body.hotels.join(',') : String(req.body.hotel || 'ALL');
  const parts = String(raw).toUpperCase().split(',').map(x => x.trim()).filter(Boolean);
  const hotel = parts.some(x => x === 'ALL' || x === 'VSE' || x === 'VŠE')
    ? 'ALL'
    : Array.from(new Set(parts.map(x => x.replace(/[^A-Z0-9]/g, '').slice(0, 3)).filter(Boolean))).join(',');
  if (!hotel) return res.json({ ok: false, msg: 'Chybí hotel.' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO user_preferences (user_id, default_public_hotel, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET default_public_hotel = $2, updated_at = NOW()`,
      [req.session.user.id, hotel]
    );
    res.json({ ok: true, default_public_hotel: hotel });
  } catch (err) {
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/user-prefs/default-views', requireLogin, async (req, res) => {
  const allowedApps = new Set(['raspis', 'priplatky', 'dovolene', 'blacklist', 'admin']);
  const allowedTabs = new Set(['nastaveni', 'tvorba', 'rozpis', 'public', 'denni', 'pozadavky', 'dovolene']);
  const raw = req.body && req.body.default_views && typeof req.body.default_views === 'object'
    ? req.body.default_views
    : {};
  const clean = {
    desktop: {
      app: allowedApps.has(raw.desktop?.app) ? raw.desktop.app : 'raspis',
      raspisTab: allowedTabs.has(raw.desktop?.raspisTab) ? raw.desktop.raspisTab : 'rozpis'
    },
    mobile: {
      app: allowedApps.has(raw.mobile?.app) ? raw.mobile.app : 'raspis',
      raspisTab: allowedTabs.has(raw.mobile?.raspisTab) ? raw.mobile.raspisTab : 'public'
    }
  };
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO user_preferences (user_id, default_views, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET default_views = $2, updated_at = NOW()`,
      [req.session.user.id, JSON.stringify(clean)]
    );
    res.json({ ok: true, default_views: clean });
  } catch (err) {
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/user-prefs/auto-logout', requireLogin, async (req, res) => {
  const minutes = Number(req.body?.minutes);
  const allowed = new Set([0, 30, 60, 720]);
  if (!allowed.has(minutes)) return res.status(400).json({ ok: false, msg: 'Neplatná hodnota.' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO user_preferences (user_id, auto_logout_minutes, auto_logout_set, updated_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (user_id) DO UPDATE SET auto_logout_minutes = $2, auto_logout_set = TRUE, updated_at = NOW()`,
      [req.session.user.id, minutes]
    );
    res.json({ ok: true, auto_logout_minutes: minutes });
  } catch (err) {
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ── Zprávy (Messages) ────────────────────────────────────────────────────────

// Helper: načti efektivní oprávnění uživatele
async function getUserPerms(user) {
  try {
    const db = getPool();
    const { rows: gr } = await db.query('SELECT perms FROM permission_groups WHERE name = $1', [user.role]);
    const groupPerms = gr.length ? JSON.parse(gr[0].perms || '{}') : {};
    const { rows: ur } = await db.query('SELECT perm_overrides FROM users WHERE id = $1', [user.id]);
    const userOv = (ur.length && ur[0].perm_overrides) ? JSON.parse(ur[0].perm_overrides) : {};
    return { groupPerms, userOv };
  } catch { return { groupPerms: {}, userOv: {} }; }
}

function canWriteMessages(user, groupPerms, userOv) {
  if (user.role === 'admin') return true;
  const uo = userOv.messages || {};
  const gp = groupPerms.messages || {};
  const fromOv = uo.buttons?.write;
  const fromGp = gp.buttons?.write;
  return fromOv != null ? fromOv : (fromGp != null ? fromGp : false);
}

// GET /api/messages — zprávy viditelné pro přihlášeného uživatele
app.get('/api/messages', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const { rows } = await db.query(`
      SELECT m.id, m.author_id, m.author_name, m.content,
             m.target_type, m.target_ids, m.created_at, m.expires_at,
             mr.read_at, mr.dismissed
      FROM messages m
      LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = $1
      WHERE (m.expires_at IS NULL OR m.expires_at > NOW())
        AND (mr.dismissed IS NULL OR mr.dismissed = FALSE)
      ORDER BY m.created_at DESC
    `, [user.id]);

    const visible = rows.filter(msg => {
      if (msg.target_type === 'all') return true;
      const ids = JSON.parse(msg.target_ids || '[]');
      if (msg.target_type === 'groups') return ids.includes(user.role);
      if (msg.target_type === 'users') return ids.map(String).includes(String(user.id));
      return false;
    });

    const { groupPerms, userOv } = await getUserPerms(user);
    res.json({ messages: visible, canWrite: canWriteMessages(user, groupPerms, userOv) });
  } catch (err) { console.error(err); res.json({ messages: [], canWrite: false }); }
});

// POST /api/messages — vytvoř zprávu
app.post('/api/messages', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const { groupPerms, userOv } = await getUserPerms(user);
    if (!canWriteMessages(user, groupPerms, userOv))
      return res.status(403).json({ ok: false, msg: 'Nemáš oprávnění.' });

    const { content, target_type, target_ids, expires_at } = req.body;
    if (!content?.trim()) return res.json({ ok: false, msg: 'Chybí obsah zprávy.' });

    const db = getPool();
    await db.query(`
      INSERT INTO messages (author_id, author_name, content, target_type, target_ids, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [user.id, user.name, content.trim(), target_type || 'all',
        JSON.stringify(target_ids || []), expires_at || null]);

    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

// DELETE /api/messages/:id — smaž zprávu (admin nebo autor)
app.delete('/api/messages/:id', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const { rows } = await db.query('SELECT author_id FROM messages WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false });
    if (user.role !== 'admin' && rows[0].author_id !== user.id)
      return res.status(403).json({ ok: false });
    await db.query('DELETE FROM messages WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false }); }
});

// POST /api/messages/:id/read — označ jako přečtené
app.post('/api/messages/:id/read', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const msgId = parseInt(req.params.id);
    await db.query(`
      INSERT INTO message_reads (message_id, user_id, read_at, dismissed)
      VALUES ($1, $2, NOW(), FALSE)
      ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = NOW()
    `, [msgId, user.id]);
    logEvent(user.id, user.name, 'message_read', { message_id: msgId });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false }); }
});

// POST /api/messages/:id/dismiss — přečteno, již nezobrazovat
app.post('/api/messages/:id/dismiss', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const msgId = parseInt(req.params.id);
    await db.query(`
      INSERT INTO message_reads (message_id, user_id, read_at, dismissed)
      VALUES ($1, $2, NOW(), TRUE)
      ON CONFLICT (message_id, user_id) DO UPDATE SET dismissed = TRUE, read_at = NOW()
    `, [msgId, user.id]);
    logEvent(user.id, user.name, 'message_dismiss', { message_id: msgId });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false }); }
});

// PUT /api/messages/:id — uprav zprávu (autor nebo admin)
app.put('/api/messages/:id', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const { rows } = await db.query('SELECT author_id FROM messages WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Zpráva nenalezena.' });
    if (user.role !== 'admin' && rows[0].author_id !== user.id)
      return res.status(403).json({ ok: false, msg: 'Nemáš oprávnění.' });

    const { content, target_type, target_ids, expires_at } = req.body;
    if (!content?.trim()) return res.json({ ok: false, msg: 'Chybí obsah zprávy.' });

    // Check if content actually changed (to decide whether to reset dismissed status)
    const { rows: oldRows } = await db.query('SELECT content FROM messages WHERE id = $1', [req.params.id]);
    const contentChanged = oldRows[0]?.content !== content.trim();

    await db.query(`
      UPDATE messages SET content=$1, target_type=$2, target_ids=$3, expires_at=$4
      WHERE id=$5
    `, [content.trim(), target_type || 'all', JSON.stringify(target_ids || []),
        expires_at || null, req.params.id]);

    // If the message text changed, reset dismissed status so users see it again
    if (contentChanged) {
      await db.query(`DELETE FROM message_reads WHERE message_id = $1 AND dismissed = TRUE`, [req.params.id]);
    }

    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

// ── Schedule change log ────────────────────────────────────────────────────

// GET /api/schedule-log/:key — log pro daný rozpis
app.get('/api/schedule-log/:key', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const key = req.params.key;
    const savedOnly = req.query.saved === 'true';
    const q = savedOnly
      ? `SELECT * FROM schedule_change_log WHERE raspis_key=$1 AND is_saved=TRUE ORDER BY timestamp DESC LIMIT 500`
      : `SELECT * FROM schedule_change_log WHERE raspis_key=$1 ORDER BY timestamp DESC LIMIT 500`;
    const { rows } = await db.query(q, [key]);
    res.json({ ok: true, entries: rows });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, entries: [] }); }
});

// POST /api/schedule-log/:key — přidej záznam změny
app.post('/api/schedule-log/:key', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const key = req.params.key;
    const { change_type, staff_name, day, dn, old_value, new_value } = req.body;
    if (!staff_name || !change_type) return res.json({ ok: false });
    await db.query(`
      INSERT INTO schedule_change_log (raspis_key, user_id, user_name, is_saved, change_type, staff_name, day, dn, old_value, new_value)
      VALUES ($1, $2, $3, FALSE, $4, $5, $6, $7, $8, $9)
    `, [key, user.id, user.name, change_type, staff_name,
        day || null, dn || null, old_value ?? '', new_value ?? '']);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

// POST /api/schedule-log/:key/mark-saved — označ čekající záznamy jako uložené
app.post('/api/schedule-log/:key/mark-saved', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const key = req.params.key;
    await db.query(`UPDATE schedule_change_log SET is_saved=TRUE WHERE raspis_key=$1 AND is_saved=FALSE`, [key]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false }); }
});

// GET /api/groups-list — seznam skupin pro výběr příjemců
app.get('/api/groups-list', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT name, display_name FROM permission_groups ORDER BY display_name');
    res.json(rows);
  } catch { res.json([]); }
});

// GET /api/users-list — seznam uživatelů pro výběr příjemců
app.get('/api/users-list', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT id, name, username FROM users ORDER BY name');
    res.json(rows);
  } catch { res.json([]); }
});

// ── Blacklist ─────────────────────────────────────────────────────────────────

app.get('/blacklist', requireLogin, (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'blacklist.html'));
});

function blFormatDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const d = String(val.getUTCDate()).padStart(2, '0');
    const mo = String(val.getUTCMonth() + 1).padStart(2, '0');
    return `${d}.${mo}.${val.getUTCFullYear()}`;
  }
  const s = String(val);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return s;
}

function blStripHtml(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Strip diacritics for pdfkit built-in fonts (Windows-1252 only; č,ě,ř,ů etc. throw)
function pdfSafe(str) {
  const m = { 'č':'c','Č':'C','ě':'e','Ě':'E','ř':'r','Ř':'R',
               'ů':'u','Ů':'U','ď':'d','Ď':'D','ň':'n','Ň':'N',
               'ť':'t','Ť':'T' };
  return String(str || '')
    .replace(/[čČěĚřŘůŮďĎňŇťŤ]/g, c => m[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function blHtmlEscape(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function blBuildEmailHtml(adds, removes) {
  const SP = 'margin: 0 0 12px 0;';  // standard paragraph spacing

  function personCard(borderColor, bgColor, lines) {
    return `<div style="margin: 0 0 10px 0; padding: 11px 15px; border: 1px dashed ${borderColor}88; border-left: 4px solid ${borderColor}; background: ${bgColor}; font-size: 11pt; word-break: break-word; line-height: 1.6; box-sizing: border-box; width: 91.5%;">
      ${lines.join('<br>')}
    </div>`;
  }

  let html = `<div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; max-width: 640px; color: #1a1a1a; line-height: 1.6;">`;
  html += `<p style="${SP}">Vážení recepční,</p>`;

  if (removes.length > 0) {
    const pl = removes.length === 1
      ? 'byla <strong>odstraněna</strong> následující osoba'
      : 'byly <strong>odstraněny</strong> následující osoby';
    html += `<p style="${SP}">z Blacklistu ${pl}:</p>`;
    for (const r of removes) {
      const p = r.payload;
      const e = p.entry || p;
      const name    = blHtmlEscape(e.original_name   || e.name   || '');
      const hotel   = blHtmlEscape(e.original_hotel  || e.hotel  || '—');
      const birth   = blHtmlEscape(blFormatDate(e.original_birth_date || e.birth_date || e.birthDate) || '—');
      const reason  = blHtmlEscape(e.original_reason || e.reason || '');
      const remReas = blHtmlEscape(p.removalReason   || p.removal_reason || '');
      html += personCard('#2e75b6', '#eef3fb', [
        `<strong style="font-size:12pt;">${name}</strong>`,
        `<span style="color:#555;font-size:10pt;">nar. ${birth}&nbsp;&nbsp;|&nbsp;&nbsp;hotel ${hotel}</span>`,
        `<em style="color:#444;font-size:10pt;">Původní důvod zařazení: ${reason}</em>`,
        `<strong>Důvod odstranění:</strong> ${remReas}`
      ]);
    }
    html += `<p style="${SP}">Tuto osobu prosím <strong>již nenahlašujte</strong> ani s ní nezacházejte jako s rizikovou.</p>`;
  }

  if (adds.length > 0) {
    if (removes.length > 0) html += `<hr style="margin: 14px 0; border: none; border-top: 1px solid #ddd;">`;
    const pl = adds.length === 1
      ? 'byla <strong>přidána</strong> následující osoba'
      : 'byly <strong>přidány</strong> následující osoby';
    html += `<p style="${SP}">na Blacklist ${pl}:</p>`;
    for (const r of adds) {
      const p = r.payload;
      const e = p.entry || p;
      const name   = blHtmlEscape(e.name  || '');
      const hotel  = blHtmlEscape(e.hotel || '—');
      const birth  = blHtmlEscape(blFormatDate(e.birth_date || e.birthDate) || '—');
      const reason = blHtmlEscape(e.reason || '');
      html += personCard('#c0392b', '#fdf3f1', [
        `<strong style="font-size:12pt;">${name}</strong>`,
        `<span style="color:#555;font-size:10pt;">nar. ${birth}&nbsp;&nbsp;|&nbsp;&nbsp;hotel ${hotel}</span>`,
        `<em style="color:#444;font-size:10pt;">Důvod zařazení: ${reason}</em>`
      ]);
    }
    html += `<p style="${SP}">${adds.length === 1 ? 'Tohoto hosta' : 'Tyto hosty'} v žádném případě neubytovávejte.</p>`;
  }

  const LI = 'font-size:11pt;font-family:Calibri,Arial,sans-serif;';
  html += `<p style="margin: 16px 0 6px 0;"><strong>Prosím:</strong></p>
  <ul style="margin: 0 0 14px 0; padding-left: 22px;">
    <li style="${LI}margin-bottom:5px;">informujte své kolegy o této změně,</li>
    <li style="${LI}margin-bottom:5px;">vytiskněte si aktuální verzi z přílohy či ze složky <em>nastenka\\Blacklist</em>,</li>
    <li style="${LI}">starší verze nahraďte aktuální.</li>
  </ul>
  <p style="margin: 0 0 6px 0;"><strong>Postup pro hosty z Blacklistu:</strong></p>
  <ul style="margin: 0 0 16px 0; padding-left: 22px;">
    <li style="${LI}margin-bottom:5px;">Pokud se některá z osob na blacklistu přijde ubytovat, přečtěte si důvod zařazení.</li>
    <li style="${LI}">Pokud dle vzezření hosta a důvodu usoudíte, že nechcete jít s hostem do konfliktu, <strong>volejte VRQ</strong>.</li>
  </ul>
  <p style="${SP}">S pozdravem</p>
  </div>`;
  return html;
}

app.get('/api/blacklist/entries', requireLogin, requirePermDefault('blacklist', 'view', true), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT id, name, hotel, birth_date, damage, stay_date, reason, added_at, added_by FROM blacklist_entries'
    );
    rows.sort((a, b) => a.name.localeCompare(b.name, 'cs', { sensitivity: 'base' }));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/blacklist/entries', requireLogin, requirePermDefault('blacklist', 'add', false), async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0)
    return res.status(400).json({ ok: false, msg: 'Chybí data.' });
  const addedBy = req.session.user.name;
  try {
    const db = getPool();
    const added = [];
    for (const e of entries) {
      if (!e.name?.trim() || !e.reason?.trim())
        return res.status(400).json({ ok: false, msg: 'Jméno a důvod jsou povinné.' });
      const stayDate = e.stayDate && /^\d{4}-\d{2}-\d{2}$/.test(e.stayDate) ? e.stayDate : null;
      const { rows } = await db.query(
        `INSERT INTO blacklist_entries (name, hotel, birth_date, damage, stay_date, reason, added_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [e.name.trim(), e.hotel?.trim() || null, e.birthDate?.trim() || null,
         e.damage?.trim() || null, stayDate, e.reason.trim(), addedBy]
      );
      const entry = rows[0];
      added.push(entry);
      await db.query(
        `INSERT INTO blacklist_audit (action, payload, user_name) VALUES ('ADD',$1,$2)`,
        [JSON.stringify({ entry }), addedBy]
      );
    }
    res.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.put('/api/blacklist/entries/:id', requireLogin, requirePermDefault('blacklist', 'edit', false), async (req, res) => {
  const { id } = req.params;
  const { name, hotel, birthDate, damage, stayDate, reason } = req.body;
  if (!name?.trim() || !reason?.trim())
    return res.status(400).json({ ok: false, msg: 'Jméno a důvod jsou povinné.' });
  const editedBy = req.session.user.name;
  try {
    const db = getPool();
    const { rows: prev } = await db.query('SELECT * FROM blacklist_entries WHERE id = $1', [id]);
    if (!prev[0]) return res.status(404).json({ ok: false, msg: 'Záznam nenalezen.' });
    const stayDateVal = stayDate && /^\d{4}-\d{2}-\d{2}$/.test(stayDate) ? stayDate : null;
    const { rows } = await db.query(
      `UPDATE blacklist_entries SET name=$1, hotel=$2, birth_date=$3, damage=$4, stay_date=$5, reason=$6
       WHERE id=$7 RETURNING *`,
      [name.trim(), hotel?.trim() || null, birthDate?.trim() || null,
       damage?.trim() || null, stayDateVal, reason.trim(), id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, msg: 'Záznam nenalezen.' });
    await db.query(
      `INSERT INTO blacklist_audit (action, payload, user_name) VALUES ('EDIT',$1,$2)`,
      [JSON.stringify({ before: prev[0], after: rows[0] }), editedBy]
    );
    res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/blacklist/remove', requireLogin, requirePermDefault('blacklist', 'remove', false), async (req, res) => {
  const { removals } = req.body;
  if (!Array.isArray(removals) || removals.length === 0)
    return res.status(400).json({ ok: false, msg: 'Chybí data.' });
  const removedBy = req.session.user.name;
  try {
    const db = getPool();
    for (const r of removals) {
      if (!r.id || !r.reason?.trim())
        return res.status(400).json({ ok: false, msg: 'ID a důvod jsou povinné.' });
      const { rows } = await db.query('SELECT * FROM blacklist_entries WHERE id = $1', [r.id]);
      if (!rows[0]) continue;
      const e = rows[0];
      await db.query(
        `INSERT INTO blacklist_removed
         (original_id,original_name,original_hotel,original_birth_date,original_damage,
          original_stay_date,original_reason,original_added_at,original_added_by,removal_reason,removed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [e.id, e.name, e.hotel, e.birth_date, e.damage,
         e.stay_date, e.reason, e.added_at, e.added_by, r.reason.trim(), removedBy]
      );
      await db.query('DELETE FROM blacklist_entries WHERE id = $1', [r.id]);
      await db.query(
        `INSERT INTO blacklist_audit (action, payload, user_name) VALUES ('REMOVE',$1,$2)`,
        [JSON.stringify({ entry: e, removalReason: r.reason.trim() }), removedBy]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.get('/api/blacklist/intro', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM blacklist_intro WHERE id = 1');
    res.json(rows[0] || { content: '', updated_at: null, updated_by: null });
  } catch (err) {
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.put('/api/blacklist/intro', requireLogin, requirePermDefault('blacklist', 'edit_intro', false), async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ ok: false, msg: 'Obsah nesmí být prázdný.' });
  const updatedBy = req.session.user.name;
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO blacklist_intro (id, content, updated_by, updated_at) VALUES (1,$1,$2,NOW())
       ON CONFLICT (id) DO UPDATE SET content=$1, updated_by=$2, updated_at=NOW()`,
      [content.trim(), updatedBy]
    );
    await db.query(
      `INSERT INTO blacklist_audit (action, payload, user_name) VALUES ('EDIT_INTRO',$1,$2)`,
      [JSON.stringify({ snippet: content.trim().substring(0, 100) }), updatedBy]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.get('/api/blacklist/audit', requireLogin, requirePermDefault('blacklist', 'history', false), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, action, payload, user_name, timestamp, notified_by_email
       FROM blacklist_audit ORDER BY timestamp DESC LIMIT 1000`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// DELETE multiple audit entries at once
app.delete('/api/blacklist/audit/bulk', requireLogin, requirePermDefault('blacklist', 'history_delete', false), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ ok: false, msg: 'Chybí seznam ID.' });
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `DELETE FROM blacklist_audit WHERE id = ANY($1::uuid[])`, [ids]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// DELETE a single audit/history entry permanently
app.delete('/api/blacklist/audit/:id', requireLogin, requirePermDefault('blacklist', 'history_delete', false), async (req, res) => {
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `DELETE FROM blacklist_audit WHERE id = $1::uuid`,
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, msg: 'Záznam nenalezen.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// GET pending (unnotified) changes — for selection UI
app.get('/api/blacklist/export/email/pending', requireLogin, requirePermDefault('blacklist', 'export_email', false), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, action, payload, user_name, timestamp
       FROM blacklist_audit
       WHERE notified_by_email = FALSE AND action IN ('ADD','REMOVE')
       ORDER BY timestamp DESC`
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// POST generate email from selected IDs
app.post('/api/blacklist/export/email', requireLogin, requirePermDefault('blacklist', 'export_email', false), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ ok: false, msg: 'Vyberte alespoň jednu změnu.' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, action, payload, user_name, timestamp FROM blacklist_audit
       WHERE id = ANY($1::uuid[]) AND action IN ('ADD','REMOVE')
       ORDER BY timestamp ASC`,
      [ids]
    );
    if (rows.length === 0)
      return res.json({ ok: false, msg: 'Žádné záznamy nenalezeny.' });

    const adds    = rows.filter(r => r.action === 'ADD');
    const removes = rows.filter(r => r.action === 'REMOVE');
    const html    = blBuildEmailHtml(adds, removes);

    await db.query(
      `UPDATE blacklist_audit SET notified_by_email = TRUE WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    res.json({ ok: true, html });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.get('/api/blacklist/export/pdf', requireLogin, requirePermDefault('blacklist', 'export_pdf', false), async (req, res) => {
  try {
    const db = getPool();
    const [entRes, introRes] = await Promise.all([
      db.query('SELECT * FROM blacklist_entries'),
      db.query('SELECT content FROM blacklist_intro WHERE id = 1')
    ]);

    const entries = entRes.rows;
    entries.sort((a, b) => a.name.localeCompare(b.name, 'cs', { sensitivity: 'base' }));

    const introText = pdfSafe(blStripHtml(introRes.rows[0]?.content || ''));
    const userName  = req.session.user.name;
    const now       = new Date();
    const pad2      = n => String(n).padStart(2, '0');
    const dateStr   = `${pad2(now.getDate())}.${pad2(now.getMonth()+1)}.${now.getFullYear()}`;
    const filename  = `${now.getFullYear()}_${pad2(now.getMonth()+1)}_${pad2(now.getDate())}_BLACKLIST.pdf`;

    const mL = 34, mT = 34, mB = 43;
    const pageW = 595.28, pageH = 841.89;
    const tableW = pageW - 2 * mL;
    const cellPad = 1.5;

    const cols = [
      { key: 'name',       label: 'Jmeno',        w: 124.74 },
      { key: 'hotel',      label: 'Hotel',         w: 34.02  },
      { key: 'birth_date', label: 'Datum nar.',    w: 53.87  },
      { key: 'damage',     label: 'Skoda',         w: 48.20  },
      { key: 'stay_date',  label: 'Datum odjezdu', w: 53.87  },
      { key: 'reason',     label: 'Popis',         w: 212.58 }
    ];

    function cellVal(entry, key) {
      if (key === 'birth_date') return pdfSafe(blFormatDate(entry.birth_date));
      if (key === 'stay_date')  return pdfSafe(blFormatDate(entry.stay_date));
      return pdfSafe(String(entry[key] || ''));
    }

    // Use a measurement-only doc (autoFirstPage:false) to estimate page count
    function estimatePages(dataFS) {
      const hdrFS = dataFS + 1;
      const tmp = new PDFDocument({ size: 'A4', autoFirstPage: false });

      function rh(entry, isHeader, fs) {
        tmp.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
        let maxH = 0;
        for (const col of cols) {
          const text = isHeader ? col.label : cellVal(entry, col.key);
          const h = tmp.heightOfString(text || ' ', { width: col.w - 2*cellPad });
          if (h > maxH) maxH = h;
        }
        return maxH + 2*cellPad;
      }

      let pages = 1, y = mT;
      tmp.font('Helvetica-Bold').fontSize(15);
      y += tmp.heightOfString('AVEhotels - Blacklist', { width: tableW }) + 6;
      tmp.font('Helvetica-Bold').fontSize(8.5);
      y += tmp.heightOfString(introText, { width: tableW }) + 8;
      y += rh(null, true, hdrFS);
      for (const entry of entries) {
        const h = rh(entry, false, dataFS);
        if (y + h > pageH - mB - 20) { pages++; y = mT + rh(null, true, hdrFS); }
        y += h;
      }
      if (y + 14 > pageH - mB) pages++; // account for signature line
      return pages;
    }

    let dataFS = 6.2;
    let warning = false;
    while (estimatePages(dataFS) > 4 && dataFS > 5.5)
      dataFS = Math.round((dataFS - 0.5) * 10) / 10;
    if (estimatePages(dataFS) > 4) warning = true;

    // Build the actual PDF — draw everything, then register listeners, then end()
    function buildPDF(dataFS) {
      const hdrFS = dataFS + 1;
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: mT, bottom: mB, left: mL, right: mL },
        autoFirstPage: true
      });

      function rowHeight(entry, isHeader, fs) {
        doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
        let maxH = 0;
        for (const col of cols) {
          const text = isHeader ? col.label : cellVal(entry, col.key);
          const h = doc.heightOfString(text || ' ', { width: col.w - 2*cellPad });
          if (h > maxH) maxH = h;
        }
        return maxH + 2*cellPad;
      }

      function drawRow(y, entry, isHeader, fs) {
        const rh = rowHeight(entry, isHeader, fs);
        let x = mL;
        for (const col of cols) {
          const text = isHeader ? col.label : cellVal(entry, col.key);
          doc.save();
          doc.rect(x, y, col.w, rh).fill(isHeader ? '#2C3540' : '#ffffff');
          doc.restore();
          doc.rect(x, y, col.w, rh).stroke('#000000');
          doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(fs).fillColor(isHeader ? '#E8E6DC' : '#000000')
            .text(text || '', x+cellPad, y+cellPad, { width: col.w-2*cellPad, lineBreak: true });
          x += col.w;
        }
        return rh;
      }

      let y = mT;
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#000000')
        .text('AVEhotels - Blacklist', mL, y, { align: 'center', width: tableW });
      y += doc.heightOfString('AVEhotels - Blacklist', { width: tableW }) + 6;

      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000')
        .text(introText, mL, y, { width: tableW });
      y += doc.heightOfString(introText, { width: tableW }) + 8;

      const hdrH = rowHeight(null, true, hdrFS);
      drawRow(y, null, true, hdrFS);
      y += hdrH;

      for (const entry of entries) {
        const rh = rowHeight(entry, false, dataFS);
        if (y + rh > pageH - mB - 20) {
          doc.addPage();
          y = mT;
          drawRow(y, null, true, hdrFS);
          y += hdrH;
        }
        drawRow(y, entry, false, dataFS);
        y += rh;
      }

      if (y + 14 > pageH - mB) { doc.addPage(); y = mT; }
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
        .text(pdfSafe(`${dateStr}, ${userName}`), mL, y + 4, { align: 'right', width: tableW });

      return doc;
    }

    const doc = buildPDF(dataFS);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => {
      const buf = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (warning) res.setHeader('X-PDF-Warning', 'Presahuje 4 stranky.');
      res.send(buf);
    });
    doc.end();
  } catch (err) {
    console.error('PDF error:', err.stack || err);
    if (!res.headersSent) res.status(500).json({ ok: false, msg: err.message || 'Chyba serveru.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PŘÍPLATKY A POKUTY
// ══════════════════════════════════════════════════════════════════════════════

// ── České státní svátky (včetně Velikonočního pondělí) ────────────────────────
function getCzechHolidays(year) {
  const pad = n => String(n).padStart(2, '0');
  const h = new Set([
    `${year}-01-01`,`${year}-05-01`,`${year}-05-08`,
    `${year}-07-05`,`${year}-07-06`,`${year}-09-28`,
    `${year}-10-28`,`${year}-11-17`,`${year}-12-24`,
    `${year}-12-25`,`${year}-12-26`,
  ]);
  // Butcher/Anonymous Gregorian – Easter Monday
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4;
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
  const hh=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4;
  const l=(32+2*e+2*i-hh-k)%7,m=Math.floor((a+11*hh+22*l)/451);
  const month=Math.floor((hh+l-7*m+114)/31),day=((hh+l-7*m+114)%31)+1;
  const em=new Date(year,month-1,day+1); // Easter Monday
  h.add(`${em.getFullYear()}-${pad(em.getMonth()+1)}-${pad(em.getDate())}`);
  return h;
}

app.get('/priplatky', requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'priplatky.html'))
);

// Recepční (login ↔ jméno)
app.get('/api/priplatky/recepni', requireLogin, async (req, res) => {
  const db = getPool();
  const all = await canViewAllPriplatky(req.session.user);
  const ids = userIdentityValues(req.session.user);
  const byLogin = new Map();

  const { rows: legacyRows } = await db.query(`SELECT login, full_name, active FROM receptionist_logins`);
  for (const r of legacyRows) {
    const login = String(r.login || '').trim();
    if (!login) continue;
    byLogin.set(login.toLowerCase(), {
      login,
      full_name: r.full_name || login,
      active: r.active !== false
    });
  }

  const { rows: userRows } = await db.query(
    `SELECT name, username, perm_overrides
     FROM users
     WHERE perm_overrides IS NOT NULL`
  );
  for (const u of userRows) {
    let overrides = null;
    try {
      overrides = typeof u.perm_overrides === 'string'
        ? JSON.parse(u.perm_overrides)
        : u.perm_overrides;
    } catch (e) {
      continue;
    }
    const rs = overrides?.raspis_staff;
    if (!rs || !rs.active) continue;
    const login = String(rs.login || u.username || '').trim().toUpperCase();
    if (!login) continue;
    byLogin.set(login.toLowerCase(), {
      login,
      full_name: rs.displayName || u.name || login,
      active: true
    });
  }

  let rows = Array.from(byLogin.values()).filter(r => r.active !== false);
  if (!all) {
    rows = rows.filter(r =>
      ids.includes(String(r.login || '').toLowerCase()) ||
      ids.includes(String(r.full_name || '').toLowerCase())
    );
  }
  rows.sort((a, b) => String(a.full_name || a.login).localeCompare(String(b.full_name || b.login), 'cs', { sensitivity: 'base' }));
  res.json(rows);
});

app.post('/api/priplatky/recepni', requireLogin, requirePermDefault('priplatky', 'manageReceptionists', false), async (req, res) => {
  const { login, full_name } = req.body;
  const db = getPool();
  try {
    const r = await db.query(
      `INSERT INTO receptionist_logins (login, full_name) VALUES ($1,$2)
       ON CONFLICT (login) DO UPDATE SET full_name=$2, active=TRUE RETURNING *`,
      [login, full_name]
    );
    res.json({ ok: true, row: r.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, msg: err.message });
  }
});

app.patch('/api/priplatky/recepni/:login', requireLogin, requirePermDefault('priplatky', 'manageReceptionists', false), async (req, res) => {
  const { full_name, active } = req.body;
  const db = getPool();
  await db.query(
    `UPDATE receptionist_logins SET
       full_name = COALESCE($1, full_name),
       active    = COALESCE($2, active)
     WHERE login = $3`,
    [full_name || null, active !== undefined ? active : null, req.params.login]
  );
  res.json({ ok: true });
});

app.delete('/api/priplatky/recepni/:login', requireLogin, requirePermDefault('priplatky', 'manageReceptionists', false), async (req, res) => {
  const db = getPool();
  await db.query('DELETE FROM receptionist_logins WHERE login=$1', [req.params.login]);
  res.json({ ok: true });
});

// Záznamy
app.get('/api/priplatky/zaznamy', requireLogin, async (req, res) => {
  const { rok, mesic } = req.query;
  const db = getPool();
  const own = await priplatkyOwnFilter(req.session.user);
  const params = [rok, mesic, ...own.params];
  const ownWhere = own.where.replace(/\$IDX/g, `$${params.length}`);
  const { rows } = await db.query(
    `SELECT z.*,
            rl.full_name
     FROM priplatky_zaznamy z
     LEFT JOIN receptionist_logins rl ON rl.login = z.login
     WHERE z.rok = $1 AND z.mesic = $2${ownWhere}
     ORDER BY z.datum, z.id`,
    params
  );
  applyPortalReceptionistNames(rows, await loadPortalReceptionistNameMap(db));
  if (!(await canUsePriplatkyInternalNote(req.session.user))) {
    rows.forEach(r => { delete r.internal_note; });
  }
  res.json(rows);
});

app.post('/api/priplatky/zaznamy', requireLogin, requirePermDefault('priplatky', 'add', true), async (req, res) => {
  const { den, mesic, rok, mesicDatum, rokDatum, sekce, login, hotel, castka,
          poznamka, internal_note, partner, klient, koho_skolil } = req.body;
  const db = getPool();
  if (!(await canTouchPriplatkyLogin(req, login))) {
    return res.status(403).json({ ok: false, msg: 'Můžete přidat jen vlastní záznam.' });
  }
  // mesicDatum/rokDatum = skutečné datum záznamu; mesic/rok = platební měsíc (přehled)
  const dM = mesicDatum || mesic;
  const dR = rokDatum   || rok;
  const datum = `${dR}-${String(dM).padStart(2,'0')}-${String(den).padStart(2,'0')}`;
  try {
    const savedInternalNote = (await canUsePriplatkyInternalNote(req.session.user)) ? (internal_note || null) : null;
    const r = await db.query(
      `INSERT INTO priplatky_zaznamy
         (rok,mesic,sekce,login,datum,hotel,castka,poznamka,internal_note,partner,klient,koho_skolil,vlozil)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [rok, mesic, sekce, login, datum, hotel||null, castka||0,
       poznamka||null, savedInternalNote, partner||null, klient||null, koho_skolil||null,
       req.session.user.username]
    );
    await logEvent(req.session.user.id, req.session.user.username,
      'priplatky_add', { id: r.rows[0].id, login, sekce });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    res.status(400).json({ ok: false, msg: err.message });
  }
});

app.patch('/api/priplatky/zaznamy/:id', requireLogin, requirePermDefault('priplatky', 'edit', true), async (req, res) => {
  const { den, mesic, rok, mesicDatum, rokDatum, sekce, login, hotel, castka,
          poznamka, internal_note, partner, klient, koho_skolil } = req.body;
  const db = getPool();
  if (!(await canTouchPriplatkyRecord(req, db, req.params.id)) || !(await canTouchPriplatkyLogin(req, login))) {
    return res.status(403).json({ ok: false, msg: 'Nemáte oprávnění upravit tento záznam.' });
  }
  const dM = mesicDatum || mesic;
  const dR = rokDatum   || rok;
  const datum = den
    ? `${dR}-${String(dM).padStart(2,'0')}-${String(den).padStart(2,'0')}`
    : undefined;
  try {
    const canInternalNote = await canUsePriplatkyInternalNote(req.session.user);
    await db.query(
      `UPDATE priplatky_zaznamy SET
         rok=$1, mesic=$2, sekce=$3, login=$4,
         datum=COALESCE($5,datum), hotel=$6, castka=$7,
         poznamka=$8, internal_note=CASE WHEN $9 THEN $10 ELSE internal_note END,
         partner=$11, klient=$12, koho_skolil=$13,
         upravil=$14, upraveno_kdy=NOW()
       WHERE id=$15`,
      [rok, mesic, sekce, login, datum||null, hotel||null, castka||0,
       poznamka||null, canInternalNote, internal_note || null, partner||null, klient||null, koho_skolil||null,
       req.session.user.username, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, msg: err.message });
  }
});

app.delete('/api/priplatky/zaznamy/:id', requireLogin, requirePermDefault('priplatky', 'delete', false), async (req, res) => {
  const db = getPool();
  if (!(await canTouchPriplatkyRecord(req, db, req.params.id))) {
    return res.status(403).json({ ok: false, msg: 'Nemáte oprávnění smazat tento záznam.' });
  }
  await db.query(`DELETE FROM priplatky_zaznamy WHERE id=$1`, [req.params.id]);
  await logEvent(req.session.user.id, req.session.user.username,
    'priplatky_delete', { id: req.params.id });
  res.json({ ok: true });
});

// Předdefinované poznámky / důvody (typ: 'brani' | 'obecne')
app.get('/api/priplatky/poznamky', requireLogin, async (req, res) => {
  const db  = getPool();
  const typ = ['brani','obecne'].includes(req.query.typ) ? req.query.typ : 'brani';
  const { rows } = await db.query(
    `SELECT * FROM priplatky_poznamky WHERE typ=$1 ORDER BY poradi, id`, [typ]
  );
  res.json(rows);
});

app.post('/api/priplatky/poznamky', requireLogin, requirePermDefault('priplatky', 'manageTexts', false), async (req, res) => {
  const { text, poradi, typ } = req.body;
  const typVal = ['brani','obecne'].includes(typ) ? typ : 'brani';
  const db = getPool();
  const r = await db.query(
    `INSERT INTO priplatky_poznamky (text, poradi, typ) VALUES ($1,$2,$3) RETURNING *`,
    [text, poradi || 0, typVal]
  );
  res.json({ ok: true, row: r.rows[0] });
});

app.patch('/api/priplatky/poznamky/:id', requireLogin, requirePermDefault('priplatky', 'manageTexts', false), async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ ok:false, msg:'Prázdný text.' });
  const db = getPool();
  const r = await db.query(
    `UPDATE priplatky_poznamky SET text=$1 WHERE id=$2 RETURNING *`,
    [text.trim(), req.params.id]
  );
  res.json({ ok: true, row: r.rows[0] });
});

app.delete('/api/priplatky/poznamky/:id', requireLogin, requirePermDefault('priplatky', 'manageTexts', false), async (req, res) => {
  const db = getPool();
  await db.query(`DELETE FROM priplatky_poznamky WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// Autocomplete pro "Koho školil"
app.get('/api/priplatky/koho-skolil-hints', requireLogin, async (req, res) => {
  const db = getPool();
  const own = await priplatkyOwnFilter(req.session.user);
  const params = [...own.params];
  const ownWhere = own.where
    .replace(/^ AND /, ' WHERE ')
    .replace(/\$IDX/g, `$${params.length || 1}`);
  const { rows } = await db.query(
    `SELECT DISTINCT koho_skolil
     FROM priplatky_zaznamy
     LEFT JOIN receptionist_logins rl ON rl.login = z.login
     ${ownWhere || 'WHERE 1=1'}
       AND koho_skolil IS NOT NULL AND koho_skolil <> ''
     ORDER BY koho_skolil`
    .replace('FROM priplatky_zaznamy', 'FROM priplatky_zaznamy z'),
    params
  );
  res.json(rows.map(r => r.koho_skolil));
});

// Export XLSX
app.get('/api/priplatky/export/xlsx', requireLogin, requirePermDefault('priplatky', 'export', true), async (req, res) => {
  const { rok, mesic } = req.query;
  const db = getPool();
  const own = await priplatkyOwnFilter(req.session.user);
  const params = [rok, mesic, ...own.params];
  const ownWhere = own.where.replace(/\$IDX/g, `$${params.length}`);

  const SEKCE_ORDER = {'braní směn':1,'recenze':2,'školení':3,'ostatní':4,'pokuta':5};

  const { rows: zaznamy } = await db.query(
    `SELECT z.*, rl.full_name
     FROM priplatky_zaznamy z
     LEFT JOIN receptionist_logins rl ON rl.login = z.login
     WHERE z.rok=$1 AND z.mesic=$2${ownWhere}`,
    params
  );
  const portalNameMap = await loadPortalReceptionistNameMap(db);
  applyPortalReceptionistNames(zaznamy, portalNameMap);
  zaznamy.sort((a,b) => {
    const lc = (a.login||'').localeCompare(b.login||'','cs');
    if (lc) return lc;
    const sc = (SEKCE_ORDER[a.sekce]||9) - (SEKCE_ORDER[b.sekce]||9);
    if (sc) return sc;
    return (a.datum||'').toString().localeCompare((b.datum||'').toString());
  });

  const { rows: souhrn } = await db.query(
    `SELECT z.login, rl.full_name,
       SUM(CASE WHEN z.sekce='braní směn' THEN z.castka ELSE 0 END) AS brani_smen,
       SUM(CASE WHEN z.sekce='recenze'    THEN z.castka ELSE 0 END) AS recenze,
       SUM(CASE WHEN z.sekce='školení'    THEN z.castka ELSE 0 END) AS skoleni,
       SUM(CASE WHEN z.sekce='ostatní'    THEN z.castka ELSE 0 END) AS ostatni,
       SUM(CASE WHEN z.sekce='pokuta'     THEN z.castka ELSE 0 END) AS pokuty
     FROM priplatky_zaznamy z
     LEFT JOIN receptionist_logins rl ON rl.login = z.login
     WHERE z.rok=$1 AND z.mesic=$2${ownWhere}
     GROUP BY z.login, rl.full_name ORDER BY z.login`,
    params
  );
  applyPortalReceptionistNames(souhrn, portalNameMap);

  const XLSX = require('xlsx');
  const wb   = XLSX.utils.book_new();
  const MN   = ['','Leden','Únor','Březen','Duben','Květen','Červen',
                 'Červenec','Srpen','Září','Říjen','Listopad','Prosinec'];
  const label = `${MN[mesic]} ${rok}`;

  // Helper: auto-width for specific column indices (0-based)
  function setColWidths(ws, indices, wch) {
    if (!ws['!cols']) ws['!cols'] = [];
    indices.forEach(i => { ws['!cols'][i] = { wch }; });
  }

  // Sheet 1: Souhrn
  const wsSouhrn = XLSX.utils.aoa_to_sheet([
    [`Příplatky a pokuty — ${label}`],
    ['Login','Jméno','Braní směn','Recenze','Školení','Ostatní','Pokuty','Součet'],
    ...souhrn.map(r => {
      const s = (+r.brani_smen)+(+r.recenze)+(+r.skoleni)+(+r.ostatni)-(+r.pokuty);
      return [r.login, r.full_name||'', +r.brani_smen, +r.recenze, +r.skoleni,
              +r.ostatni, +r.pokuty, s];
    }),
  ]);
  // Sloupec B (Jméno) → širší; ostatní číselné sloupce standardní šíře
  setColWidths(wsSouhrn, [1], 24);
  XLSX.utils.book_append_sheet(wb, wsSouhrn, 'Souhrn');

  // Sheet 2: Všechny záznamy (seřazené dle recepčního → sekce → datum)
  // Sloupce: A=Login, B=Jméno, C=Sekce, D=Datum, E=Hotel, F=Částka, G=Poznámka,
  //          H=Partner, I=Klient, J=Koho školil, K=Vložil, L=Vloženo kdy, M=Upravil, N=Upraveno kdy
  const wsZaznamy = XLSX.utils.aoa_to_sheet([
    [`Záznamy — ${label}`],
    ['Login','Jméno','Sekce','Datum','Hotel','Částka Kč','Poznámka','Partner','Klient','Koho školil','Vložil','Vloženo kdy','Upravil','Upraveno kdy'],
    ...zaznamy.map(r => [
      r.login, r.full_name||'', r.sekce,
      r.datum ? r.datum.toISOString().slice(0,10) : '',
      r.hotel||'', r.castka, r.poznamka||'',
      r.partner||'', r.klient||'', r.koho_skolil||'',
      r.vlozil||'',
      r.vlozeno_kdy ? new Date(r.vlozeno_kdy).toLocaleString('cs-CZ') : '',
      r.upravil||'',
      r.upraveno_kdy ? new Date(r.upraveno_kdy).toLocaleString('cs-CZ') : '',
    ]),
  ]);
  // B=1, C=2, D=3, I=8, J=9, L=11, N=13, O=14
  setColWidths(wsZaznamy, [1, 2, 3, 6, 7, 8, 9, 11, 13], 22);
  XLSX.utils.book_append_sheet(wb, wsZaznamy, 'Záznamy');

  const buf  = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  const fname = `Priplatky_${rok}_${String(mesic).padStart(2,'0')}.xlsx`;
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

// Doplnit do šablony (File 2 – 2026_Pokuty_odmeny.xls)
app.post('/api/priplatky/import-template', requireLogin, requirePermDefault('priplatky', 'template', false), async (req, res) => {
  const { rok, mesic, fileData, fileName } = req.body;
  if (!fileData) return res.status(400).json({ ok: false, msg: 'Chybí soubor.' });

  const XLSX = require('xlsx');
  const db   = getPool();

  // Read uploaded workbook (cellStyles:true preserves formatting)
  const buf = Buffer.from(fileData, 'base64');
  const wb  = XLSX.read(buf, { type: 'buffer', cellDates: true, cellStyles: true, sheetStubs: true });

  // Find target sheet by name
  const MESIC_NAZVY = ['','leden','únor','březen','duben','květen','červen',
                        'červenec','srpen','září','říjen','listopad','prosinec'];
  const target = MESIC_NAZVY[parseInt(mesic)] || '';
  let sheetName = wb.SheetNames.find(n => {
    const nl = n.trim().toLowerCase();
    return nl === target || nl.startsWith(target.substring(0,4));
  }) || wb.SheetNames[parseInt(mesic)-1];
  if (!sheetName) return res.status(400).json({ ok:false, msg:`List pro měsíc ${mesic}/${rok} nenalezen.` });

  const ws = wb.Sheets[sheetName];
  if (!ws)  return res.status(400).json({ ok:false, msg:'List je prázdný.' });

  // DB totals
  const { rows: souhrn } = await db.query(
    `SELECT z.login, rl.full_name,
       SUM(CASE WHEN z.sekce='braní směn' THEN z.castka ELSE 0 END) AS brani_smen,
       SUM(CASE WHEN z.sekce='ostatní'    THEN z.castka ELSE 0 END) AS ostatni,
       SUM(CASE WHEN z.sekce='recenze'    THEN z.castka ELSE 0 END) AS recenze,
       SUM(CASE WHEN z.sekce='školení'    THEN z.castka ELSE 0 END) AS skoleni,
       SUM(CASE WHEN z.sekce='pokuta'     THEN z.castka ELSE 0 END) AS pokuty
     FROM priplatky_zaznamy z
     LEFT JOIN receptionist_logins rl ON rl.login = z.login
     WHERE z.rok=$1 AND z.mesic=$2
     GROUP BY z.login, rl.full_name`,
    [rok, mesic]
  );

  // CAD / JUN bonus z Raspisu (600 Kč za Sob/Ne/svátek na hotelu N)
  applyPortalReceptionistNames(souhrn, await loadPortalReceptionistNameMap(db));
  const raspisKey = `${rok}-${String(mesic).padStart(2,'0')}`;
  const { rows: raspisRows } = await db.query('SELECT data FROM rozpisy WHERE key=$1', [raspisKey]);
  const raspisBonuses = {};   // full_name.toLowerCase() → Kč

  if (raspisRows.length > 0) {
    try {
      const rd  = JSON.parse(raspisRows[0].data);
      const staff    = rd.staff    || [];
      const schedule = rd.schedule || {};
      const holidays = getCzechHolidays(parseInt(rok));
      const daysInMonth = new Date(parseInt(rok), parseInt(mesic), 0).getDate();

      for (const targetName of ['Čada Štěpán','Štochlová Gabriela']) {
        const si = staff.findIndex(s => s.name && s.name.trim().toLowerCase() === targetName.toLowerCase());
        if (si < 0) continue;
        let bonus = 0;
        for (let day = 1; day <= daysInMonth; day++) {
          const vD = (schedule[`${si}_${(day-1)*2}`]   || '').toUpperCase();
          const vN = (schedule[`${si}_${(day-1)*2+1}`] || '').toUpperCase();
          if (vD !== 'N' && vN !== 'N') continue;
          const dow = new Date(parseInt(rok), parseInt(mesic)-1, day).getDay();
          const ds  = `${rok}-${String(mesic).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
          if (dow === 0 || dow === 6 || holidays.has(ds)) bonus += 600;
        }
        raspisBonuses[targetName.toLowerCase()] = bonus;
      }
    } catch(e) { console.error('Raspis parse err:', e.message); }
  }

  // Normalize name: lowercase + remove diacritics + collapse spaces
  function normName(n) {
    return String(n||'').trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g,'')
      .replace(/\s+/g,' ');
  }
  // Sort words alphabetically — makes "Ivanov Aleksandr" == "Aleksandr Ivanov"
  function sortedWords(n) { return normName(n).split(' ').sort().join(' '); }

  // Levenshtein distance
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = [];
    for (let i = 0; i <= m; i++) { dp[i] = [i]; }
    for (let j = 0; j <= n; j++) { dp[0][j] = j; }
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  }

  // Build login → sums a name → sums mapy
  const loginToSums = {};  // login (lowercase) → sums
  const nameToSums  = {};  // normName(full_name) → sums
  for (const r of souhrn) {
    const sumsObj = {
      brani_smen: +(r.brani_smen)||0, ostatni: +(r.ostatni)||0,
      recenze:    +(r.recenze)   ||0, skoleni: +(r.skoleni)||0,
      pokuty:     +(r.pokuty)    ||0,
    };
    loginToSums[r.login.toLowerCase()] = sumsObj;
    if (r.full_name) {
      const nk = normName(r.full_name);
      nameToSums[nk] = sumsObj;
      nameToSums[nk].ostatni += raspisBonuses[r.full_name.toLowerCase()] || 0;
    }
  }
  // Raspis-only bonuses
  for (const [k, bonus] of Object.entries(raspisBonuses)) {
    const nk = normName(k);
    if (bonus > 0 && !nameToSums[nk])
      nameToSums[nk] = { brani_smen:0, ostatni:bonus, recenze:0, skoleni:0, pokuty:0 };
  }

  // Strip contract-type suffix ("37,5" / "DPP" / "DPČ" etc.)
  function stripSuffix(n) {
    return n.trim().replace(/\s+([\d]+[,.]?[\d]*|DPP|DPČ|DPC)\s*$/i,'').trim();
  }

  // Hledání přes jméno — víceúrovňové, odolné vůči variantám zápisu
  function findSumsByName(rawName) {
    const clean = normName(stripSuffix(rawName));
    if (!clean) return null;

    // 1) Přesná shoda (normalizovaně)
    if (nameToSums[clean]) return nameToSums[clean];

    // 2) Shoda bez ohledu na pořadí slov (Ivanov Aleksandr == Aleksandr Ivanov)
    const cleanSorted = sortedWords(clean);
    for (const [k, v] of Object.entries(nameToSums))
      if (sortedWords(k) === cleanSorted) return v;

    // 3) Prefix/suffix match (jeden ze řetězců začíná druhým)
    for (const [k, v] of Object.entries(nameToSums))
      if (k.startsWith(clean) || clean.startsWith(k)) return v;

    // 4) Shoda příjmení (první slovo)
    const surname = clean.split(' ')[0];
    if (surname.length >= 3) {
      for (const [k, v] of Object.entries(nameToSums)) {
        const ks = k.split(' ')[0];
        if (ks === surname) return v;
      }
    }

    // 5) Levenshtein ≤ 2 (tolerance překlepů/diakritiky)
    for (const [k, v] of Object.entries(nameToSums))
      if (levenshtein(k, clean) <= 2) return v;

    return null;
  }

  // Build row-fills list using SheetJS (jen čtení struktury)
  // Šablona obsahuje pouze jména (col A) — login matching vynechán
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:L80');
  const rowFills = []; // { excelRow (1-indexed), sums }
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cellA = ws[XLSX.utils.encode_cell({r, c:0})]; // Jméno
    if (!cellA || !cellA.v) continue;
    const rawName = String(cellA.v).trim();
    // Přeskočit záhlaví / součtové řádky
    if (!rawName || /^(celkem|jméno|jmeno|name|login|přihlašovací)/i.test(rawName)) continue;
    const sums = findSumsByName(rawName);
    if (!sums) continue;
    rowFills.push({ excelRow: r + 1, sums }); // Excel rows jsou 1-indexed
  }

  const ext = (fileName||'').toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'xls';

  if (ext === 'xlsx') {
    // ── XLSX: PizZip — přímá XML manipulace → zachová 100% formátování ──────
    const PizZip = require('pizzip');
    const zip    = new PizZip(buf);

    // Najdi XML soubor cílového listu přes workbook.xml + .rels
    const normName = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    const targetNorm = normName(sheetName);

    const wbXml   = zip.file('xl/workbook.xml').asText();
    const wbRels  = zip.file('xl/_rels/workbook.xml.rels').asText();

    let rId = null;
    // name= ... r:id=
    for (const m of wbXml.matchAll(/name="([^"]+)"[^>]*r:id="(rId\d+)"/g))
      if (!rId && normName(m[1]).startsWith(targetNorm.substring(0,4))) rId = m[2];
    // r:id= ... name=  (opačné pořadí atributů)
    if (!rId) for (const m of wbXml.matchAll(/r:id="(rId\d+)"[^>]*name="([^"]+)"/g))
      if (!rId && normName(m[2]).startsWith(targetNorm.substring(0,4))) rId = m[1];

    if (!rId) return res.status(500).json({ ok:false, msg:'Nelze najít list v ZIP souboru.' });

    let sheetPath = null;
    for (const m of wbRels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      if (m[1] === rId) {
        const t = m[2].replace(/^\//, ''); // odstraň úvodní /
        sheetPath = t.startsWith('xl/') ? t : 'xl/' + t;
        break;
      }
    }
    if (!sheetPath || !zip.file(sheetPath))
      return res.status(500).json({ ok:false, msg:'Nelze najít XML listu.' });

    let sheetXml = zip.file(sheetPath).asText();

    // Aktualizuj konkrétní buňku přímou XML manipulací
    function updateCell(xml, addr, val) {
      const v = String(val);

      // 1) Buňka s jakýmkoliv obsahem (včetně shared formula <f t="shared" .../>)
      //    Nahradí celý vnitřní obsah <c>...</c> hodnotou — funguje pro
      //    <c r="E5"><v>0</v></c>  i  <c r="E5" s="2"><f t="shared" .../><v>0</v></c>
      const reFull = new RegExp(`(<c r="${addr}"(?:\\s[^>]*)?>)(?:(?!</c>).)*</c>`, 'gs');
      let out = xml.replace(reFull, `$1<v>${v}</v></c>`);
      if (out !== xml) return out;

      // 2) Self-closing prázdná buňka: <c r="E5" s="2"/>
      const reSelf = new RegExp(`(<c r="${addr}"(?:\\s[^>]*)?)\\/>`, 'g');
      out = xml.replace(reSelf, `$1><v>${v}</v></c>`);
      if (out !== xml) return out;

      // 3) Buňka v XML vůbec není — vlož do příslušného řádku
      const rowN = addr.replace(/[A-Z]+/g, '');
      const reRow = new RegExp(`(<row r="${rowN}"(?:\\s[^>]*)?>)(.*?)(</row>)`, 'gs');
      return xml.replace(reRow, (_, open, cont, close) =>
        `${open}${cont}<c r="${addr}"><v>${v}</v></c>${close}`
      );
    }

    // Sloupce: E=Braní směn, F=Školení, G=Ostatní, H=Recenze, L=Pokuty
    const COLS  = ['E','F','G','H','L'];
    const KEYS  = ['brani_smen','skoleni','ostatni','recenze','pokuty'];

    for (const { excelRow, sums } of rowFills) {
      COLS.forEach((col, i) => {
        if (sums[KEYS[i]] > 0)
          sheetXml = updateCell(sheetXml, `${col}${excelRow}`, sums[KEYS[i]]);
      });
    }

    zip.file(sheetPath, sheetXml);

    // ── Ponechat pouze cílový list — smazat ostatní z ZIP + XML ─────────────
    // Načteme všechny listy z workbook.xml a workbook.xml.rels
    const allRels = new Map(); // rId → target path (v ZIP)
    for (const m of wbRels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      const t = m[2].replace(/^\//, '');
      const p = t.startsWith('xl/') ? t : 'xl/' + t;
      allRels.set(m[1], p);
    }
    // Všechny <sheet ...> záznamy z workbook.xml
    const sheetEntries = [];
    const reSheet = /<sheet\b([^>]*)\/>/gs;
    let mSh;
    while ((mSh = reSheet.exec(wbXml)) !== null) {
      const attrs = mSh[1];
      const mRid  = /r:id="([^"]+)"/.exec(attrs);
      if (mRid) sheetEntries.push({ rId: mRid[1], fullTag: mSh[0] });
    }

    let newWbXml  = wbXml;
    let newWbRels = wbRels;
    let ctXml     = zip.file('[Content_Types].xml').asText();

    for (const { rId, fullTag } of sheetEntries) {
      if (allRels.get(rId) === sheetPath) continue; // zachovat cílový list
      const otherPath = allRels.get(rId);
      // Smažeme sheet z ZIP
      if (otherPath && zip.file(otherPath)) zip.remove(otherPath);
      // Odebereme <sheet .../> z workbook.xml
      newWbXml = newWbXml.replace(fullTag, '');
      // Odebereme <Relationship Id="..." .../> z workbook.xml.rels
      newWbRels = newWbRels.replace(
        new RegExp(`<Relationship[^>]*Id="${rId}"[^/]*/>`,'g'), '');
      // Odebereme z [Content_Types].xml
      if (otherPath) {
        const partName = ('/' + otherPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        ctXml = ctXml.replace(new RegExp(`<Override[^>]*PartName="${partName}"[^/]*/>`, 'g'), '');
      }
    }

    zip.file('xl/workbook.xml', newWbXml);
    zip.file('xl/_rels/workbook.xml.rels', newWbRels);
    zip.file('[Content_Types].xml', ctXml);

    const out = zip.generate({ type:'nodebuffer', compression:'DEFLATE' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(fileName || `export_${rok}_${mesic}.xlsx`)}`);
    return res.send(out);
  }

  // ── XLS fallback: SheetJS best-effort (formátování se nemusí zachovat) ────
  const wbS = XLSX.read(buf, { type:'buffer', cellDates:true, cellStyles:true, sheetStubs:true });
  const wsS = wbS.Sheets[sheetName];
  for (const { excelRow, sums } of rowFills) {
    const ri = excelRow - 1;
    const setCell = (col, val) => {
      if (!val) return;
      const addr = XLSX.utils.encode_cell({r:ri, c:col});
      if (wsS[addr]) { wsS[addr].v = val; wsS[addr].t = 'n'; delete wsS[addr].w; delete wsS[addr].f; }
      else wsS[addr] = { t:'n', v:val };
    };
    setCell(4,  sums.brani_smen);
    setCell(5,  sums.skoleni);
    setCell(6,  sums.ostatni);
    setCell(7,  sums.recenze);
    setCell(11, sums.pokuty);
  }
  // Ponechat pouze cílový list
  wbS.SheetNames = [sheetName];
  Object.keys(wbS.Sheets).forEach(k => { if (k !== sheetName) delete wbS.Sheets[k]; });

  const outXls = XLSX.write(wbS, { type:'buffer', bookType:'xls', cellStyles:true });
  res.setHeader('Content-Type', 'application/vnd.ms-excel');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName || `export_${rok}_${mesic}.xls`)}`);
  res.send(outXls);
});

// (import-file1 removed — historical data imported 2026-05-12, 243 records)
async function _disabledImportFile1(req, res) {
  const { fileData, months } = req.body;
  if (!fileData) return res.status(400).json({ ok:false, msg:'Chybí soubor.' });

  const XLSX = require('xlsx');
  const db   = getPool();
  const wb   = XLSX.read(Buffer.from(fileData,'base64'), { type:'buffer', cellDates:true });

  const ALL_MONTHS = [
    { mesic:1,  rok:2026, prefixes:['leden','jan'] },
    { mesic:2,  rok:2026, prefixes:['unor','feb','únor'] },
    { mesic:3,  rok:2026, prefixes:['brezen','mar','březen'] },
    { mesic:4,  rok:2026, prefixes:['duben','apr'] },
    { mesic:5,  rok:2026, prefixes:['kvet','kveten','maj','may'] },
    { mesic:6,  rok:2026, prefixes:['cerven','jun'] },
    { mesic:7,  rok:2026, prefixes:['cervenec','jul','červenec'] },
    { mesic:8,  rok:2026, prefixes:['srpen','aug'] },
    { mesic:9,  rok:2026, prefixes:['zari','sep','září'] },
    { mesic:10, rok:2026, prefixes:['rijen','oct','říjen'] },
    { mesic:11, rok:2026, prefixes:['listopad','nov'] },
    { mesic:12, rok:2026, prefixes:['prosinec','dec'] },
  ];

  // Filter to requested months (default: 1-5 if not specified)
  const requested = Array.isArray(months) && months.length
    ? months.map(Number).filter(m => m >= 1 && m <= 12)
    : [1, 2, 3, 4, 5];
  const TARGETS = ALL_MONTHS.filter(t => requested.includes(t.mesic));
  const vlozil = 'import-historický';
  let imported = 0;
  const errors = [];

  for (const { mesic, rok, prefixes } of TARGETS) {
    const sheetName = wb.SheetNames.find(n => {
      const nl = n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
      return prefixes.some(p => {
        const pn = p.trim().normalize('NFD').replace(/[̀-ͯ]/g,'');
        // month 6 (cerven): match only if NOT followed by 'ec' (which would be cervenec = July)
        if (mesic === 6) return nl.startsWith('cerven') && !nl.startsWith('cervenec');
        return nl === pn || nl.startsWith(pn.substring(0, Math.min(pn.length, 5)));
      });
    });
    if (!sheetName) { errors.push(`List pro měsíc ${mesic} nenalezen.`); continue; }

    const ws  = wb.Sheets[sheetName];
    const rng = XLSX.utils.decode_range(ws['!ref'] || 'A1');

    // Read all rows into a flat array
    const rows = [];
    for (let ri = rng.s.r; ri <= rng.e.r; ri++) {
      const row = [];
      for (let ci = 0; ci <= Math.max(rng.e.c, 11); ci++) {
        const cell = ws[XLSX.utils.encode_cell({r:ri,c:ci})];
        row.push(cell ? cell.v : null);
      }
      rows.push(row);
    }

    // Detect section header rows (normalize diacritics for safe matching)
    const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    let braniRow=-1,recenzeRow=-1,skoleniRow=-1,ostatniRow=-1,pokutaRow=-1;
    for (let i=0;i<rows.length;i++) {
      const a=norm(rows[i][0]||''), h=norm(rows[i][7]||'');
      if (braniRow<0 && a.includes('brani') && a.includes('sm')) braniRow=i;
      else if (recenzeRow<0 && (a.includes('jmenovit') || (a.includes('recenz') && braniRow>=0))) recenzeRow=i;
      else if (skoleniRow<0 && (a.includes('skolen'))) skoleniRow=i;
      if (ostatniRow<0 && h.includes('ostatn')) ostatniRow=i;
      else if (pokutaRow<0 && h.includes('pokut')) pokutaRow=i;
    }

    function parseEntry(row, colBase, sekce) {
      const loginRaw = row[colBase];
      if (!loginRaw || typeof loginRaw !== 'string') return null;
      const login = loginRaw.trim();
      if (!login || /^(recep[cč]n|datum|hotel|jm[eé]no|login|pokuta|p[rř][ií]platek)$/i.test(norm(login))) return null;
      const castkaRaw = row[colBase+3];
      const castka = typeof castkaRaw === 'number' ? Math.abs(Math.round(castkaRaw)) : 0;
      if (!castka) return null;

      // Parse datum
      let den=1, mEntry=mesic, rEntry=rok;
      const dv = row[colBase+1];
      if (dv instanceof Date) {
        den=dv.getDate(); mEntry=dv.getMonth()+1; rEntry=dv.getFullYear();
      } else if (dv) {
        const s=String(dv).trim();
        const m1=s.match(/^(\d{1,2})\.(\d{1,2})/);
        if (m1) { den=parseInt(m1[1]); mEntry=parseInt(m1[2]); }
        else { const m2=s.match(/^(\d{1,2})\./); if(m2) den=parseInt(m2[1]); }
      }

      const hotel = row[colBase+2] ? String(row[colBase+2]).trim() : null;
      let poznamka=null, klient=null, partner=null, koho_skolil=null;
      if (sekce==='recenze') {
        klient  = row[colBase+4] ? String(row[colBase+4]).trim() : null;
        partner = row[colBase+5] ? String(row[colBase+5]).trim() : null;
      } else if (sekce==='školení') {
        koho_skolil = row[colBase+4] ? String(row[colBase+4]).trim() : null;
      } else {
        poznamka = row[colBase+4] ? String(row[colBase+4]).trim() : null;
      }
      return { login, den, mesic:mEntry, rok:rEntry, hotel:hotel||null,
               castka, poznamka, klient, partner, koho_skolil, sekce };
    }

    const sections = [
      braniRow >=0 ? {start:braniRow+2,  end:recenzeRow>=0?recenzeRow:(skoleniRow>=0?skoleniRow:rows.length), sekce:'braní směn', col:0} : null,
      recenzeRow>=0 ? {start:recenzeRow+2, end:skoleniRow>=0?skoleniRow:rows.length, sekce:'recenze',    col:0} : null,
      skoleniRow>=0 ? {start:skoleniRow+2, end:rows.length,                          sekce:'školení',    col:0} : null,
      ostatniRow>=0 ? {start:ostatniRow+2, end:pokutaRow>=0?pokutaRow:rows.length,   sekce:'ostatní',   col:7} : null,
      pokutaRow >=0 ? {start:pokutaRow+2,  end:rows.length,                          sekce:'pokuta',    col:7} : null,
    ].filter(Boolean);

    for (const { start, end, sekce, col } of sections) {
      for (let i=start; i<Math.min(end,rows.length); i++) {
        const e = parseEntry(rows[i], col, sekce);
        if (!e) continue;
        const entryRok = e.rok > 2020 ? e.rok : rok;
        const datum = `${entryRok}-${String(e.mesic).padStart(2,'0')}-${String(e.den).padStart(2,'0')}`;
        if (isNaN(new Date(datum).getTime())) continue;
        try {
          await db.query(
            `INSERT INTO priplatky_zaznamy
               (rok,mesic,sekce,login,datum,hotel,castka,poznamka,partner,klient,koho_skolil,vlozil)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [entryRok,e.mesic,e.sekce,e.login,datum,
             e.hotel,e.castka,e.poznamka,e.partner,e.klient,e.koho_skolil,vlozil]
          );
          imported++;
        } catch(err) { errors.push(`${e.login} ${datum}: ${err.message}`); }
      }
    }
  }
  res.json({ ok:true, imported, errors:errors.slice(0,20) });
} // end _disabledImportFile1

// ══════════════════════════════════════════════════════════════════════════════
//  PRACOVNÍ SMLOUVY
// ══════════════════════════════════════════════════════════════════════════════

const fs            = require('fs');
const archiver      = require('archiver');
const PizZip        = require('pizzip');
const Docxtemplater = require('docxtemplater');
const XLSX          = require('xlsx');
const TEMPLATES_DIR = path.join(__dirname, 'templates', 'smlouvy');

// ── Stránka ───────────────────────────────────────────────────────────────────
app.get('/smlouvy', requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'smlouvy.html'))
);

// ── Pomocné funkce ────────────────────────────────────────────────────────────

/** HTML date (yyyy-mm-dd) → Czech d.m.yyyy */
function htmlDateToCS(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${parseInt(day)}.${parseInt(m)}.${y}`;
}

/** HTML date (yyyy-mm-dd) → Czech dd.mm.yyyy */
function htmlDateToCS2(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

/** Číslo → "jedno sto osmdesát korun českých" */
function numberToWordsCZK(n) {
  n = parseInt(n);
  if (isNaN(n) || n < 1) return '';
  const ONES = ['','jeden','dva','tři','čtyři','pět','šest','sedm','osm','devět',
    'deset','jedenáct','dvanáct','třináct','čtrnáct','patnáct',
    'šestnáct','sedmnáct','osmnáct','devatenáct'];
  const TENS = ['','','dvacet','třicet','čtyřicet','padesát','šedesát',
    'sedmdesát','osmdesát','devadesát'];
  const HUNDREDS = ['','sto','dvě stě','tři sta','čtyři sta','pět set',
    'šest set','sedm set','osm set','devět set'];
  const parts = [];
  const h = Math.floor(n / 100);
  const mod100 = n % 100;
  const t = Math.floor(mod100 / 10);
  const o = mod100 % 10;
  if (h > 0) parts.push(h === 1 && mod100 > 0 ? 'jedno sto' : HUNDREDS[h]);
  if (mod100 >= 11 && mod100 <= 19) parts.push(ONES[mod100]);
  else { if (t >= 2) parts.push(TENS[t]); if (o > 0) parts.push(ONES[o]); }
  return parts.join(' ') + ' korun českých';
}

/** Sestaví data pro docxtemplater ze surových dat formuláře. */
function buildTemplateData(d, tvurce) {
  const krestni  = (d.krestni  || '').trim();
  const prijmeni = (d.prijmeni || '').trim();
  const jmeno    = `${krestni} ${prijmeni}`;
  const jmeno_rev = `${prijmeni} ${krestni}`;
  const login    = (d.login || '').trim();

  const trvale   = (d.trvale   || '').trim();
  const prechodneRaw = (d.prechodne || '').trim();
  const prechodneBlok = prechodneRaw
    ? `přechodné bydliště:\t${prechodneRaw}` : '';
  const adresaPP = prechodneRaw || trvale;   // pro Informace PP

  const datumNastupu  = htmlDateToCS(d.datumNastupu);
  const datumNastupu2 = htmlDateToCS2(d.datumNastupu);
  const datumPodpisu  = htmlDateToCS(d.datumPodpisu);
  const datumNar      = htmlDateToCS(d.datumNar);
  const datumNar2     = htmlDateToCS2(d.datumNar);
  const zdKonec       = htmlDateToCS(d.zdKonec);
  const smlouvaDo     = htmlDateToCS(d.smlouvaDo);
  const dppDo         = htmlDateToCS(d.dppDo);

  const mzdaNum  = parseInt(d.mzdaNum) || 0;
  const mzda     = `${mzdaNum},- Kč`;
  const mzdaCislo = `${mzdaNum},-`;
  const mzdaSlovy = numberToWordsCZK(mzdaNum);

  // Smlouva doba (jen pro HPP/ZPP)
  let smlouvaDoba = '';
  if (d.smlouvaTrvani === 'urcita' && smlouvaDo) {
    smlouvaDoba = `určitou, od ${datumNastupu} do ${smlouvaDo}`;
  } else {
    smlouvaDoba = 'neurčitou';
  }

  // Zkušební doba
  const zkusebnaDoba = d.zkusebni === 'se'
    ? 'se zkušební dobou 3 měsíce' : 'bez zkušební doby';

  return {
    jmeno, jmeno_rev, prijmeni, krestni, login,
    datumNar, datumNar2,
    mistoNar:   (d.mistoNar   || '').trim(),
    statPrisl:  (d.statPrisl  || '').trim(),
    trvale,
    prechodne:  adresaPP,   // Informace PP: přechodné, nebo trvalé
    prechodneBlok,          // smlouvy DOC: prázdné nebo "přechodné bydliště:\t..."
    email:      (d.email     || '').trim(),
    telefon:    (d.telefon   || '').trim(),
    pojistovna: (d.pojistovna|| '').trim(),
    ucet:       (d.ucet      || '').trim(),
    banka:      (d.banka     || '').trim(),
    datumPodpisu, datumNastupu, datumNastupu2,
    zdKonec, smlouvaDo, dppDo,
    mzda, mzdaCislo, mzdaSlovy,
    smlouvaDoba, zkusebnaDoba,
    tvurce,
  };
}

/** Vyrenderuje .docx šablonu přes docxtemplater, vrátí Buffer. */
function renderDocx(tmplName, data) {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, tmplName));
  const zip     = new PizZip(content);
  const doc     = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks:    true,
    nullGetter:    () => '',
  });
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ── Výběr šablon dle formuláře ────────────────────────────────────────────────
function chooseTemplates(d) {
  const typ = d.typ_smlouvy; // HPP | ZPP | DPC | DPP
  const sml = { HPP: 'sml_HPP.docx', ZPP: 'sml_ZPP.docx',
                DPC: 'sml_DPC.docx', DPP: 'sml_DPP.docx' }[typ] || 'sml_HPP.docx';

  let info;
  if (typ === 'DPC') info = 'Info_PP_DPC.docx';
  else if (typ === 'DPP') info = 'Info_PP_DPP.docx';
  else if (d.uvazek === '24') info = 'Info_PP_24h.docx';
  else if (d.zkusebni === 'se') info = 'Info_PP_375_se_ZD.docx';
  else info = 'Info_PP_375_bez_ZD.docx';

  return { sml, info };
}

// ── POST /api/smlouvy/generate — vrátí ZIP se 7 soubory ─────────────────────
app.post('/api/smlouvy/generate', requireLogin, async (req, res) => {
  try {
    const d      = req.body;
    const login  = (d.login || 'ZAM').trim().replace(/[^A-Za-z0-9_\-]/g, '_');
    const tvurce = req.session.user.name;
    const tdata  = buildTemplateData(d, tvurce);
    const { sml, info } = chooseTemplates(d);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(login + '_smlouvy.zip')}`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    // 1. Pracovní smlouva
    archive.append(renderDocx(sml, tdata),
      { name: `${login}_smlouva.docx` });
    // 2. BOZP
    archive.append(renderDocx('BOZP.docx', tdata),
      { name: `${login}_BOZP.docx` });
    // 3. Dohoda o hmotné odpovědnosti
    archive.append(renderDocx('Dohoda_hmotna_odp.docx', tdata),
      { name: `${login}_Dohoda_hmotna_odp.docx` });
    // 4. Dotazník mzdové účtárny
    archive.append(renderDocx('Dotaznik_mzdova_uctarna.docx', tdata),
      { name: `${login}_Dotaznik_mzdova_uctarna.docx` });
    // 5. Informace o obsahu PP
    archive.append(renderDocx(info, tdata),
      { name: `${login}_Informace_o_obsahu_PP.docx` });
    // 6. Vstupní prohlídka (login = login zaměstnance)
    archive.append(renderDocx('Vstupni_prohlidka.docx', tdata),
      { name: `${login}_Vstupni_prohlidka.docx` });
    // 7. Daňové prohlášení (PDF — prostá kopie)
    archive.append(
      fs.createReadStream(path.join(TEMPLATES_DIR, 'Danove_prohlaseni.pdf')),
      { name: `${login}_Danove_prohlaseni.pdf` });

    await archive.finalize();

    await logEvent(req.session.user.id, req.session.user.username,
      'smlouvy_generate', { login, typ: d.typ_smlouvy });
  } catch (err) {
    console.error('Smlouvy generate error:', err);
    if (!res.headersSent) res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── Drafts ────────────────────────────────────────────────────────────────────
app.get('/api/smlouvy/drafts', requireLogin, async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, jmeno, login, saved_at FROM smlouvy_drafts
     WHERE user_id = $1 ORDER BY saved_at DESC`,
    [req.session.user.id]
  );
  res.json(rows);
});

app.get('/api/smlouvy/drafts/:id', requireLogin, async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM smlouvy_drafts WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.session.user.id]
  );
  if (!rows.length) return res.status(404).json({ ok: false });
  res.json(rows[0]);
});

app.post('/api/smlouvy/drafts', requireLogin, async (req, res) => {
  const { id, data } = req.body;
  const db   = getPool();
  const jmeno = ((data.krestni || '') + ' ' + (data.prijmeni || '')).trim();
  const login  = (data.login || '').trim();
  try {
    if (id) {
      await db.query(
        `UPDATE smlouvy_drafts SET jmeno=$1, login=$2, data=$3, saved_at=NOW()
         WHERE id=$4 AND user_id=$5`,
        [jmeno, login, JSON.stringify(data), id, req.session.user.id]
      );
    } else {
      const r = await db.query(
        `INSERT INTO smlouvy_drafts (user_id, jmeno, login, data)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [req.session.user.id, jmeno, login, JSON.stringify(data)]
      );
      return res.json({ ok: true, id: r.rows[0].id });
    }
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.delete('/api/smlouvy/drafts/:id', requireLogin, async (req, res) => {
  const db = getPool();
  await db.query(
    `DELETE FROM smlouvy_drafts WHERE id=$1 AND user_id=$2`,
    [req.params.id, req.session.user.id]
  );
  res.json({ ok: true });
});

// ── Recepční (zaměstnanci) ───────────────────────────────────────────────────
app.get('/api/smlouvy/recepni', requireLogin, async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM receptionist ORDER BY jmeno`
  );
  res.json(rows);
});

app.post('/api/smlouvy/recepni', requireLogin, async (req, res) => {
  const { jmeno, login, telefon } = req.body;
  const db = getPool();
  try {
    const r = await db.query(
      `INSERT INTO receptionist (jmeno, login, telefon) VALUES ($1,$2,$3) RETURNING *`,
      [jmeno, login, telefon || null]
    );
    res.json({ ok: true, row: r.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, msg: err.message });
  }
});

app.patch('/api/smlouvy/recepni/:id', requireLogin, async (req, res) => {
  const { jmeno, login, telefon, aktivni } = req.body;
  const db = getPool();
  try {
    await db.query(
      `UPDATE receptionist SET jmeno=COALESCE($1,jmeno), login=COALESCE($2,login),
       telefon=COALESCE($3,telefon), aktivni=COALESCE($4,aktivni)
       WHERE id=$5`,
      [jmeno||null, login||null, telefon!==undefined?telefon:null,
       aktivni!==undefined?aktivni:null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, msg: err.message });
  }
});

app.delete('/api/smlouvy/recepni/:id', requireLogin, async (req, res) => {
  const db = getPool();
  await db.query(`DELETE FROM receptionist WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

/** Export: XLS seznam recepčních */
app.get('/api/smlouvy/recepni/export.xls', requireLogin, async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT jmeno, login, telefon, aktivni FROM receptionist ORDER BY jmeno`
  );
  const now   = new Date();
  const mm    = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy  = now.getFullYear();
  const title = `Seznam recepčních - ${mm}/${yyyy}`;

  const wsData = [
    [title],
    ['Č.', 'Jméno', 'Login', 'Telefon'],
    ...rows.map((r, i) => [i + 1, r.jmeno, r.login, r.telefon || ''])
  ];
  const ws  = XLSX.utils.aoa_to_sheet(wsData);
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'recepční');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xls' });

  const fname = `Seznam_recepčních_${yyyy}_${mm}.xls`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

// ── Smazání historických dat 2026 (leden–květen) ─────────────────────────────
// Jednorázové smazání — vyžaduje přihlášení + token.
app.post('/api/priplatky/clear-historicka', requireLogin, async (req, res) => {
  if (req.body.token !== 'clear2026xyz')
    return res.status(403).json({ ok:false, msg:'Nesprávný token.' });
  const db = getPool();
  const r  = await db.query(`DELETE FROM priplatky_zaznamy WHERE rok=2026 AND mesic<=5`);
  res.json({ ok:true, deleted: r.rowCount });
});

// (reimport-historicky disabled — replaced by clear-historicka + manual entry)
async function _disabledReimportHistoricky(req, res) {
  if (req.body.token !== 'reimport2026xyz')
    return res.status(403).json({ ok:false, msg:'Nesprávný token.' });

  const { fileData, months } = req.body;
  if (!fileData) return res.status(400).json({ ok:false, msg:'Chybí soubor.' });

  const XLSX = require('xlsx');
  const db   = getPool();

  // Smazání starého importu
  const del = await db.query(`DELETE FROM priplatky_zaznamy WHERE vlozil='import-historický'`);

  const wb = XLSX.read(Buffer.from(fileData,'base64'), { type:'buffer', cellDates:true });

  const ALL_MONTHS = [
    { mesic:1,  rok:2026, prefixes:['leden','jan'] },
    { mesic:2,  rok:2026, prefixes:['unor','unor','feb','únor'] },
    { mesic:3,  rok:2026, prefixes:['brezen','brez','mar','březen'] },
    { mesic:4,  rok:2026, prefixes:['duben','apr'] },
    { mesic:5,  rok:2026, prefixes:['kvet','kveten','kve','maj','may'] },
    { mesic:6,  rok:2026, prefixes:['cerven','jun'] },
    { mesic:7,  rok:2026, prefixes:['cervenec','jul','červenec'] },
    { mesic:8,  rok:2026, prefixes:['srpen','aug'] },
    { mesic:9,  rok:2026, prefixes:['zari','sep','září'] },
    { mesic:10, rok:2026, prefixes:['rijen','oct','říjen'] },
    { mesic:11, rok:2026, prefixes:['listopad','nov'] },
    { mesic:12, rok:2026, prefixes:['prosinec','dec'] },
  ];

  const requested = Array.isArray(months) && months.length
    ? months.map(Number).filter(m => m >= 1 && m <= 12)
    : [1, 2, 3, 4, 5];
  const TARGETS = ALL_MONTHS.filter(t => requested.includes(t.mesic));

  const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const vlozil = 'import-historický';
  let imported = 0;
  const errors = [];

  for (const { mesic, rok, prefixes } of TARGETS) {
    const sheetName = wb.SheetNames.find(n => {
      const nl = n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
      return prefixes.some(p => {
        const pn = p.normalize('NFD').replace(/[̀-ͯ]/g,'');
        if (mesic === 6) return nl.startsWith('cerven') && !nl.startsWith('cervenec');
        return nl === pn || nl.startsWith(pn.substring(0, Math.min(pn.length, 5)));
      });
    });
    if (!sheetName) { errors.push(`List pro měsíc ${mesic} nenalezen.`); continue; }

    const ws  = wb.Sheets[sheetName];
    const rng = XLSX.utils.decode_range(ws['!ref'] || 'A1');

    // Číst všechny řádky
    const rows = [];
    for (let ri = rng.s.r; ri <= rng.e.r; ri++) {
      const row = [];
      for (let ci = 0; ci <= Math.max(rng.e.c, 13); ci++) {
        const cell = ws[XLSX.utils.encode_cell({r:ri,c:ci})];
        row.push(cell ? cell.v : null);
      }
      rows.push(row);
    }

    // Detekce sekcí
    let brR=-1, reR=-1, skR=-1, osR=-1, poR=-1;
    for (let i = 0; i < rows.length; i++) {
      const a = norm(rows[i][0]||''), h = norm(rows[i][7]||'');
      if (brR < 0 && a.includes('brani') && (a.includes('sm') || a.includes('smen'))) brR = i;
      else if (reR < 0 && (a.includes('jmenovit') || (a.includes('recenz') && brR >= 0))) reR = i;
      else if (skR < 0 && a.includes('skolen')) skR = i;
      if (osR < 0 && h.includes('ostatn')) osR = i;
      else if (poR < 0 && h.includes('pokut')) poR = i;
    }

    // Parsování jednoho záznamu
    function parseEntry(row, colBase, sekce) {
      const loginRaw = row[colBase];
      if (!loginRaw || typeof loginRaw !== 'string') return null;
      const login = loginRaw.trim();
      // Přeskočit záhlaví a prázdné řádky
      if (!login) return null;
      if (/^(recep[cč]n|datum|hotel|jm[eé]no|login|pokuta|p[rř][ií]platek|p[rr]iplatek)$/i.test(norm(login))) return null;

      // Částka musí být kladné číslo
      const castkaRaw = row[colBase + 3];
      const castka = typeof castkaRaw === 'number' ? Math.abs(Math.round(castkaRaw)) : 0;
      if (!castka) return null;

      // Datum — povinný, musí jít parsovat
      let den = null, mEntry = mesic, rEntry = rok;
      const dv = row[colBase + 1];
      if (dv instanceof Date) {
        den = dv.getDate(); mEntry = dv.getMonth() + 1; rEntry = dv.getFullYear();
      } else if (dv) {
        const s = String(dv).trim();
        const m1 = s.match(/^(\d{1,2})\.(\d{1,2})/);
        if (m1) { den = parseInt(m1[1]); mEntry = parseInt(m1[2]); }
        else {
          const m2 = s.match(/^(\d{1,2})\./);
          if (m2) den = parseInt(m2[1]);
          // else: datum nelze parsovat (text jako "prosinec") → přeskočit
        }
      }
      // Pokud datum chybí, přeskočit záznam
      if (den === null) return null;

      // Hotel — jen 1–2 písmenné kódy (ne placeholder text jako "Hotel")
      const hotelRaw = row[colBase + 2] ? String(row[colBase + 2]).trim() : null;
      const hotel = hotelRaw && /^[A-Za-z]{1,2}$/.test(hotelRaw) ? hotelRaw.toUpperCase() : null;

      let poznamka = null, klient = null, partner = null, koho_skolil = null;
      if (sekce === 'recenze') {
        klient  = row[colBase + 4] ? String(row[colBase + 4]).trim() : null;
        partner = row[colBase + 5] ? String(row[colBase + 5]).trim() : null;
      } else if (sekce === 'školení') {
        koho_skolil = row[colBase + 4] ? String(row[colBase + 4]).trim() : null;
      } else {
        poznamka = row[colBase + 4] ? String(row[colBase + 4]).trim() : null;
      }

      // Datum musí být validní
      const entryRok = rEntry > 2020 ? rEntry : rok;
      const datum = `${entryRok}-${String(mEntry).padStart(2,'0')}-${String(den).padStart(2,'0')}`;
      if (isNaN(new Date(datum).getTime())) return null;

      return { login, den, mesic:mEntry, rok:entryRok, hotel,
               castka, poznamka, klient, partner, koho_skolil, sekce, datum };
    }

    const sections = [
      brR >= 0 ? { start:brR+2, end:reR>=0?reR:(skR>=0?skR:rows.length), sekce:'braní směn', col:0 } : null,
      reR >= 0 ? { start:reR+2, end:skR>=0?skR:rows.length,               sekce:'recenze',    col:0 } : null,
      skR >= 0 ? { start:skR+2, end:rows.length,                           sekce:'školení',    col:0 } : null,
      osR >= 0 ? { start:osR+2, end:poR>=0?poR:rows.length,                sekce:'ostatní',   col:7 } : null,
      poR >= 0 ? { start:poR+2, end:rows.length,                           sekce:'pokuta',    col:7 } : null,
    ].filter(Boolean);

    for (const { start, end, sekce, col } of sections) {
      for (let i = start; i < Math.min(end, rows.length); i++) {
        const e = parseEntry(rows[i], col, sekce);
        if (!e) continue;
        try {
          await db.query(
            `INSERT INTO priplatky_zaznamy
               (rok,mesic,sekce,login,datum,hotel,castka,poznamka,partner,klient,koho_skolil,vlozil)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [e.rok, e.mesic, e.sekce, e.login, e.datum,
             e.hotel, e.castka, e.poznamka, e.partner, e.klient, e.koho_skolil, vlozil]
          );
          imported++;
        } catch(err) { errors.push(`${e.login} ${e.datum}: ${err.message}`); }
      }
    }
  }

  res.json({ ok:true, deleted: del.rowCount, imported, errors: errors.slice(0,30) });
} // end _disabledReimportHistoricky

// (temp import-once removed after successful import of 243 records — 2026-05-12)
async function _disabledImportOnce(req, res) {
  if (req.body.token !== 'import2026abc') return res.status(403).json({ ok:false, msg:'Forbidden' });
  const { fileData, months } = req.body;
  if (!fileData) return res.status(400).json({ ok:false, msg:'Chybí soubor.' });
  const XLSX2 = require('xlsx');
  const db2   = getPool();
  const wb2   = XLSX2.read(Buffer.from(fileData,'base64'), { type:'buffer', cellDates:true });
  const ALL2 = [
    {mesic:1,rok:2026,prefixes:['leden','jan']},
    {mesic:2,rok:2026,prefixes:['unor','feb']},
    {mesic:3,rok:2026,prefixes:['brezen','mar']},
    {mesic:4,rok:2026,prefixes:['duben','apr']},
    {mesic:5,rok:2026,prefixes:['kvet','kveten','maj','may']},
  ];
  const TARGETS2 = Array.isArray(months) && months.length
    ? ALL2.filter(t => months.map(Number).includes(t.mesic)) : ALL2;
  const vlozil2 = 'import-historický';
  let imported2 = 0; const errors2 = [];
  const norm2 = s => String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  for (const {mesic:mes,rok,prefixes} of TARGETS2) {
    const sn = wb2.SheetNames.find(n => {
      const nl = n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
      return prefixes.some(p => {
        const pn = p.normalize('NFD').replace(/[̀-ͯ]/g,'');
        return nl === pn || nl.startsWith(pn.substring(0,Math.min(pn.length,5)));
      });
    });
    if (!sn) { errors2.push(`List pro měsíc ${mes} nenalezen.`); continue; }
    const ws2 = wb2.Sheets[sn];
    const rng2 = XLSX2.utils.decode_range(ws2['!ref']||'A1');
    const rows2 = [];
    for (let ri=rng2.s.r;ri<=rng2.e.r;ri++) {
      const row=[]; for(let ci=0;ci<=Math.max(rng2.e.c,11);ci++) { const c=ws2[XLSX2.utils.encode_cell({r:ri,c:ci})]; row.push(c?c.v:null); }
      rows2.push(row);
    }
    let brR=-1,reR=-1,skR=-1,osR=-1,poR=-1;
    for(let i=0;i<rows2.length;i++){
      const a=norm2(rows2[i][0]||''),h=norm2(rows2[i][7]||'');
      if(brR<0&&a.includes('brani')&&a.includes('sm'))brR=i;
      else if(reR<0&&(a.includes('jmenovit')||(a.includes('recenz')&&brR>=0)))reR=i;
      else if(skR<0&&a.includes('skolen'))skR=i;
      if(osR<0&&h.includes('ostatn'))osR=i;
      else if(poR<0&&h.includes('pokut'))poR=i;
    }
    const parseE=(row,cb,sekce)=>{
      const lr=row[cb]; if(!lr||typeof lr!=='string')return null;
      const login=lr.trim(); if(!login||/^(recep[cč]n|datum|hotel|jm[eé]no|login|pokuta|p[rř][ií]platek)$/i.test(norm2(login)))return null;
      const cr=row[cb+3]; const castka=typeof cr==='number'?Math.abs(Math.round(cr)):0; if(!castka)return null;
      let den=1,mE=mes,rE=rok; const dv=row[cb+1];
      if(dv instanceof Date){den=dv.getDate();mE=dv.getMonth()+1;rE=dv.getFullYear();}
      else if(dv){const s=String(dv).trim();const m1=s.match(/^(\d{1,2})\.(\d{1,2})/);if(m1){den=parseInt(m1[1]);mE=parseInt(m1[2]);}else{const m2=s.match(/^(\d{1,2})\./);if(m2)den=parseInt(m2[1]);}}
      const hotel=row[cb+2]?String(row[cb+2]).trim():null;
      let poz=null,kl=null,pa=null,ks=null;
      if(sekce==='recenze'){kl=row[cb+4]?String(row[cb+4]).trim():null;pa=row[cb+5]?String(row[cb+5]).trim():null;}
      else if(sekce==='školení'){ks=row[cb+4]?String(row[cb+4]).trim():null;}
      else{poz=row[cb+4]?String(row[cb+4]).trim():null;}
      return{login,den,mesic:mE,rok:rE,hotel:hotel||null,castka,poznamka:poz,klient:kl,partner:pa,koho_skolil:ks,sekce};
    };
    const secs=[
      brR>=0?{start:brR+2,end:reR>=0?reR:(skR>=0?skR:rows2.length),sekce:'braní směn',col:0}:null,
      reR>=0?{start:reR+2,end:skR>=0?skR:rows2.length,sekce:'recenze',col:0}:null,
      skR>=0?{start:skR+2,end:rows2.length,sekce:'školení',col:0}:null,
      osR>=0?{start:osR+2,end:poR>=0?poR:rows2.length,sekce:'ostatní',col:7}:null,
      poR>=0?{start:poR+2,end:rows2.length,sekce:'pokuta',col:7}:null,
    ].filter(Boolean);
    for(const{start,end,sekce,col}of secs){
      for(let i=start;i<Math.min(end,rows2.length);i++){
        const e=parseE(rows2[i],col,sekce); if(!e)continue;
        const er=e.rok>2020?e.rok:rok;
        const datum=`${er}-${String(e.mesic).padStart(2,'0')}-${String(e.den).padStart(2,'0')}`;
        if(isNaN(new Date(datum).getTime()))continue;
        try{ await db2.query(`INSERT INTO priplatky_zaznamy(rok,mesic,sekce,login,datum,hotel,castka,poznamka,partner,klient,koho_skolil,vlozil)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[er,e.mesic,e.sekce,e.login,datum,e.hotel,e.castka,e.poznamka,e.partner,e.klient,e.koho_skolil,vlozil2]);imported2++; }
        catch(err2){errors2.push(`${e.login} ${datum}: ${err2.message}`);}
      }
    }
  }
  res.json({ok:true,imported:imported2,errors:errors2.slice(0,20)});
} // end _disabledImportOnce

// ══════════════════════════════════════════════════════════════════════════════
// MASTER STAFF — globální seznam recepčních sdílený přes všechny uživatele
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/master-staff — načti seznam
app.get('/api/master-staff', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT data FROM master_staff WHERE id = 1');
    if (!rows.length) return res.json({ ok: true, staff: [] });
    const staff = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    res.json({ ok: true, staff });
  } catch (err) {
    console.error('Chyba načtení master_staff:', err);
    res.json({ ok: false, staff: [], msg: 'Chyba serveru.' });
  }
});

// POST /api/master-staff — ulož seznam (zatím jen admin; v budoucnu konfigurovatelné skupinami)
app.post('/api/master-staff', requireLogin, async (req, res) => {
  const user = req.session.user;
  // Oprávnění: admin nebo skupina s master_staff.edit = true
  const isAdmin = user.role === 'admin';
  if (!isAdmin) {
    // Zkontroluj skupinová oprávnění
    try {
      const db = getPool();
      const { rows: grpRows } = await db.query(
        'SELECT perms FROM permission_groups WHERE name = $1', [user.role]
      );
      const grpPerms = grpRows[0]?.perms || {};
      if (!grpPerms.master_staff?.edit) {
        return res.json({ ok: false, msg: 'Nemáte oprávnění upravovat seznam recepčních.' });
      }
    } catch (e) {
      return res.json({ ok: false, msg: 'Chyba ověření oprávnění.' });
    }
  }
  const { staff } = req.body;
  if (!Array.isArray(staff)) return res.json({ ok: false, msg: 'Neplatná data.' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO master_staff (id, data, updated_at, updated_by)
       VALUES (1, $1, NOW(), $2)
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW(), updated_by = $2`,
      [JSON.stringify(staff), user.id]
    );
    // Log akce
    await db.query(
      'INSERT INTO logs (user_id, user_name, action, details) VALUES ($1, $2, $3, $4)',
      [user.id, user.name, 'master_staff_save', JSON.stringify({ count: staff.length })]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba uložení master_staff:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// RASPIS STAFF — sloučený seznam pracovníků z Správa uživatelů + manuálních záznamů
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/raspis-staff — vrátí pracovníky označené v Správa uživatelů jako aktivní
// + manuální záznamy z master_staff (bez userId)
app.get('/api/raspis-staff', requireLogin, async (req, res) => {
  try {
    const db = getPool();

    // 1. Uživatelé s raspis_staff.active = true v perm_overrides
    const settingsMap = await loadRtStaffSettingsMap(db);
    const { rows: users } = await db.query(
      'SELECT id, name, phone, perm_overrides FROM users WHERE perm_overrides IS NOT NULL'
    );

    const raspisUsers = [];
    for (const u of users) {
      let overrides = null;
      try {
        overrides = typeof u.perm_overrides === 'string'
          ? JSON.parse(u.perm_overrides)
          : u.perm_overrides;
      } catch (e) { continue; }
      const rs = overrides?.raspis_staff;
      if (rs && rs.active) {
        const entry = {
          userId:      u.id,
          displayName: rs.displayName || u.name,
          phone:       u.phone || '',
          login:       rs.login       || '',
          type:        rs.type        || '',
          contract:    rs.contract    || '',
          hotels:      Array.isArray(rs.hotels) ? rs.hotels : [],
          noStandby:   !!rs.noStandby,
          reqXLimit:   rtReqLimit(rs.reqXLimit, 7),
          reqYLimit:   rtReqLimit(rs.reqYLimit, 0),
          activeFrom:  rs.activeFrom  || null,
          activeUntil: rs.activeUntil || null
        };
        const storedSettings = settingsMap.get(String(u.id));
        if (storedSettings) {
          applyRtStaffSettings(entry, storedSettings);
          entry.rtStaffSettingsStored = true;
        }
        raspisUsers.push(entry);
      }
    }

    // 2. Manuální záznamy z master_staff (ty bez userId patří čistě do master_staff)
    const { rows: msRows } = await db.query('SELECT data FROM master_staff WHERE id = 1');
    const masterStaff = msRows.length
      ? (typeof msRows[0].data === 'string' ? JSON.parse(msRows[0].data) : msRows[0].data)
      : [];
    // Přeskočit master_staff záznamy, jejichž login už pokrývá portálový účet (jinak by se zobrazili dvakrát)
    const portalLogins = new Set(raspisUsers.map(u => u.login).filter(Boolean));
    const manualStaff = (masterStaff || []).filter(s => !s.userId && !portalLogins.has(s.login));

    res.json({ ok: true, staff: [...raspisUsers, ...manualStaff] });
  } catch (err) {
    console.error('Chyba /api/raspis-staff:', err);
    res.json({ ok: false, staff: [], msg: 'Chyba serveru.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ── Raspis Test API (/api/rt/) ────────────────────────────────────────────────
// Vacation requests API - separate records, optional sync into monthly note
function vacationParseDays(raw, month, year) {
  const days = Array.isArray(raw) ? raw : [];
  const last = new Date(year, month, 0).getDate();
  const out = [];
  const seen = new Set();
  for (const value of days) {
    const day = parseInt(value, 10);
    if (!Number.isInteger(day) || day < 1 || day > last || seen.has(day)) continue;
    seen.add(day);
    out.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return out.sort();
}

function vacationParseRow(row) {
  const days = (() => {
    try { return typeof row.days_json === 'string' ? JSON.parse(row.days_json || '[]') : (row.days_json || []); }
    catch (e) { return []; }
  })();
  return { ...row, days, days_count: Number(row.days_count || 0) };
}

function vacationFormatDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(value || '');
  return `${parseInt(m[3], 10)}.${parseInt(m[2], 10)}.${m[1]}`;
}

function vacationFormatDays(days, month, year, daysCount = 0) {
  const clean = Array.isArray(days) ? days.filter(Boolean).sort() : [];
  if (!clean.length) {
    const n = Number(daysCount || 0);
    return n > 0 ? `${n} dnu (${month}/${year})` : `${month}/${year}`;
  }
  const parts = [];
  let start = clean[0];
  let prev = clean[0];
  const dayNum = v => parseInt(String(v).slice(8, 10), 10);
  const flush = () => {
    parts.push(start === prev ? vacationFormatDate(start) : `${dayNum(start)}.-${vacationFormatDate(prev)}`);
  };
  for (let i = 1; i < clean.length; i++) {
    const d = clean[i];
    if (dayNum(d) === dayNum(prev) + 1) prev = d;
    else { flush(); start = prev = d; }
  }
  flush();
  return parts.join(', ');
}

function vacationManagerRole(user) {
  const role = String(user?.role || '').toLowerCase();
  return role === 'admin' || role.includes('ved');
}

async function canManageVacationsServer(user) {
  return vacationManagerRole(user)
    || await hasButtonPerm(user, 'dovolene', 'manage', false)
    || await hasButtonPerm(user, 'dovolene', 'viewAll', false);
}

async function vacationCanDelete(user) {
  return vacationManagerRole(user) || await hasButtonPerm(user, 'dovolene', 'delete', false);
}

async function vacationCanSyncNote(user) {
  return vacationManagerRole(user) || await hasButtonPerm(user, 'dovolene', 'syncNote', false);
}

async function vacationCanBulkDelete(user) {
  return user?.role === 'admin' || await hasButtonPerm(user, 'dovolene', 'bulkDelete', false);
}

async function vacationCanManageBalances(user) {
  return vacationManagerRole(user) || await hasButtonPerm(user, 'dovolene', 'manageBalances', false);
}

async function vacationResolveStaff(req, body, db) {
  const user = req.session.user;
  const staff = await loadRtPortalReceptionists(db);
  const canManage = await canManageVacationsServer(user);
  let found = null;
  if (canManage && body?.staff_user_id) found = staff.find(s => String(s.userId || '') === String(body.staff_user_id));
  if (canManage && !found && body?.staff_login) {
    const login = String(body.staff_login || '').trim().toUpperCase();
    found = staff.find(s => String(s.login || '').trim().toUpperCase() === login);
  }
  if (!found) {
    const login = String(user.username || user.login || '').trim().toUpperCase();
    found = staff.find(s => String(s.userId || '') === String(user.id))
      || staff.find(s => String(s.login || '').trim().toUpperCase() === login);
  }
  return found || { userId: user.id, displayName: user.name, login: String(user.username || user.login || '').trim().toUpperCase() };
}

async function vacationAppendMonthlyNote(db, item, noteText, user) {
  const text = String(noteText || '').trim();
  if (!text || !item.staff_user_id) return false;
  const key = `${item.year}-${item.month}`;
  const { rows } = await db.query('SELECT data FROM rt_staff_settings WHERE user_id = $1', [item.staff_user_id]);
  const current = rows.length ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data || '{}') : (rows[0].data || {})) : {};
  const normalized = normalizeRtStaffSettings(current);
  normalized.monthlyOverrides = normalized.monthlyOverrides && typeof normalized.monthlyOverrides === 'object' ? normalized.monthlyOverrides : {};
  const monthData = normalized.monthlyOverrides[key] && typeof normalized.monthlyOverrides[key] === 'object' ? normalized.monthlyOverrides[key] : {};
  const oldNote = String(monthData.noteM || '').trim();
  monthData.noteM = oldNote ? (oldNote.includes(text) ? oldNote : `${oldNote}; ${text}`) : text;
  normalized.monthlyOverrides[key] = monthData;
  await db.query(
    `INSERT INTO rt_staff_settings (user_id, data, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (user_id) DO UPDATE
     SET data = EXCLUDED.data, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [item.staff_user_id, JSON.stringify(normalized), user.id]
  );
  await db.query(
    `UPDATE vacation_requests SET synced_to_month_note_at = NOW(), synced_note_text = $2, updated_at = NOW() WHERE id = $1`,
    [item.id, text]
  );
  return true;
}

app.get('/api/vacations/staff', requireLogin, async (req, res) => {
  try {
    if (!await canManageVacationsServer(req.session.user)) return res.status(403).json({ ok: false, msg: 'Nemate opravneni.' });
    const db = getPool();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const active = (await loadRtPortalReceptionists(db)).filter(s => rtIsStaffActiveForMonth(s, month, year));
    res.json({ ok: true, staff: active.map(s => ({ userId: s.userId, login: s.login, name: s.displayName || s.name || s.login })) });
  } catch (err) { console.error('Chyba /api/vacations/staff:', err); res.status(500).json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.get('/api/vacations', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const manager = await canManageVacationsServer(user);
    const where = [];
    const params = [];
    const add = v => { params.push(v); return `$${params.length}`; };
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (month >= 1 && month <= 12) where.push(`month = ${add(month)}`);
    if (year >= 2000 && year <= 2100) where.push(`year = ${add(year)}`);
    if (req.query.status && req.query.status !== 'all') where.push(`status = ${add(String(req.query.status))}`);
    if (!manager) {
      const login = String(user.username || user.login || '').trim().toUpperCase();
      where.push(`(staff_user_id = ${add(user.id)} OR UPPER(staff_login) = ${add(login)})`);
    }
    const { rows } = await db.query(
      `SELECT * FROM vacation_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY year DESC, month DESC, created_at DESC, id DESC`, params);
    const userLogin = String(user.username || user.login || '').trim().toUpperCase();
    const canDelete = await vacationCanDelete(user);
    const items = rows.map(row => {
      const item = vacationParseRow(row);
      const own = String(row.staff_user_id || '') === String(user.id)
        || String(row.created_by || '') === String(user.id)
        || String(row.staff_login || '').toUpperCase() === userLogin;
      return {
        ...item,
        canEdit: !manager && ['pending', 'needs_info'].includes(String(row.status || '')),
        canDelete
      };
    });
    res.json({ ok: true, manager, userId: user.id, userLogin, userName: user.name || userLogin, items });
  } catch (err) { console.error('Chyba GET /api/vacations:', err); res.status(500).json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.get('/api/vacations/summary', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const manager = await canManageVacationsServer(user);
    const userLogin = String(user.username || user.login || '').trim().toUpperCase();
    let rows;
    if (manager) {
      ({ rows } = await db.query(
        "SELECT COUNT(*)::int AS count, MAX(GREATEST(created_at, updated_at)) AS latest_at FROM vacation_requests WHERE status IN ('pending','needs_info')"
      ));
    } else {
      ({ rows } = await db.query(
        "SELECT COUNT(*)::int AS count, MAX(GREATEST(created_at, updated_at)) AS latest_at FROM vacation_requests WHERE (staff_user_id = $1 OR UPPER(staff_login) = $2) AND status IN ('approved','rejected','needs_info')",
        [user.id, userLogin]
      ));
    }
    const row = rows[0] || {};
    const count = Number(row.count || 0);
    const latestAt = row.latest_at ? new Date(row.latest_at).toISOString() : '';
    const scope = manager ? 'manager' : 'own';
    const signature = 'vacations:' + scope + ':' + count + ':' + latestAt;
    const { rows: seenRows } = await db.query(
      'SELECT signature FROM user_notification_reads WHERE user_id=$1 AND notification_type=$2',
      [user.id, 'vacations']
    );
    const unseen = count > 0 && String(seenRows[0]?.signature || '') !== signature;
    res.json({ ok: true, manager, userLogin, scope, count, latestAt: latestAt || null, signature, unseen });
  } catch (err) {
    console.error('Chyba GET /api/vacations/summary:', err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

async function buildVacationNotification(db, user) {
  const manager = await canManageVacationsServer(user);
  const userLogin = String(user.username || user.login || '').trim().toUpperCase();
  let rows;
  if (manager) {
    ({ rows } = await db.query(
      "SELECT COUNT(*)::int AS count, MAX(GREATEST(created_at, updated_at)) AS latest_at FROM vacation_requests WHERE status IN ('pending','needs_info')"
    ));
  } else {
    ({ rows } = await db.query(
      "SELECT COUNT(*)::int AS count, MAX(GREATEST(created_at, updated_at)) AS latest_at FROM vacation_requests WHERE (staff_user_id = $1 OR UPPER(staff_login) = $2) AND status IN ('approved','rejected','needs_info')",
      [user.id, userLogin]
    ));
  }
  const row = rows[0] || {};
  const count = Number(row.count || 0);
  const latestAt = row.latest_at ? new Date(row.latest_at).toISOString() : '';
  const scope = manager ? 'manager' : 'own';
  const signature = 'vacations:' + scope + ':' + count + ':' + latestAt;
  return { type: 'vacations', message: 'Zm\u011bna v sekci dovolen\u00e9', scope, userLogin, count, latestAt, signature };
}

app.get('/api/notifications/summary', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const vacation = await buildVacationNotification(db, user);
    const notifications = [];
    if (vacation.count > 0) {
      const { rows } = await db.query(
        'SELECT signature FROM user_notification_reads WHERE user_id=$1 AND notification_type=$2',
        [user.id, vacation.type]
      );
      if (String(rows[0]?.signature || '') !== vacation.signature) notifications.push(vacation);
    }
    res.json({ ok: true, userLogin: String(user.username || user.login || '').trim().toUpperCase(), notifications });
  } catch (err) {
    console.error('Chyba GET /api/notifications/summary:', err);
    res.status(500).json({ ok: false, msg: 'Chyba nacteni notifikaci.' });
  }
});

app.post('/api/notifications/seen', requireLogin, async (req, res) => {
  try {
    const type = String(req.body?.type || '').trim();
    const signature = String(req.body?.signature || '').trim();
    if (!type || !signature || type.length > 50) return res.status(400).json({ ok: false, msg: 'Neplatna notifikace.' });
    await getPool().query(
      `INSERT INTO user_notification_reads (user_id, notification_type, signature, seen_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id, notification_type) DO UPDATE SET signature=EXCLUDED.signature, seen_at=NOW()`,
      [req.session.user.id, type, signature]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba POST /api/notifications/seen:', err);
    res.status(500).json({ ok: false, msg: 'Chyba ulozeni notifikace.' });
  }
});
app.post('/api/vacations', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const month = parseInt(req.body?.month, 10);
    const year = parseInt(req.body?.year, 10);
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) return res.status(400).json({ ok: false, msg: 'Neplatny mesic nebo rok.' });
    const staff = await vacationResolveStaff(req, req.body, db);
    const days = vacationParseDays(req.body?.days, month, year);
    const daysCount = Math.max(0, Math.min(31, parseInt(req.body?.days_count, 10) || 0));
    if (!days.length && daysCount <= 0) return res.status(400).json({ ok: false, msg: 'Vyberte datum nebo pocet dni.' });
    const note = String(req.body?.note || '').trim();
    const { rows } = await db.query(
      `INSERT INTO vacation_requests (staff_user_id, staff_login, staff_name, month, year, days_json, days_count, note, status, created_by, created_name, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,NOW()) RETURNING *`,
      [staff.userId || null, String(staff.login || '').trim().toUpperCase(), staff.displayName || staff.name || staff.login, month, year, JSON.stringify(days), daysCount, note, user.id, user.name]
    );
    res.json({ ok: true, item: vacationParseRow(rows[0]) });
  } catch (err) { console.error('Chyba POST /api/vacations:', err); res.status(500).json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.patch('/api/vacations/:id', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const { rows } = await db.query('SELECT * FROM vacation_requests WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Zadost nenalezena.' });
    const item = rows[0];
    const own = String(item.staff_user_id || '') === String(user.id)
      || String(item.created_by || '') === String(user.id)
      || String(item.staff_login || '').toUpperCase() === String(user.username || user.login || '').toUpperCase();
    if (!own || !['pending', 'needs_info'].includes(item.status)) return res.status(403).json({ ok: false, msg: 'Tuto zadost nemuzete upravit.' });
    const month = parseInt(req.body?.month, 10) || item.month;
    const year = parseInt(req.body?.year, 10) || item.year;
    const days = vacationParseDays(req.body?.days, month, year);
    const daysCount = Math.max(0, Math.min(31, parseInt(req.body?.days_count, 10) || 0));
    if (!days.length && daysCount <= 0) return res.status(400).json({ ok: false, msg: 'Vyberte datum nebo pocet dni.' });
    const nextStatus = (!manager && item.status === 'needs_info') ? 'pending' : item.status;
    const note = String(req.body?.note || '').trim();
    const { rows: updated } = await db.query(
      `UPDATE vacation_requests SET month=$1, year=$2, days_json=$3, days_count=$4, note=$5, status=$6, updated_at=NOW(), resolved_by=NULL, resolved_name=NULL, resolved_at=NULL WHERE id=$7 RETURNING *`,
      [month, year, JSON.stringify(days), daysCount, note, nextStatus, req.params.id]
    );
    res.json({ ok: true, item: vacationParseRow(updated[0]) });
  } catch (err) { console.error('Chyba PATCH /api/vacations:', err); res.status(500).json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.post('/api/vacations/:id/status', requireLogin, async (req, res) => {
  try {
    if (!await canManageVacationsServer(req.session.user)) return res.status(403).json({ ok: false, msg: 'Nemate opravneni.' });
    const status = String(req.body?.status || '').trim();
    if (!['pending', 'approved', 'rejected', 'needs_info'].includes(status)) return res.status(400).json({ ok: false, msg: 'Neplatny status.' });
    const db = getPool();
    const user = req.session.user;
    const comment = String(req.body?.manager_comment || '').trim();
    const { rows } = await db.query(
      `UPDATE vacation_requests SET status=$1, manager_comment=$2, resolved_by=$3, resolved_name=$4, resolved_at=NOW(), updated_at=NOW() WHERE id=$5 RETURNING *`,
      [status, comment, user.id, user.name, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Zadost nenalezena.' });
    let item = vacationParseRow(rows[0]);
    let synced = false;
    if (status === 'approved' && req.body?.syncNote === true && await vacationCanSyncNote(user)) {
      const text = String(req.body?.sync_note_text || '').trim() || `Dovolena ${vacationFormatDays(item.days, item.month, item.year, item.days_count)}`;
      synced = await vacationAppendMonthlyNote(db, item, text, user);
      const { rows: fresh } = await db.query('SELECT * FROM vacation_requests WHERE id=$1', [item.id]);
      item = vacationParseRow(fresh[0] || rows[0]);
    }
    res.json({ ok: true, item, synced });
  } catch (err) { console.error('Chyba POST /api/vacations/:id/status:', err); res.status(500).json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.delete('/api/vacations/:id', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const { rows } = await db.query('SELECT * FROM vacation_requests WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Zadost nenalezena.' });
    const item = rows[0];
    const canDelete = await vacationCanDelete(user);
    if (!canDelete) return res.status(403).json({ ok: false, msg: 'Tuto zadost nemuzete smazat.' });
    await db.query('DELETE FROM vacation_requests WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error('Chyba DELETE /api/vacations:', err); res.status(500).json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.post('/api/vacations/bulk-delete', requireLogin, async (req, res) => {
  try {
    if (!await vacationCanBulkDelete(req.session.user)) return res.status(403).json({ ok: false, msg: 'Nemate opravneni.' });
    const months = Array.isArray(req.body?.months) ? req.body.months : [];
    const valid = months.map(m => ({ month: parseInt(m.month, 10), year: parseInt(m.year, 10) })).filter(m => m.month >= 1 && m.month <= 12 && m.year >= 2000 && m.year <= 2100);
    if (!valid.length) return res.status(400).json({ ok: false, msg: 'Vyberte mesice ke smazani.' });
    const params = [];
    const clauses = valid.map(m => { params.push(m.year, m.month); return `(year = $${params.length - 1} AND month = $${params.length})`; });
    const { rowCount } = await getPool().query(`DELETE FROM vacation_requests WHERE ${clauses.join(' OR ')}`, params);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error('Chyba POST /api/vacations/bulk-delete:', err); res.status(500).json({ ok: false, msg: 'Chyba serveru.' }); }
});
// Kompletně separátní data od Raspis VR (vlastní tabulky rt_drafts, rt_schedules)
function vacationContractKey(contract) {
  const c = String(contract || '').trim().toUpperCase();
  if (c.includes('DPP')) return 'DPP';
  if (c.includes('DPC') || c.includes('DP')) return 'DPC';
  if (c.includes('ZPP')) return 'ZPP';
  if (c.includes('HPP')) return 'HPP';
  return '';
}

function vacationHasBalanceContract(contract) {
  return vacationContractKey(contract) !== 'DPP';
}

function vacationDayHoursByContract(contract) {
  const key = vacationContractKey(contract);
  if (key === 'DPC') return 4;
  if (key === 'ZPP') return 4.8;
  if (key === 'DPP') return 0;
  return 7.5;
}

function vacationScheduleKey(month, year) {
  return `RT:${String(month).padStart(2, '0')}/${year}`;
}

function vacationDateSourceKey(scheduleKey, staffLogin, year, month, day) {
  return `schedule:${scheduleKey}:${String(staffLogin || '').toUpperCase()}:${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function vacationStaffSort(a, b) {
  return String(a.staff_name || a.name || '').localeCompare(String(b.staff_name || b.name || ''), 'cs', { sensitivity: 'base' });
}

async function vacationEnsureBalance(db, staff, user) {
  const login = String(staff.login || staff.staff_login || '').trim().toUpperCase();
  if (!login) return null;
  const name = staff.displayName || staff.name || staff.staff_name || login;
  const contract = staff.contract || '';
  if (!vacationHasBalanceContract(contract)) return null;
  const dayHours = vacationDayHoursByContract(contract);
  const baseDays = 20;
  const baseHours = +(baseDays * dayHours).toFixed(2);
  const { rows } = await db.query(
    `INSERT INTO vacation_balance_settings
     (staff_user_id, staff_login, staff_name, contract, base_days, base_hours, day_hours, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (staff_login) DO UPDATE SET
       staff_user_id = COALESCE(vacation_balance_settings.staff_user_id, EXCLUDED.staff_user_id),
       staff_name = EXCLUDED.staff_name,
       contract = COALESCE(NULLIF(vacation_balance_settings.contract, ''), EXCLUDED.contract),
       day_hours = CASE WHEN vacation_balance_settings.day_hours = 0 THEN EXCLUDED.day_hours ELSE vacation_balance_settings.day_hours END,
       base_hours = CASE WHEN vacation_balance_settings.base_hours = 0 THEN EXCLUDED.base_hours ELSE vacation_balance_settings.base_hours END,
       updated_at = vacation_balance_settings.updated_at
     RETURNING *`,
    [staff.userId || staff.staff_user_id || null, login, name, contract, baseDays, baseHours, dayHours, user?.id || null]
  );
  return rows[0];
}

async function vacationBalanceRows(db, user) {
  const manager = await canManageVacationsServer(user);
  const canManageBalances = await vacationCanManageBalances(user);
  const staffList = await loadRtPortalReceptionists(db);
  const eligibleStaff = staffList.filter(s => vacationHasBalanceContract(s.contract));
  const filteredStaff = (manager || canManageBalances) ? eligibleStaff : eligibleStaff.filter(s => {
    const login = String(user.username || user.login || '').trim().toUpperCase();
    return String(s.userId || '') === String(user.id) || String(s.login || '').trim().toUpperCase() === login;
  });
  const logins = filteredStaff.map(s => String(s.login || '').trim().toUpperCase()).filter(Boolean);
  if (!logins.length) return { manager, canManageBalances, balances: [] };
  const { rows: settingsRows } = await db.query(
    `SELECT b.*,
            COALESCE(SUM(m.days_delta), 0) AS moved_days,
            COALESCE(SUM(m.hours_delta), 0) AS moved_hours
       FROM vacation_balance_settings b
       LEFT JOIN vacation_movements m ON UPPER(m.staff_login) = UPPER(b.staff_login)
        AND (b.base_from_year IS NULL OR m.year > b.base_from_year OR (m.year = b.base_from_year AND COALESCE(m.month, 1) >= COALESCE(b.base_from_month, 1)))
      WHERE UPPER(b.staff_login) = ANY($1::text[])
      GROUP BY b.id`,
    [logins]
  );
  const settingsByLogin = new Map(settingsRows.map(r => [String(r.staff_login || '').trim().toUpperCase(), r]));
  const missingLogins = logins.filter(login => !settingsByLogin.has(login));
  const movementByLogin = new Map();
  if (missingLogins.length) {
    const { rows: movementRows } = await db.query(
      `SELECT UPPER(staff_login) AS staff_login,
              COALESCE(SUM(days_delta), 0) AS moved_days,
              COALESCE(SUM(hours_delta), 0) AS moved_hours
         FROM vacation_movements
        WHERE UPPER(staff_login) = ANY($1::text[])
        GROUP BY UPPER(staff_login)`,
      [missingLogins]
    );
    movementRows.forEach(r => movementByLogin.set(String(r.staff_login || '').trim().toUpperCase(), r));
  }
  const balances = filteredStaff.map(staff => {
    const login = String(staff.login || '').trim().toUpperCase();
    const saved = settingsByLogin.get(login);
    const moved = saved || movementByLogin.get(login) || {};
    const contract = saved?.contract || staff.contract || '';
    const defaultDayHours = vacationDayHoursByContract(contract);
    const savedDayHours = Number(saved?.day_hours || 0);
    const dayHours = defaultDayHours || savedDayHours;
    const baseDays = saved ? Number(saved.base_days || 0) : 20;
    const baseHours = saved ? Number(saved.base_hours || 0) : +(baseDays * dayHours).toFixed(2);
    const movedDays = Number(moved.moved_days || 0);
    const movedHours = Number(moved.moved_hours || 0);
    return {
      id: saved?.id || null,
      staff_user_id: saved?.staff_user_id || staff.userId || null,
      staff_login: login,
      staff_name: saved?.staff_name || staff.displayName || staff.name || login,
      contract,
      base_days: baseDays,
      base_hours: baseHours,
      day_hours: dayHours,
      base_from_month: saved?.base_from_month || null,
      base_from_year: saved?.base_from_year || null,
      note: saved?.note || '',
      moved_days: movedDays,
      moved_hours: movedHours,
      remaining_days: +(baseDays + movedDays).toFixed(2),
      remaining_hours: +(baseHours + movedHours).toFixed(2)
    };
  }).sort(vacationStaffSort);
  return { manager, canManageBalances, balances };
}

app.get('/api/vacations/balances', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const result = await vacationBalanceRows(db, req.session.user);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Chyba GET /api/vacations/balances:', err);
    res.status(500).json({ ok: false, msg: 'Chyba nacteni zustatku.' });
  }
});

app.post('/api/vacations/balances/:login', requireLogin, async (req, res) => {
  try {
    if (!await vacationCanManageBalances(req.session.user)) return res.status(403).json({ ok: false, msg: 'Nemate opravneni.' });
    const login = String(req.params.login || '').trim().toUpperCase();
    const baseDays = Number(req.body?.base_days);
    const dayHours = Number(req.body?.day_hours);
    if (!login || !Number.isFinite(baseDays) || baseDays < 0 || !Number.isFinite(dayHours) || dayHours < 0) {
      return res.status(400).json({ ok: false, msg: 'Neplatny zustatek.' });
    }
    const baseHours = Number.isFinite(Number(req.body?.base_hours)) ? Number(req.body.base_hours) : +(baseDays * dayHours).toFixed(2);
    const baseFromMonth = parseInt(req.body?.base_from_month, 10);
    const baseFromYear = parseInt(req.body?.base_from_year, 10);
    const fromMonth = baseFromMonth >= 1 && baseFromMonth <= 12 ? baseFromMonth : null;
    const fromYear = baseFromYear >= 2000 && baseFromYear <= 2100 ? baseFromYear : null;
    const staff = (await loadRtPortalReceptionists(getPool())).find(s => String(s.login || '').trim().toUpperCase() === login) || {};
    await getPool().query(
      `INSERT INTO vacation_balance_settings
       (staff_user_id, staff_login, staff_name, contract, base_days, base_hours, day_hours, base_from_month, base_from_year, note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (staff_login) DO UPDATE SET
         staff_user_id = EXCLUDED.staff_user_id,
         staff_name = EXCLUDED.staff_name,
         contract = EXCLUDED.contract,
         base_days = EXCLUDED.base_days,
         base_hours = EXCLUDED.base_hours,
         day_hours = EXCLUDED.day_hours,
         base_from_month = EXCLUDED.base_from_month,
         base_from_year = EXCLUDED.base_from_year,
         note = EXCLUDED.note,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [staff.userId || null, login, staff.displayName || staff.name || req.body?.staff_name || login, staff.contract || req.body?.contract || '', baseDays, baseHours, dayHours, fromMonth, fromYear, String(req.body?.note || ''), req.session.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba POST /api/vacations/balances:', err);
    res.status(500).json({ ok: false, msg: 'Chyba ulozeni zustatku.' });
  }
});

app.get('/api/vacations/movements', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const user = req.session.user;
    const manager = await canManageVacationsServer(user);
    const where = [];
    const params = [];
    const add = v => { params.push(v); return `$${params.length}`; };
    if (req.query.login) where.push(`UPPER(staff_login) = ${add(String(req.query.login).trim().toUpperCase())}`);
    if (req.query.year) where.push(`year = ${add(parseInt(req.query.year, 10))}`);
    if (req.query.month && req.query.month !== 'all') where.push(`month = ${add(parseInt(req.query.month, 10))}`);
    if (!manager) {
      const login = String(user.username || user.login || '').trim().toUpperCase();
      where.push(`UPPER(staff_login) = ${add(login)}`);
    }
    const { rows } = await db.query(
      `SELECT * FROM vacation_movements ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY LOWER(staff_name), year, month, day, id`, params
    );
    res.json({ ok: true, manager, movements: rows });
  } catch (err) {
    console.error('Chyba GET /api/vacations/movements:', err);
    res.status(500).json({ ok: false, msg: 'Chyba nacteni pohybu.' });
  }
});

app.post('/api/vacations/movements', requireLogin, async (req, res) => {
  try {
    if (!await canManageVacationsServer(req.session.user)) return res.status(403).json({ ok: false, msg: 'Nemate opravneni.' });
    const login = String(req.body?.staff_login || '').trim().toUpperCase();
    const year = parseInt(req.body?.year, 10);
    if (!login || !(year >= 2000 && year <= 2100)) return res.status(400).json({ ok: false, msg: 'Chybi recepcni nebo rok.' });
    const staff = (await loadRtPortalReceptionists(getPool())).find(s => String(s.login || '').trim().toUpperCase() === login) || {};
    await vacationEnsureBalance(getPool(), { ...staff, login, displayName: staff.displayName || req.body?.staff_name || login }, req.session.user);
    await getPool().query(
      `INSERT INTO vacation_movements
       (staff_user_id, staff_login, staff_name, year, month, day, movement_type, source_label, days_delta, hours_delta, note, created_by, created_name)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9,$10,$11,$12)`,
      [staff.userId || null, login, staff.displayName || staff.name || req.body?.staff_name || login, year,
       parseInt(req.body?.month, 10) || null, parseInt(req.body?.day, 10) || null, 'Rucni korekce',
       Number(req.body?.days_delta || 0), Number(req.body?.hours_delta || 0), String(req.body?.note || ''), req.session.user.id, req.session.user.name]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba POST /api/vacations/movements:', err);
    res.status(500).json({ ok: false, msg: 'Chyba ulozeni pohybu.' });
  }
});

app.delete('/api/vacations/movements/:id', requireLogin, async (req, res) => {
  try {
    if (!await canManageVacationsServer(req.session.user)) return res.status(403).json({ ok: false, msg: 'Nemate opravneni.' });
    await getPool().query('DELETE FROM vacation_movements WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba DELETE /api/vacations/movements:', err);
    res.status(500).json({ ok: false, msg: 'Chyba smazani pohybu.' });
  }
});
function vacationParseScheduleKey(key) {
  const m = String(key || '').match(/^RT:(\d{2})\/(\d{4})$/);
  return m ? { month: Number(m[1]), year: Number(m[2]) } : { month: null, year: null };
}

function vacationCollectScheduleZDays(scheduleKey, month, year, data) {
  const staff = Array.isArray(data?.staff) ? data.staff : [];
  const schedule = data?.schedule && typeof data.schedule === 'object' ? data.schedule : {};
  const desired = new Map();
  let found = 0;
  for (let si = 0; si < staff.length; si++) {
    const s = staff[si] || {};
    const login = String(s.login || s.username || '').trim().toUpperCase();
    if (!login || !rtIsReceptionistType(s.type)) continue;
    const seenDays = new Set();
    for (const [cellKey, raw] of Object.entries(schedule)) {
      const m = String(cellKey).match(/^(\d+)_(\d+)$/);
      if (!m || Number(m[1]) !== si) continue;
      if (String(raw || '').trim().toLowerCase() !== 'z') continue;
      const day = Math.floor(Number(m[2]) / 2) + 1;
      if (day < 1 || day > 31 || seenDays.has(day)) continue;
      seenDays.add(day);
      found++;
      const sourceKey = vacationDateSourceKey(scheduleKey, login, year, month, day);
      desired.set(sourceKey, { staff: s, login, day });
    }
  }
  return { desired, found };
}

async function vacationSyncScheduleZMovements(db, scheduleKey, month, year, data, user) {
  const parsed = vacationParseScheduleKey(scheduleKey);
  const syncMonth = Number(month) || parsed.month;
  const syncYear = Number(year) || parsed.year;
  const key = String(scheduleKey || (syncMonth && syncYear ? vacationScheduleKey(syncMonth, syncYear) : '')).trim();
  if (!key || !(syncMonth >= 1 && syncMonth <= 12) || !(syncYear >= 2000 && syncYear <= 2100)) {
    return { ok: false, msg: 'Chybi mesic/rok pro synchronizaci dovolene.', found: 0, inserted: 0, removed: 0, kept: 0 };
  }
  const { desired, found } = vacationCollectScheduleZDays(key, syncMonth, syncYear, data || {});
  const existingRows = await db.query(
    `SELECT source_key FROM vacation_movements
      WHERE movement_type = 'schedule_import'
        AND source_key LIKE $1`,
    [`schedule:${key}:%`]
  );
  const existing = new Set(existingRows.rows.map(r => String(r.source_key || '')));
  const desiredKeys = new Set(desired.keys());
  const toRemove = [...existing].filter(k => !desiredKeys.has(k));
  let removed = 0;
  if (toRemove.length) {
    const del = await db.query(
      `DELETE FROM vacation_movements
        WHERE movement_type = 'schedule_import'
          AND source_key = ANY($1::text[])`,
      [toRemove]
    );
    removed = del.rowCount || 0;
  }
  let inserted = 0;
  let kept = 0;
  for (const [sourceKey, info] of desired.entries()) {
    if (existing.has(sourceKey)) { kept++; continue; }
    const s = info.staff || {};
    if (!vacationHasBalanceContract(s.contract)) { kept++; continue; }
    const balance = await vacationEnsureBalance(db, s, user);
    if (!balance) { kept++; continue; }
    const dayHours = vacationDayHoursByContract(balance?.contract || s.contract) || Number(balance?.day_hours || 0);
    const name = s.displayName || s.name || info.login;
    const ins = await db.query(
      `INSERT INTO vacation_movements
       (staff_user_id, staff_login, staff_name, year, month, day, movement_type, source_key, source_label, days_delta, hours_delta, note, created_by, created_name)
       VALUES ($1,$2,$3,$4,$5,$6,'schedule_import',$7,$8,-1,$9,$10,$11,$12)
       ON CONFLICT (source_key) DO NOTHING RETURNING id`,
      [s.userId || null, info.login, name, syncYear, syncMonth, info.day, sourceKey, `Sync z Rozpis VR ${syncMonth}/${syncYear}`, -dayHours, `z v Rozpis VR ${info.day}.${syncMonth}.${syncYear}`, user?.id || null, user?.name || null]
    );
    if (ins.rows.length) inserted++; else kept++;
  }
  return { ok: true, key, month: syncMonth, year: syncYear, found, inserted, removed, kept };
}

async function vacationTrySyncScheduleZMovements(db, scheduleKey, month, year, data, user) {
  try {
    return await vacationSyncScheduleZMovements(db, scheduleKey, month, year, data, user);
  } catch (err) {
    console.error('Chyba synchronizace dovolene z rozpisu:', err);
    return { ok: false, msg: 'Chyba synchronizace dovolene z rozpisu.' };
  }
}
app.post('/api/vacations/import-schedule', requireLogin, async (req, res) => {
  try {
    if (!await canManageVacationsServer(req.session.user)) return res.status(403).json({ ok: false, msg: 'Nemate opravneni.' });
    const month = parseInt(req.body?.month, 10);
    const year = parseInt(req.body?.year, 10);
    const key = String(req.body?.key || (month && year ? vacationScheduleKey(month, year) : '')).trim();
    if (!key) return res.status(400).json({ ok: false, msg: 'Chybi rozpis.' });
    const db = getPool();
    const { rows } = await db.query('SELECT key, month, year, data FROM rt_schedules WHERE key = $1', [key]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Publikovany rozpis nebyl nalezen.' });
    const entry = rows[0];
    const data = typeof entry.data === 'string' ? JSON.parse(entry.data || '{}') : (entry.data || {});
    const sync = await vacationSyncScheduleZMovements(db, entry.key, Number(entry.month), Number(entry.year), data, req.session.user);
    res.json({ ok: true, ...sync });
  } catch (err) {
    console.error('Chyba POST /api/vacations/import-schedule:', err);
    res.status(500).json({ ok: false, msg: 'Chyba prenosu dovolene z rozpisu.' });
  }
});
// ═════════════════════════════════════════════════════════════════════════════

// ── Drafts ───────────────────────────────────────────────────────────────────

app.post('/api/rt/staff-settings', requireLogin, requirePermDefault('raspis', 'edit', false), async (req, res) => {
  try {
    const userId = parseInt(req.body?.userId, 10);
    if (!userId) return res.status(400).json({ ok: false, msg: 'Chybí userId.' });
    const data = normalizeRtStaffSettings(req.body?.data || {});
    const db = getPool();
    await db.query(
      `INSERT INTO rt_staff_settings (user_id, data, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (user_id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [userId, JSON.stringify(data), req.session.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba /api/rt/staff-settings:', err);
    res.status(500).json({ ok: false, msg: 'Chyba uložení nastavení.' });
  }
});

app.get('/api/rt/request-notes', requireLogin, requirePermDefault('raspis', 'settings_monthly', false), async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) return res.status(400).json({ ok: false, msg: 'Chybi mesic/rok.' });
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, month, year, staff_user_id, staff_login, staff_name, note, status,
              created_name, created_at, resolved_name, resolved_at
         FROM rt_request_notes
        WHERE month = $1 AND year = $2
        ORDER BY LOWER(staff_name), id`,
      [month, year]
    );
    res.json({ ok: true, notes: rows });
  } catch (err) {
    console.error('GET /api/rt/request-notes:', err);
    res.status(500).json({ ok: false, msg: 'Chyba nacteni poznamek.' });
  }
});

app.post('/api/rt/request-notes/:id/resolve', requireLogin, requirePermDefault('raspis', 'settings_monthly', false), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const noteM = String(req.body?.noteM || '').trim();
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM rt_request_notes WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, msg: 'Poznamka nebyla nalezena.' });
    }
    const item = rows[0];
    if (noteM && item.staff_user_id) {
      const settingsRows = await client.query('SELECT data FROM rt_staff_settings WHERE user_id = $1 FOR UPDATE', [item.staff_user_id]);
      const current = settingsRows.rows.length
        ? (typeof settingsRows.rows[0].data === 'string' ? JSON.parse(settingsRows.rows[0].data || '{}') : (settingsRows.rows[0].data || {}))
        : {};
      current.monthlyOverrides = current.monthlyOverrides && typeof current.monthlyOverrides === 'object' ? current.monthlyOverrides : {};
      const key = `${item.year}-${item.month}`;
      current.monthlyOverrides[key] = current.monthlyOverrides[key] && typeof current.monthlyOverrides[key] === 'object'
        ? current.monthlyOverrides[key]
        : {};
      current.monthlyOverrides[key].noteM = noteM;
      const normalized = normalizeRtStaffSettings(current);
      await client.query(
        `INSERT INTO rt_staff_settings (user_id, data, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (user_id) DO UPDATE
         SET data = EXCLUDED.data, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [item.staff_user_id, JSON.stringify(normalized), req.session.user.id]
      );
    }
    await client.query(
      `UPDATE rt_request_notes
          SET status = 'resolved',
              resolved_by = $2,
              resolved_name = $3,
              resolved_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [id, req.session.user.id, req.session.user.name]
    );
    await client.query('COMMIT');
    res.json({ ok: true, noteM, noteId: id });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    console.error('POST /api/rt/request-notes/:id/resolve:', err);
    res.status(500).json({ ok: false, msg: 'Chyba ulozeni poznamky.' });
  } finally {
    client.release();
  }
});

app.delete('/api/rt/request-notes/:id', requireLogin, requirePermDefault('raspis', 'settings_monthly', false), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, msg: 'Chybi id.' });
    const db = getPool();
    const { rowCount } = await db.query('DELETE FROM rt_request_notes WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ ok: false, msg: 'Poznamka nebyla nalezena.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/rt/request-notes/:id:', err);
    res.status(500).json({ ok: false, msg: 'Chyba smazani poznamky.' });
  }
});

app.get('/api/rt/drafts', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    // month = 0 je rezervováno pro special-staff (přežívající záznamy) — nezobrazovat v seznamu konceptů
    const { rows } = await db.query(
      'SELECT id, month, year, saved_at FROM rt_drafts WHERE user_id = $1 AND month > 0 ORDER BY saved_at DESC, id DESC',
      [req.session.user.id]
    );
    res.json(rows.map(r => ({
      id: r.id, month: r.month, year: r.year, saved_at: r.saved_at,
      label: `Koncept ${String(r.month).padStart(2,'0')}/${r.year}`
    })));
  } catch (err) { console.error(err); res.json([]); }
});

app.get('/api/rt/drafts/:id', requireLogin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rt_drafts WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
    if (!rows.length) return res.status(404).json({ ok: false });
    const draft = rows[0];
    let parsed;
    try { parsed = JSON.parse(draft.data); } catch(e) { parsed = draft.data; }
    parsed = await augmentRtDataWithActiveReceptionists(parsed, db);
    parsed = await augmentRtDataWithSpecialStaff(parsed, req.session.user.id, db);
    res.json({ ok: true, data: parsed, month: draft.month, year: draft.year });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

app.post('/api/rt/drafts/save', requireLogin, requirePermDefault('raspis', 'edit', false), async (req, res) => {
  const { month, year, data } = req.body;
  if (!month || !year || !data) return res.json({ ok: false, msg: 'Chybí data.' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO rt_drafts (user_id, month, year, data, saved_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, month, year) DO UPDATE SET data = $4, saved_at = NOW()
       RETURNING id`,
      [req.session.user.id, month, year, JSON.stringify(data)]
    );
    const vacationSync = await vacationTrySyncScheduleZMovements(db, vacationScheduleKey(month, year), month, year, data, req.session.user);
    res.json({ ok: true, id: rows[0].id, vacationSync });
  } catch (err) { console.error(err); res.json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.delete('/api/rt/drafts/:id', requireLogin, requirePermDefault('raspis', 'delete', false), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rt_drafts WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
    if (!rows.length) return res.json({ ok: false, msg: 'Nenalezeno.' });
    const r = rows[0];
    await db.query('INSERT INTO rt_drafts_trash (user_id, original_id, month, year, data) VALUES ($1,$2,$3,$4,$5)',
      [r.user_id, r.id, r.month, r.year, r.data]);
    await db.query('DELETE FROM rt_drafts WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

app.get('/api/rt/drafts/trash/list', requireLogin, requirePermDefault('raspis', 'trash', false), async (req, res) => {
  try {
    const db = getPool();
    const isAdmin = req.session.user.role === 'admin';
    const { rows } = isAdmin
      ? await db.query('SELECT id, user_id, month, year, deleted_at FROM rt_drafts_trash ORDER BY deleted_at DESC')
      : await db.query('SELECT id, user_id, month, year, deleted_at FROM rt_drafts_trash WHERE user_id = $1 ORDER BY deleted_at DESC', [req.session.user.id]);
    res.json(rows.map(r => ({ ...r, label: `Koncept ${String(r.month).padStart(2,'0')}/${r.year}` })));
  } catch (err) { console.error(err); res.json([]); }
});

app.post('/api/rt/drafts/restore/:id', requireLogin, requirePermDefault('raspis', 'trash', false), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rt_drafts_trash WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
    if (!rows.length) return res.json({ ok: false, msg: 'Nenalezeno.' });
    const r = rows[0];
    await db.query(
      `INSERT INTO rt_drafts (user_id, month, year, data, saved_at)
       VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (user_id, month, year) DO UPDATE SET data=$4, saved_at=NOW()`,
      [r.user_id, r.month, r.year, r.data]
    );
    await db.query('DELETE FROM rt_drafts_trash WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

app.delete('/api/rt/drafts/trash/:id', requireLogin, requirePermDefault('raspis', 'trash', false), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const isAdmin = req.session.user.role === 'admin';
    const result = isAdmin
      ? await db.query('DELETE FROM rt_drafts_trash WHERE id = $1', [id])
      : await db.query('DELETE FROM rt_drafts_trash WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
    if (!result.rowCount) return res.json({ ok: false, msg: 'Nenalezeno.' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// ── Special Staff — ne-portáloví pracovníci, per-user, přežívají smazání draftu ─
// Ukládá se do rt_drafts s month=0, year=0 (nikdy se nezobrazí v seznamu konceptů).

app.get('/api/rt/special-staff', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT data FROM rt_drafts WHERE user_id = $1 AND month = 0 AND year = 0',
      [req.session.user.id]
    );
    if (!rows.length) return res.json({ ok: true, staff: [] });
    let parsed;
    try { parsed = JSON.parse(rows[0].data); } catch(e) { parsed = rows[0].data; }
    const staff = Array.isArray(parsed?.staff) ? parsed.staff : [];
    res.json({ ok: true, staff });
  } catch (err) {
    console.error('Chyba GET /api/rt/special-staff:', err);
    res.json({ ok: false, staff: [], msg: 'Chyba serveru.' });
  }
});

app.post('/api/rt/special-staff', requireLogin, async (req, res) => {
  const { staff } = req.body;
  if (!Array.isArray(staff)) return res.json({ ok: false, msg: 'Neplatná data.' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO rt_drafts (user_id, month, year, data, saved_at)
       VALUES ($1, 0, 0, $2, NOW())
       ON CONFLICT (user_id, month, year) DO UPDATE SET data = $2, saved_at = NOW()`,
      [req.session.user.id, JSON.stringify({ staff })]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Chyba POST /api/rt/special-staff:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

// ── Publikované rozpisy ───────────────────────────────────────────────────────

app.get('/api/rt/schedules', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT key, month, year, label, published_at, published_by FROM rt_schedules ORDER BY published_at DESC'
    );
    const current = rows.length > 0 ? rows[0].key : null;
    const history = rows.map(r => ({ key: r.key, label: r.label, month: r.month, year: r.year }));
    res.json({ current, history });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

function buildRtCoverageCounts(data) {
  const schedule = data && data.schedule && typeof data.schedule === 'object' ? data.schedule : {};
  const counts = {};
  for (const [key, raw] of Object.entries(schedule)) {
    const val = String(raw || '').trim().toUpperCase();
    if (!val || val === 'X' || val === 'Y' || val === 'Z' || val === 'Ž') continue;
    const m = String(key).match(/^\d+_(\d+)$/);
    if (!m) continue;
    const ci = m[1];
    const countKey = `${ci}|${val}`;
    counts[countKey] = (counts[countKey] || 0) + 1;
  }
  return counts;
}

app.get('/api/rt/schedules/summary', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT key, month, year, label, published_at, published_by FROM rt_schedules ORDER BY published_at DESC LIMIT 1'
    );
    const row = rows[0] || {};
    const user = req.session.user || {};
    const userLogin = String(user.username || user.login || '').trim().toUpperCase();
    res.json({ ok: true, userLogin, key: row.key || null, label: row.label || '', month: row.month || null, year: row.year || null, latestAt: row.published_at || null, publishedBy: row.published_by || '' });
  } catch (err) { console.error('Chyba GET /api/rt/schedules/summary:', err); res.status(500).json({ ok: false }); }
});

app.get('/api/rt/schedules/:key', requireLogin, async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rt_schedules WHERE key = $1', [key]);
    if (!rows.length) return res.status(404).json({ ok: false });
    const entry = rows[0];
    let parsed;
    try { parsed = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data; } catch(e) { parsed = entry.data; }
    entry.data = await augmentRtDataWithActiveReceptionists(parsed, db);
    entry.data = await augmentRtDataWithSharedSpecialStaff(entry.data, db);
    entry.data.coverageCounts = buildRtCoverageCounts(entry.data);
    res.json({ ok: true, entry });
  } catch (err) { console.error(err); res.status(500).json({ ok: false }); }
});

app.post('/api/rt/schedules/publish', requireLogin, requirePermDefault('raspis', 'publish', false), async (req, res) => {
  let { month, year, data, draftId } = req.body;
  if (!month || !year || !data) return res.json({ ok: false, msg: 'Chybí data.' });
  const key   = `RT:${String(month).padStart(2,'0')}/${year}`;
  const label = `${['','Leden','Únor','Březen','Duben','Květen','Červen','Červenec','Srpen','Září','Říjen','Listopad','Prosinec'][month]} ${year}`;
  try {
    const db = getPool();
    data = await augmentRtDataWithActiveReceptionists(data, db);
    data = await augmentRtDataWithSpecialStaff(data, req.session.user.id, db);
    data = await augmentRtDataWithSharedSpecialStaff(data, db);
    const knownHotelSync = await syncRtKnownHotelsFromSchedule(data, db);
    await db.query(
      `INSERT INTO rt_schedules (key, month, year, label, data, published_at, published_by)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6)
       ON CONFLICT (key) DO UPDATE SET data=$5, published_at=NOW(), published_by=$6`,
      [key, month, year, label, JSON.stringify(data), req.session.user.name]
    );
    const vacationSync = await vacationTrySyncScheduleZMovements(db, key, month, year, data, req.session.user);
    const parsedDraftId = parseInt(draftId, 10);
    if (parsedDraftId) {
      const draftRows = await db.query(
        'SELECT * FROM rt_drafts WHERE id = $1 AND user_id = $2 AND month = $3 AND year = $4',
        [parsedDraftId, req.session.user.id, month, year]
      );
      if (draftRows.rows.length) {
        const draft = draftRows.rows[0];
        await db.query(
          'INSERT INTO rt_drafts_trash (user_id, original_id, month, year, data) VALUES ($1,$2,$3,$4,$5)',
          [draft.user_id, draft.id, draft.month, draft.year, draft.data]
        );
        await db.query('DELETE FROM rt_drafts WHERE id = $1', [parsedDraftId]);
      }
    }
    broadcastWidgetUpdate();
    res.json({ ok: true, key, knownHotelSync, vacationSync });
  } catch (err) { console.error(err); res.json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.delete('/api/rt/schedules/:key', requireLogin, requirePermDefault('raspis', 'delete', false), async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rt_schedules WHERE key = $1', [key]);
    if (!rows.length) return res.json({ ok: false, msg: 'Nenalezeno.' });
    const r = rows[0];
    await db.query(
      `INSERT INTO rt_schedules_trash (key, month, year, label, data, published_at, published_by, deleted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.key, r.month, r.year, r.label, r.data, r.published_at, r.published_by, req.session.user.name]
    );
    await db.query('DELETE FROM rt_schedules WHERE key = $1', [key]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

app.get('/api/rt/schedules/trash/list', requireLogin, requirePermDefault('raspis', 'archive', false), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT id, key, month, year, label, deleted_at FROM rt_schedules_trash ORDER BY deleted_at DESC');
    res.json(rows);
  } catch (err) { console.error(err); res.json([]); }
});

app.post('/api/rt/schedules/restore/:id', requireLogin, requirePermDefault('raspis', 'archive', false), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rt_schedules_trash WHERE id = $1', [id]);
    if (!rows.length) return res.json({ ok: false });
    const r = rows[0];
    await db.query(
      `INSERT INTO rt_schedules (key, month, year, label, data, published_at, published_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key) DO UPDATE SET data=$5, published_at=$6, published_by=$7`,
      [r.key, r.month, r.year, r.label, r.data, r.published_at, r.published_by]
    );
    await db.query('DELETE FROM rt_schedules_trash WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

app.delete('/api/rt/schedules/perma/:id', requireLogin, requirePermDefault('raspis', 'archive', false), async (req, res) => {
  try {
    const db = getPool();
    await db.query('DELETE FROM rt_schedules_trash WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// ── Uložit editace publikovaného (Rozpis VR tab) ──────────────────────────────

app.post('/api/rt/schedules/save-edits', requireLogin, requirePerm('raspis', 'edit'), async (req, res) => {
  let { key, data } = req.body;
  if (!key || !data) return res.json({ ok: false, msg: 'Chybí data.' });
  try {
    const db = getPool();
    data = await augmentRtDataWithActiveReceptionists(data, db);
    data = await augmentRtDataWithSpecialStaff(data, req.session.user.id, db);
    const knownHotelSync = await syncRtKnownHotelsFromSchedule(data, db);
    await db.query('UPDATE rt_schedules SET data = $1 WHERE key = $2', [JSON.stringify(data), key]);
    const parsedVacationKey = vacationParseScheduleKey(key);
    const vacationSync = await vacationTrySyncScheduleZMovements(db, key, data.month || parsedVacationKey.month, data.year || parsedVacationKey.year, data, req.session.user);
    broadcastWidgetUpdate();
    res.json({ ok: true, knownHotelSync, vacationSync });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// ── Change log ────────────────────────────────────────────────────────────────

function rtMonthKey(month, year) {
  return `RT:${String(month).padStart(2, '0')}/${year}`;
}

function reqLabel(month, year) {
  const names = ['', 'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen', 'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
  return `${names[month] || String(month).padStart(2, '0')} ${year}`;
}

function previousMonth(month, year) {
  return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
}

function rtStaffMonthValue(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{1,2})/);
    if (m) return { year: +m[1], month: +m[2] };
  }
  if (Number.isFinite(+value.year) && Number.isFinite(+value.month)) {
    return { year: +value.year, month: +value.month };
  }
  return null;
}

function rtMonthIndex(month, year) {
  return (+year * 12) + +month;
}

function rtNormalizeStaffName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function rtIsReceptionistType(type) {
  const key = rtNormalizeStaffName(type);
  return key === 'denni' || key === 'nocni' || key === 'oboji';
}

function rtIsStaffActiveForMonth(staff, month, year) {
  if (!staff || staff.inactive) return false;
  const current = rtMonthIndex(month, year);
  const from = rtStaffMonthValue(staff.activeFrom);
  const until = rtStaffMonthValue(staff.activeUntil);
  if (from && rtMonthIndex(from.month, from.year) > current) return false;
  if (until && rtMonthIndex(until.month, until.year) < current) return false;
  return true;
}

function rtReqLimit(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const RT_STAFF_SETTINGS_FIELDS = [
  'maxHrs', 'noteM', 'noteP', 'x', 'xa', 'dates', 'regular', 'hotel',
  'monthlyOverrides'
];

function normalizeRtStaffSettings(input = {}) {
  const data = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const field of RT_STAFF_SETTINGS_FIELDS) {
    if (field === 'monthlyOverrides') {
      out.monthlyOverrides = data.monthlyOverrides && typeof data.monthlyOverrides === 'object'
        ? data.monthlyOverrides
        : {};
    } else {
      out[field] = data[field] == null ? '' : String(data[field]);
    }
  }
  return out;
}

async function loadRtStaffSettingsMap(db) {
  const { rows } = await db.query('SELECT user_id, data FROM rt_staff_settings');
  const map = new Map();
  for (const row of rows) {
    const raw = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {});
    map.set(String(row.user_id), normalizeRtStaffSettings(raw));
  }
  return map;
}

function applyRtStaffSettings(target, settings) {
  if (!target || !settings) return target;
  target.maxHrs = settings.maxHrs || '';
  target.noteM = settings.noteM || '';
  target.noteP = settings.noteP || '';
  target.x = settings.x || '';
  target.xa = settings.xa || '';
  target.dates = settings.dates || '';
  target.regular = settings.regular || '';
  target.hotel = settings.hotel || '';
  target.monthlyOverrides = settings.monthlyOverrides && typeof settings.monthlyOverrides === 'object'
    ? JSON.parse(JSON.stringify(settings.monthlyOverrides))
    : {};
  return target;
}

function rtRequestNoteKey(staff, index = null) {
  const login = String(staff?.login || staff?.username || '').trim().toUpperCase();
  if (login) return login;
  if (staff?.userId) return `U${staff.userId}`;
  const name = rtNormalizeStaffName(staff?.name || staff?.displayName || '');
  return name || (index !== null ? `ROW${index}` : '');
}

function rtCollectRequestNotes(data = {}) {
  const notes = data.reqNotes && typeof data.reqNotes === 'object' ? data.reqNotes : {};
  const staff = Array.isArray(data.staff) ? data.staff : [];
  const out = [];
  for (const [rawKey, rawNote] of Object.entries(notes)) {
    const entry = rawNote && typeof rawNote === 'object' ? rawNote : { note: rawNote };
    const note = String(entry.note || '').trim();
    if (!note) continue;
    const staffIndex = Number.isFinite(Number(entry.staffIndex)) ? Number(entry.staffIndex) : -1;
    const staffRow = staffIndex >= 0 ? staff[staffIndex] : null;
    const staffLogin = String(entry.staffLogin || staffRow?.login || rawKey || '').trim().toUpperCase();
    if (!staffLogin) continue;
    out.push({
      staffUserId: Number.isFinite(Number(entry.staffUserId || staffRow?.userId)) ? Number(entry.staffUserId || staffRow?.userId) : null,
      staffLogin,
      staffName: String(entry.staffName || staffRow?.name || staffRow?.displayName || staffLogin).trim(),
      note
    });
  }
  return out;
}

async function saveRequestNotesForTvorba(db, data, month, year, user) {
  const notes = rtCollectRequestNotes(data);
  for (const item of notes) {
    await db.query(
      `INSERT INTO rt_request_notes
         (month, year, staff_user_id, staff_login, staff_name, note, status, created_by, created_name, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,NOW())
       ON CONFLICT (month, year, staff_login) DO UPDATE
          SET staff_user_id = COALESCE(EXCLUDED.staff_user_id, rt_request_notes.staff_user_id),
              staff_name = EXCLUDED.staff_name,
              note = EXCLUDED.note,
              status = 'pending',
              updated_at = NOW(),
              resolved_by = NULL,
              resolved_name = NULL,
              resolved_at = NULL`,
      [month, year, item.staffUserId, item.staffLogin, item.staffName, item.note, user.id, user.name]
    );
  }
  return notes.length;
}

async function loadRtPortalReceptionists(db) {
  const settingsMap = await loadRtStaffSettingsMap(db);
  const { rows } = await db.query(
    'SELECT id, name, username, phone, perm_overrides FROM users WHERE perm_overrides IS NOT NULL'
  );
  const out = [];
  for (const u of rows) {
    let overrides = null;
    try {
      overrides = typeof u.perm_overrides === 'string'
        ? JSON.parse(u.perm_overrides)
        : u.perm_overrides;
    } catch (e) { continue; }
    const rs = overrides?.raspis_staff;
    if (!rs || !rs.active || !rtIsReceptionistType(rs.type)) continue;
    const entry = {
      userId: u.id,
      name: rs.displayName || u.name || '',
      phone: u.phone || '',
      login: rs.login || u.username || '',
      type: rs.type || '',
      contract: rs.contract || '',
      hotelSkills: Array.isArray(rs.hotels) ? rs.hotels : [],
      noStandby: !!rs.noStandby,
      reqXLimit: rtReqLimit(rs.reqXLimit, 7),
      reqYLimit: rtReqLimit(rs.reqYLimit, 0),
      activeFrom: rtStaffMonthValue(rs.activeFrom) || rs.activeFrom || null,
      activeUntil: rtStaffMonthValue(rs.activeUntil) || rs.activeUntil || null,
      inactive: false
    };
    const storedSettings = settingsMap.get(String(u.id));
    if (storedSettings) {
      applyRtStaffSettings(entry, storedSettings);
      entry.rtStaffSettingsStored = true;
    }
    out.push(entry);
  }
  return out;
}

function rtAutoKnownHotelLetters(data) {
  const blocked = new Set(['', 'P', 'Q', 'X', 'Y', 'Z', 'Ž']);
  const out = new Set();
  const hotels = Array.isArray(data?.hotels) ? data.hotels : [];
  for (const h of hotels) {
    const letter = String(h?.letter || '').trim().toUpperCase();
    if (!letter || blocked.has(letter) || h?.active === false) continue;
    out.add(letter);
  }
  return out;
}

function rtScheduleHotelAssignmentsByStaff(data) {
  const staff = Array.isArray(data?.staff) ? data.staff : [];
  const cells = data?.cells && typeof data.cells === 'object'
    ? data.cells
    : (data?.schedule && typeof data.schedule === 'object' ? data.schedule : {});
  const allowedHotels = rtAutoKnownHotelLetters(data);
  const out = new Map();
  if (!allowedHotels.size || !staff.length) return out;

  for (const [key, rawValue] of Object.entries(cells)) {
    const parts = String(key).split('_');
    const staffIndex = parseInt(parts[0], 10);
    if (!Number.isInteger(staffIndex) || !staff[staffIndex]) continue;
    const letter = String(rawValue || '').trim().toUpperCase();
    if (!allowedHotels.has(letter)) continue;
    if (!out.has(staffIndex)) out.set(staffIndex, new Set());
    out.get(staffIndex).add(letter);
  }
  return out;
}

async function syncRtKnownHotelsFromSchedule(data, db) {
  const staff = Array.isArray(data?.staff) ? data.staff : [];
  const assignments = rtScheduleHotelAssignmentsByStaff(data);
  if (!assignments.size) return { updatedUsers: 0, addedHotels: 0 };

  const { rows } = await db.query(
    'SELECT id, name, username, perm_overrides FROM users WHERE perm_overrides IS NOT NULL'
  );
  const byId = new Map();
  const byLogin = new Map();
  const byName = new Map();

  for (const u of rows) {
    let overrides = null;
    try {
      overrides = typeof u.perm_overrides === 'string'
        ? JSON.parse(u.perm_overrides)
        : u.perm_overrides;
    } catch (e) { continue; }
    const rs = overrides?.raspis_staff;
    if (!rs || !rs.active || !rtIsReceptionistType(rs.type)) continue;
    const rec = { user: u, overrides, rs };
    byId.set(String(u.id), rec);
    const login = String(rs.login || u.username || '').trim().toUpperCase();
    if (login) byLogin.set(login, rec);
    const nameKey = rtNormalizeStaffName(rs.displayName || u.name || '');
    if (nameKey) byName.set(nameKey, rec);
  }

  const additionsByUser = new Map();
  for (const [staffIndex, letters] of assignments.entries()) {
    const s = staff[staffIndex] || {};
    let rec = null;
    if (s.userId && byId.has(String(s.userId))) rec = byId.get(String(s.userId));
    if (!rec) {
      const login = String(s.login || '').trim().toUpperCase();
      if (login && byLogin.has(login)) rec = byLogin.get(login);
    }
    if (!rec) {
      const nameKey = rtNormalizeStaffName(s.name || '');
      if (nameKey && byName.has(nameKey)) rec = byName.get(nameKey);
    }
    if (!rec) continue;
    const userId = String(rec.user.id);
    if (!additionsByUser.has(userId)) additionsByUser.set(userId, { rec, letters: new Set() });
    const target = additionsByUser.get(userId).letters;
    for (const letter of letters) target.add(letter);
  }

  let updatedUsers = 0;
  let addedHotels = 0;
  for (const { rec, letters } of additionsByUser.values()) {
    const existing = Array.isArray(rec.rs.hotels)
      ? rec.rs.hotels
      : (Array.isArray(rec.rs.hotelSkills) ? rec.rs.hotelSkills : []);
    const merged = new Set(existing.map(h => String(h || '').trim().toUpperCase()).filter(Boolean));
    let changed = false;
    for (const letter of letters) {
      if (!merged.has(letter)) {
        merged.add(letter);
        changed = true;
        addedHotels += 1;
      }
    }
    if (!changed) continue;
    rec.overrides.raspis_staff = rec.overrides.raspis_staff || {};
    rec.overrides.raspis_staff.hotels = Array.from(merged).sort((a, b) => a.localeCompare(b, 'cs'));
    await db.query('UPDATE users SET perm_overrides = $1 WHERE id = $2', [
      JSON.stringify(rec.overrides),
      rec.user.id
    ]);
    updatedUsers += 1;
  }

  return { updatedUsers, addedHotels };
}

async function loadRtSpecialStaffForUser(db, userId) {
  const { rows } = await db.query(
    'SELECT data FROM rt_drafts WHERE user_id = $1 AND month = 0 AND year = 0',
    [userId]
  );
  if (!rows.length) return [];
  let parsed;
  try { parsed = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data; } catch(e) { parsed = null; }
  const staff = Array.isArray(parsed?.staff) ? parsed.staff : [];
  return staff.map(s => ({
    name: s.name || '',
    login: s.login || '',
    type: s.type || '',
    contract: s.contract || '',
    maxHrs: s.maxHrs || '',
    regular: s.regular || '',
    dates: s.dates || '',
    noteM: s.noteM || '',
    noteP: s.noteP || '',
    hotelSkills: Array.isArray(s.hotelSkills) ? s.hotelSkills : (Array.isArray(s.hotels) ? s.hotels : []),
    noStandby: !!s.noStandby,
    reqXLimit: rtReqLimit(s.reqXLimit, 7),
    reqYLimit: rtReqLimit(s.reqYLimit, 0),
    monthlyOverrides: s.monthlyOverrides || undefined,
    activeFrom: rtStaffMonthValue(s.activeFrom) || s.activeFrom || null,
    activeUntil: rtStaffMonthValue(s.activeUntil) || s.activeUntil || null,
    inactive: !!s.inactive
  })).filter(s => s.name);
}

function normalizeRtSpecialStaffList(parsed) {
  const staff = Array.isArray(parsed?.staff) ? parsed.staff : [];
  return staff.map(s => ({
    name: s.name || '',
    login: s.login || '',
    type: s.type || '',
    contract: s.contract || '',
    maxHrs: s.maxHrs || '',
    regular: s.regular || '',
    dates: s.dates || '',
    noteM: s.noteM || '',
    noteP: s.noteP || '',
    hotelSkills: Array.isArray(s.hotelSkills) ? s.hotelSkills : (Array.isArray(s.hotels) ? s.hotels : []),
    noStandby: !!s.noStandby,
    reqXLimit: rtReqLimit(s.reqXLimit, 7),
    reqYLimit: rtReqLimit(s.reqYLimit, 0),
    monthlyOverrides: s.monthlyOverrides || undefined,
    activeFrom: rtStaffMonthValue(s.activeFrom) || s.activeFrom || null,
    activeUntil: rtStaffMonthValue(s.activeUntil) || s.activeUntil || null,
    inactive: !!s.inactive
  })).filter(s => s.name);
}

async function loadRtAllSpecialStaff(db, month = null, year = null) {
  const { rows } = await db.query(
    'SELECT data FROM rt_drafts WHERE month = 0 AND year = 0 ORDER BY saved_at DESC NULLS LAST, id DESC'
  );
  const byName = new Map();
  for (const row of rows) {
    let parsed;
    try { parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch(e) { parsed = null; }
    for (const s of normalizeRtSpecialStaffList(parsed)) {
      if (month && year && !rtIsStaffActiveForMonth(s, month, year)) continue;
      const key = rtNormalizeStaffName(s.name);
      if (key && !byName.has(key)) byName.set(key, s);
    }
  }
  return Array.from(byName.values());
}

function rtIsLeadStaffRow(s) {
  const type = rtNormalizeStaffName(s && s.type);
  const name = rtNormalizeStaffName(s && s.name);
  return type === 'vedouci' || name.startsWith('z ');
}

function copyRtStaffIndexedValues(sourceObj, oldIdx, targetObj, newIdx) {
  if (!sourceObj || typeof sourceObj !== 'object') return;
  Object.entries(sourceObj).forEach(([key, val]) => {
    const parts = String(key).split('_');
    if (parts.length !== 2 || Number(parts[0]) !== oldIdx) return;
    targetObj[`${newIdx}_${parts[1]}`] = val;
  });
}

function copyRtStaffIndexedSingleValues(sourceObj, oldIdx, targetObj, newIdx) {
  if (!sourceObj || typeof sourceObj !== 'object') return;
  const val = sourceObj[String(oldIdx)];
  if (val !== undefined) targetObj[String(newIdx)] = val;
}

async function restoreRtLeadRowsFromMonthData(data, db, month, year) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.staff)) return false;
  const byName = new Set(data.staff.map(s => rtNormalizeStaffName(s && s.name)).filter(Boolean));
  const { rows } = await db.query(
    `SELECT data, COALESCE(saved_at, published_at) AS ts
       FROM (
         SELECT data, NULL::timestamptz AS saved_at, published_at FROM rt_schedules WHERE month = $1 AND year = $2
         UNION ALL
         SELECT data, saved_at, NULL::timestamptz AS published_at FROM rt_drafts WHERE month = $1 AND year = $2
       ) src
      ORDER BY ts DESC NULLS LAST`,
    [month, year]
  );
  let changed = false;
  data.schedule = data.schedule || {};
  data.extras = data.extras || {};
  data.requirements = data.requirements || {};
  data.reqMeta = data.reqMeta || {};
  data.hrsColorOverride = data.hrsColorOverride || {};
  for (const row of rows) {
    let parsed;
    try { parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch(e) { parsed = null; }
    const sourceStaff = Array.isArray(parsed && parsed.staff) ? parsed.staff : [];
    sourceStaff.forEach((s, oldIdx) => {
      if (!rtIsLeadStaffRow(s) || !rtIsStaffActiveForMonth(s, month, year)) return;
      const nameKey = rtNormalizeStaffName(s.name);
      if (!nameKey) return;
      let targetIdx = data.staff.findIndex(row => rtNormalizeStaffName(row && row.name) === nameKey);
      if (targetIdx < 0) {
        targetIdx = data.staff.length;
        data.staff.push(JSON.parse(JSON.stringify(s)));
        byName.add(nameKey);
      }
      copyRtStaffIndexedValues(parsed.schedule, oldIdx, data.schedule, targetIdx);
      copyRtStaffIndexedValues(parsed.requirements, oldIdx, data.requirements, targetIdx);
      copyRtStaffIndexedValues(parsed.reqMeta, oldIdx, data.reqMeta, targetIdx);
      copyRtStaffIndexedSingleValues(parsed.extras, oldIdx, data.extras, targetIdx);
      copyRtStaffIndexedSingleValues(parsed.hrsColorOverride, oldIdx, data.hrsColorOverride, targetIdx);
      changed = true;
    });
  }
  if (changed) data.staffOrder = data.staff.map(s => s.userId || null);
  return changed;
}

function ensureRtLeadRowsWithAutoQ(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.staff)) return false;
  let changed = false;
  for (const name of RT_AUTO_Q_ORDER) {
    if (rtFindStaffIndexByAnyName(data.staff, [name]) >= 0) continue;
    data.staff.push({
      name,
      login: '',
      type: 'Vedoucí',
      contract: '',
      maxHrs: '',
      regular: '',
      dates: '',
      noteM: '',
      noteP: '',
      hotelSkills: [],
      noStandby: false,
      reqXLimit: 7,
      reqYLimit: 0,
      monthlyOverrides: {},
      activeFrom: null,
      activeUntil: null,
      inactive: false
    });
    changed = true;
  }
  const filled = rtAutoFillQ(data, null, true);
  if (changed || filled) data.staffOrder = data.staff.map(s => s.userId || null);
  return changed || !!filled;
}

function rtRemapStaffIndexedMap(obj, oldToNew, cellKeys = true) {
  const out = {};
  Object.entries(obj || {}).forEach(([key, val]) => {
    if (cellKeys) {
      const parts = key.split('_');
      const oldSi = +parts[0];
      const ci = parts[1];
      const newSi = oldToNew[oldSi];
      if (newSi !== undefined && ci !== undefined) out[`${newSi}_${ci}`] = val;
    } else {
      const newSi = oldToNew[+key];
      if (newSi !== undefined) out[String(newSi)] = val;
    }
  });
  return out;
}

function rtRemapDataStaffIndexes(data, oldToNew) {
  data.schedule = rtRemapStaffIndexedMap(data.schedule, oldToNew, true);
  data.extras = rtRemapStaffIndexedMap(data.extras, oldToNew, false);
  data.requirements = rtRemapStaffIndexedMap(data.requirements, oldToNew, true);
  data.reqMeta = rtRemapStaffIndexedMap(data.reqMeta, oldToNew, true);
  data.hrsColorOverride = rtRemapStaffIndexedMap(data.hrsColorOverride, oldToNew, false);
  Object.values(data.monthlyData || {}).forEach(md => {
    if (!md || typeof md !== 'object') return;
    md.schedule = rtRemapStaffIndexedMap(md.schedule, oldToNew, true);
    md.extras = rtRemapStaffIndexedMap(md.extras, oldToNew, false);
    md.requirements = rtRemapStaffIndexedMap(md.requirements, oldToNew, true);
    md.reqMeta = rtRemapStaffIndexedMap(md.reqMeta, oldToNew, true);
  });
}

function rtStaffIdentityKey(s) {
  if (!s) return '';
  if (s.userId) return `u:${String(s.userId)}`;
  const login = String(s.login || s.username || s.userLogin || s.code || s.short || '').trim().toLowerCase();
  if (login) return `l:${login}`;
  const name = rtNormalizeStaffName(s.name);
  return name ? `n:${name}` : '';
}

function rtMergeStaffRows(primary, duplicate) {
  const merged = { ...(primary || {}) };
  Object.entries(duplicate || {}).forEach(([key, val]) => {
    if (val === undefined || val === null || val === '') return;
    if (Array.isArray(val)) {
      if (!Array.isArray(merged[key]) || !merged[key].length) merged[key] = val;
      return;
    }
    if (typeof val === 'object') {
      if (!merged[key] || typeof merged[key] !== 'object' || !Object.keys(merged[key]).length) {
        merged[key] = JSON.parse(JSON.stringify(val));
      }
      return;
    }
    if (merged[key] === undefined || merged[key] === null || merged[key] === '') merged[key] = val;
  });
  return merged;
}

function rtDedupeStaffRows(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.staff)) return false;
  const oldToNew = {};
  const byKey = new Map();
  const nextStaff = [];
  let changed = false;
  data.staff.forEach((s, oldIdx) => {
    const key = rtStaffIdentityKey(s) || `row:${oldIdx}`;
    if (byKey.has(key)) {
      const newIdx = byKey.get(key);
      nextStaff[newIdx] = rtMergeStaffRows(nextStaff[newIdx], s);
      oldToNew[oldIdx] = newIdx;
      changed = true;
      return;
    }
    const newIdx = nextStaff.length;
    byKey.set(key, newIdx);
    oldToNew[oldIdx] = newIdx;
    nextStaff.push(s);
  });
  if (!changed) return false;
  data.staff = nextStaff;
  data.staffOrder = data.staff.map(s => s.userId || null);
  rtRemapDataStaffIndexes(data, oldToNew);
  return true;
}

async function augmentRtDataWithActiveReceptionists(data, db = getPool()) {
  if (!data || typeof data !== 'object') return data;
  const month = parseInt(data.month, 10);
  const year = parseInt(data.year, 10);
  if (!month || !year || !Array.isArray(data.staff) || !data.staff.length) return data;

  const active = (await loadRtPortalReceptionists(db))
    .filter(s => rtIsStaffActiveForMonth(s, month, year));
  if (!active.length) return data;
  data.portalCustomData = data.portalCustomData && typeof data.portalCustomData === 'object'
    ? data.portalCustomData
    : {};

  let changed = rtDedupeStaffRows(data);
  let added = false;
  for (const s of active) {
    if (s.userId) {
      data.portalCustomData[s.userId] = normalizeRtStaffSettings({
        ...(data.portalCustomData[s.userId] || {}),
        maxHrs: s.maxHrs,
        noteM: s.noteM,
        noteP: s.noteP,
        x: s.x,
        xa: s.xa,
        dates: s.dates,
        regular: s.regular,
        hotel: s.hotel,
        monthlyOverrides: s.monthlyOverrides
      });
    }
    const idKey = s.userId ? String(s.userId) : '';
    const nameKey = rtNormalizeStaffName(s.name);
    const existingIdx = data.staff.findIndex(row => {
      if (!row) return false;
      if (idKey && row.userId && String(row.userId) === idKey) return true;
      return nameKey && rtNormalizeStaffName(row.name) === nameKey;
    });
    if (existingIdx >= 0) {
      const current = data.staff[existingIdx] || {};
      const refreshed = {
        ...current,
        userId: s.userId || current.userId || null,
        name: s.name || current.name || '',
        login: s.login || current.login || '',
        type: s.type || current.type || '',
        contract: s.contract || current.contract || '',
        maxHrs: s.maxHrs || '',
        noteM: s.noteM || '',
        noteP: s.noteP || '',
        x: s.x || '',
        xa: s.xa || '',
        dates: s.dates || '',
        regular: s.regular || '',
        hotel: s.hotel || '',
        hotelSkills: Array.isArray(s.hotelSkills) ? s.hotelSkills : (Array.isArray(current.hotelSkills) ? current.hotelSkills : []),
        noStandby: !!s.noStandby,
        reqXLimit: rtReqLimit(s.reqXLimit, rtReqLimit(current.reqXLimit, 7)),
        reqYLimit: rtReqLimit(s.reqYLimit, rtReqLimit(current.reqYLimit, 0)),
        monthlyOverrides: s.monthlyOverrides && typeof s.monthlyOverrides === 'object'
          ? JSON.parse(JSON.stringify(s.monthlyOverrides))
          : {},
        activeFrom: s.activeFrom || current.activeFrom || null,
        activeUntil: s.activeUntil || current.activeUntil || null,
        inactive: false
      };
      if (JSON.stringify(current) !== JSON.stringify(refreshed)) {
        data.staff[existingIdx] = refreshed;
        changed = true;
      }
      continue;
    }
    data.staff.push(JSON.parse(JSON.stringify(s)));
    added = true;
    changed = true;
  }
  if (!changed) return data;
  if (!added) return data;

  const indexed = data.staff.map((s, oldIdx) => ({ s, oldIdx }));
  indexed.sort((a, b) => String(a.s.name || '').localeCompare(String(b.s.name || ''), 'cs', { sensitivity: 'base' }));
  const oldToNew = {};
  indexed.forEach((item, newIdx) => { oldToNew[item.oldIdx] = newIdx; });
  data.staff = indexed.map(item => item.s);
  data.staffOrder = data.staff.map(s => s.userId || null);
  rtRemapDataStaffIndexes(data, oldToNew);
  return data;
}

async function augmentRtDataWithSpecialStaff(data, userId, db = getPool()) {
  if (!data || typeof data !== 'object' || !userId) return data;
  const month = parseInt(data.month, 10);
  const year = parseInt(data.year, 10);
  if (!month || !year || !Array.isArray(data.staff) || !data.staff.length) return data;

  const special = (await loadRtSpecialStaffForUser(db, userId))
    .filter(s => rtIsStaffActiveForMonth(s, month, year));
  if (!special.length) return data;

  let added = false;
  const byName = new Set(data.staff.map(s => rtNormalizeStaffName(s && s.name)).filter(Boolean));
  for (const s of special) {
    const nameKey = rtNormalizeStaffName(s.name);
    if (!nameKey || byName.has(nameKey)) continue;
    data.staff.push(JSON.parse(JSON.stringify(s)));
    byName.add(nameKey);
    added = true;
  }
  if (!added) return data;

  const indexed = data.staff.map((s, oldIdx) => ({ s, oldIdx }));
  indexed.sort((a, b) => String(a.s.name || '').localeCompare(String(b.s.name || ''), 'cs', { sensitivity: 'base' }));
  const oldToNew = {};
  indexed.forEach((item, newIdx) => { oldToNew[item.oldIdx] = newIdx; });
  data.staff = indexed.map(item => item.s);
  data.staffOrder = data.staff.map(s => s.userId || null);
  rtRemapDataStaffIndexes(data, oldToNew);
  return data;
}

async function augmentRtDataWithSharedSpecialStaff(data, db = getPool()) {
  if (!data || typeof data !== 'object') return data;
  const month = parseInt(data.month, 10);
  const year = parseInt(data.year, 10);
  if (!month || !year || !Array.isArray(data.staff) || !data.staff.length) return data;

  const special = (await loadRtAllSpecialStaff(db, month, year))
    .filter(s => rtIsStaffActiveForMonth(s, month, year));
  if (!special.length) {
    await restoreRtLeadRowsFromMonthData(data, db, month, year);
    ensureRtLeadRowsWithAutoQ(data);
    return data;
  }

  let added = false;
  const byName = new Set(data.staff.map(s => rtNormalizeStaffName(s && s.name)).filter(Boolean));
  for (const s of special) {
    const nameKey = rtNormalizeStaffName(s.name);
    if (!nameKey || byName.has(nameKey)) continue;
    data.staff.push(JSON.parse(JSON.stringify(s)));
    byName.add(nameKey);
    added = true;
  }
  if (!added) {
    await restoreRtLeadRowsFromMonthData(data, db, month, year);
    ensureRtLeadRowsWithAutoQ(data);
    return data;
  }

  const indexed = data.staff.map((s, oldIdx) => ({ s, oldIdx }));
  indexed.sort((a, b) => String(a.s.name || '').localeCompare(String(b.s.name || ''), 'cs', { sensitivity: 'base' }));
  const oldToNew = {};
  indexed.forEach((item, newIdx) => { oldToNew[item.oldIdx] = newIdx; });
  data.staff = indexed.map(item => item.s);
  data.staffOrder = data.staff.map(s => s.userId || null);
  rtRemapDataStaffIndexes(data, oldToNew);
  await restoreRtLeadRowsFromMonthData(data, db, month, year);
  ensureRtLeadRowsWithAutoQ(data);
  return data;
}

function buildInitialRequirementsData(sourceData, month, year, reqSettings = {}) {
  const clone = sourceData && typeof sourceData === 'object'
    ? JSON.parse(JSON.stringify(sourceData))
    : {};
  const key = `${year}-${month}`;
  clone.month = month;
  clone.year = year;
  clone.fondHpp = reqSettings.fondHpp || '';
  clone.fondZpp = reqSettings.fondZpp || '';
  clone.holidays = reqSettings.holidays || '';
  clone.reqXyLocks = reqSettings.xyLocks || {};
  clone.reqMeta = {};
  clone.reqNotes = {};
  clone.schedule = {};
  clone.extras = {};
  clone.requirements = {};
  clone.monthlyData = clone.monthlyData && typeof clone.monthlyData === 'object' ? clone.monthlyData : {};
  clone.monthlyData[key] = {
    schedule: {},
    extras: {},
    requirements: {},
    fondHpp: clone.fondHpp,
    fondZpp: clone.fondZpp,
    holidays: clone.holidays,
    reqXyLocks: clone.reqXyLocks,
    reqMeta: clone.reqMeta,
    reqNotes: {}
  };
  clone.unmatchedXls = [];
  return clone;
}

function normReqStaffKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isSessionUserRequirementStaff(staff, user) {
  if (!staff || !user) return false;
  const userKey = normReqStaffKey(user.username || user.login || user.name || user.fullName);
  const userName = normReqStaffKey(user.name || user.fullName);
  if (staff.userId && user.id && String(staff.userId) === String(user.id)) return true;
  return normReqStaffKey(staff.login) === userKey ||
    normReqStaffKey(staff.username) === userKey ||
    normReqStaffKey(staff.userLogin) === userKey ||
    normReqStaffKey(staff.code) === userKey ||
    normReqStaffKey(staff.short) === userKey ||
    normReqStaffKey(staff.name) === userKey ||
    (!!userName && normReqStaffKey(staff.name) === userName);
}

function getRequirementStaffLoginKeys(staff) {
  return new Set([
    staff && staff.login,
    staff && staff.username,
    staff && staff.userLogin,
    staff && staff.code,
    staff && staff.short
  ].map(normReqStaffKey).filter(Boolean));
}

function requirementStaffMatchesProxyLogin(staff, allowedLogins) {
  if (!staff || !allowedLogins || !allowedLogins.size) return false;
  for (const key of getRequirementStaffLoginKeys(staff)) {
    if (allowedLogins.has(key)) return true;
  }
  return false;
}

async function getRequirementProxyAllowedLoginSet(user, client = null) {
  if (!user || !user.id) return new Set();
  const db = client || getPool();
  const { rows } = await db.query('SELECT perm_overrides FROM users WHERE id = $1', [user.id]);
  const overrides = parsePermOverridesValue(rows[0]?.perm_overrides);
  const raw = overrides?.requirements_proxy?.allowedStaffLogins;
  return new Set((Array.isArray(raw) ? raw : []).map(normReqStaffKey).filter(Boolean));
}

function getAllowedRequirementStaffIndexes(data, user, allowedLogins = new Set()) {
  const staff = Array.isArray(data && data.staff) ? data.staff : [];
  return staff
    .map((s, si) => ({ s, si }))
    .filter(({ s }) => isSessionUserRequirementStaff(s, user) || requirementStaffMatchesProxyLogin(s, allowedLogins))
    .map(({ si }) => si);
}

function getReqCalCols(month, year) {
  const days = new Date(year, month, 0).getDate();
  const cols = [];
  for (let day = 1; day <= days; day++) {
    cols.push({ day, dn: 'd' });
    cols.push({ day, dn: 'n' });
  }
  return cols;
}

const RT_AUTO_Q_ORDER = ['z Dvořák Karel', 'z Pětivlas Matěj', 'z Schubert Adam'];
const RT_AUTO_D_DAY = ['Hoppeová Klára', 'Pavelka Filip'];
const RT_AUTO_D_NIGHT = ['Burda Tomáš', 'Nechvátal Jaroslav'];
const RT_AUTO_BLOCK_LONG = new Set([1, 2, 5, 6, 0]);
const RT_AUTO_SKIP_VALUES = new Set(['X', 'Y', 'Z', 'Ž']);

function rtCellIndexForDayShift(day, dn) {
  return ((Math.max(1, parseInt(day, 10)) - 1) * 2) + (dn === 'n' ? 1 : 0);
}

function rtDateForMonthDay(month, year, day) {
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function rtStartOfWeekMonday(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  const dow = d.getDay();
  const diff = (dow + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

function rtWeekDiff(fromDate, toDate) {
  const a = rtStartOfWeekMonday(fromDate).getTime();
  const b = rtStartOfWeekMonday(toDate).getTime();
  return Math.round((b - a) / (7 * 24 * 60 * 60 * 1000));
}

function rtFindStaffIndexByName(staff, name) {
  const wanted = rtNormalizeStaffName(name);
  return (Array.isArray(staff) ? staff : []).findIndex(s => rtNormalizeStaffName(s && s.name) === wanted);
}

function rtFindStaffIndexByAnyName(staff, names) {
  const list = Array.isArray(staff) ? staff : [];
  for (const name of names) {
    const idx = rtFindStaffIndexByName(list, name);
    if (idx >= 0) return idx;
  }
  const wanted = names.map(rtNormalizeStaffName).filter(Boolean);
  return list.findIndex(s => {
    const key = rtNormalizeStaffName(s && s.name);
    return key && wanted.some(w => key === w || key.includes(w) || w.includes(key));
  });
}

function rtFindSpecialRowIndex(staff, typeOrName) {
  const wanted = rtNormalizeStaffName(typeOrName);
  const list = Array.isArray(staff) ? staff : [];
  return list.findIndex(s => {
    const name = rtNormalizeStaffName(s && s.name);
    const type = rtNormalizeStaffName(s && s.type);
    return (name && name.includes(wanted)) || (type && type.includes(wanted));
  });
}

function rtScheduleValue(data, si, ci) {
  return String((data && data.schedule && data.schedule[`${si}_${ci}`]) || '').trim();
}

function rtCanAutoFillCell(data, si, ci) {
  const val = rtScheduleValue(data, si, ci);
  if (!val) return true;
  return false;
}

function rtFillIfEmpty(data, si, ci, value) {
  if (si < 0 || ci < 0) return false;
  data.schedule = data.schedule && typeof data.schedule === 'object' ? data.schedule : {};
  if (!rtCanAutoFillCell(data, si, ci)) return false;
  data.schedule[`${si}_${ci}`] = value;
  return true;
}

function rtFindLastValueInPreviousSchedule(prevData, candidateNames, value, dnFilter = null) {
  if (!prevData || !Array.isArray(prevData.staff)) return null;
  const month = parseInt(prevData.month, 10);
  const year = parseInt(prevData.year, 10);
  if (!month || !year) return null;
  const days = new Date(year, month, 0).getDate();
  const candidates = candidateNames
    .map((name, orderIndex) => ({ name, orderIndex, si: rtFindStaffIndexByAnyName(prevData.staff, [name]) }))
    .filter(item => item.si >= 0);
  for (let day = days; day >= 1; day--) {
    const dns = dnFilter ? [dnFilter] : ['n', 'd'];
    for (const dn of dns) {
      const ci = rtCellIndexForDayShift(day, dn);
      for (const item of candidates) {
        if (rtScheduleValue(prevData, item.si, ci).toUpperCase() === value) {
          return {
            ...item,
            day,
            dn,
            date: rtDateForMonthDay(month, year, day),
            dow: rtDateForMonthDay(month, year, day).getDay()
          };
        }
      }
    }
  }
  return null;
}

function rtAutoFillFixedRows(data, options) {
  const staff = Array.isArray(data.staff) ? data.staff : [];
  const month = parseInt(data.month, 10);
  const year = parseInt(data.year, 10);
  if (!month || !year) return { essence: 0, waldstein: 0 };
  const days = new Date(year, month, 0).getDate();
  const result = { essence: 0, waldstein: 0 };
  if (options.essence) {
    const si = rtFindSpecialRowIndex(staff, 'Essence');
    for (let day = 1; si >= 0 && day <= days; day++) {
      if (rtFillIfEmpty(data, si, rtCellIndexForDayShift(day, 'd'), 'F')) result.essence += 1;
    }
  }
  if (options.waldstein) {
    const si = rtFindSpecialRowIndex(staff, 'Waldstein');
    for (let day = 1; si >= 0 && day <= days; day++) {
      if (rtFillIfEmpty(data, si, rtCellIndexForDayShift(day, 'd'), 'W')) result.waldstein += 1;
      if (rtFillIfEmpty(data, si, rtCellIndexForDayShift(day, 'n'), 'W')) result.waldstein += 1;
    }
  }
  return result;
}

function rtAutoFillQ(data, prevData, enabled) {
  if (!enabled) return 0;
  const staff = Array.isArray(data.staff) ? data.staff : [];
  const month = parseInt(data.month, 10);
  const year = parseInt(data.year, 10);
  if (!month || !year) return 0;
  const last = rtFindLastValueInPreviousSchedule(prevData, RT_AUTO_Q_ORDER, 'Q');
  let baseDate = last && last.date;
  let baseIndex = last ? last.orderIndex : 0;
  if (!baseDate) {
    baseDate = rtDateForMonthDay(month, year, 1);
    baseIndex = 0;
  }
  const indexes = RT_AUTO_Q_ORDER.map(name => rtFindStaffIndexByAnyName(staff, [name]));
  const days = new Date(year, month, 0).getDate();
  let count = 0;
  for (let day = 1; day <= days; day++) {
    const date = rtDateForMonthDay(month, year, day);
    const weekOffset = rtWeekDiff(baseDate, date);
    const personIdx = ((baseIndex + weekOffset) % RT_AUTO_Q_ORDER.length + RT_AUTO_Q_ORDER.length) % RT_AUTO_Q_ORDER.length;
    const si = indexes[personIdx];
    if (si < 0) continue;
    if (rtFillIfEmpty(data, si, rtCellIndexForDayShift(day, 'd'), 'Q')) count += 1;
    if (rtFillIfEmpty(data, si, rtCellIndexForDayShift(day, 'n'), 'Q')) count += 1;
  }
  return count;
}

function rtInferAkcentBase(prevData, names, dn) {
  const last = rtFindLastValueInPreviousSchedule(prevData, names, 'D', dn);
  if (!last) return { date: null, longOrderIndex: 0 };
  const wasLongDay = RT_AUTO_BLOCK_LONG.has(last.dow);
  const longOrderIndex = wasLongDay ? last.orderIndex : (last.orderIndex === 0 ? 1 : 0);
  return { date: last.date, longOrderIndex };
}

function rtAutoFillAkcentPair(data, prevData, names, dn) {
  const staff = Array.isArray(data.staff) ? data.staff : [];
  const month = parseInt(data.month, 10);
  const year = parseInt(data.year, 10);
  if (!month || !year) return 0;
  const base = rtInferAkcentBase(prevData, names, dn);
  const baseDate = base.date || rtDateForMonthDay(month, year, 1);
  const indexes = names.map(name => rtFindStaffIndexByAnyName(staff, [name]));
  const days = new Date(year, month, 0).getDate();
  let count = 0;
  for (let day = 1; day <= days; day++) {
    const date = rtDateForMonthDay(month, year, day);
    const weekOffset = rtWeekDiff(baseDate, date);
    const longIndex = ((base.longOrderIndex + weekOffset) % 2 + 2) % 2;
    const dow = date.getDay();
    const targetOrder = RT_AUTO_BLOCK_LONG.has(dow) ? longIndex : (longIndex === 0 ? 1 : 0);
    const si = indexes[targetOrder];
    const ci = rtCellIndexForDayShift(day, dn);
    if (si < 0) continue;
    const current = rtScheduleValue(data, si, ci).toUpperCase();
    if (RT_AUTO_SKIP_VALUES.has(current) || current) continue;
    if (rtFillIfEmpty(data, si, ci, 'D')) count += 1;
  }
  return count;
}

function rtAutoFillAkcent(data, prevData, enabled) {
  if (!enabled) return 0;
  return rtAutoFillAkcentPair(data, prevData, RT_AUTO_D_DAY, 'd')
    + rtAutoFillAkcentPair(data, prevData, RT_AUTO_D_NIGHT, 'n');
}

function rtAutoFillMonthlySchedule(data, prevData, rawOptions = {}) {
  const options = {
    essence: rawOptions.essence !== false,
    waldstein: rawOptions.waldstein !== false,
    q: rawOptions.q !== false,
    akcent: rawOptions.akcent !== false
  };
  const fixed = rtAutoFillFixedRows(data, options);
  return {
    essence: fixed.essence,
    waldstein: fixed.waldstein,
    q: rtAutoFillQ(data, prevData, options.q),
    akcent: rtAutoFillAkcent(data, prevData, options.akcent)
  };
}

function normalizeReqXyLocks(raw) {
  const locks = raw && typeof raw === 'object' ? raw : {};
  const cells = Array.isArray(locks.cells) ? locks.cells : [];
  const set = new Set();
  cells.forEach(item => {
    const m = String(item || '').trim().toLowerCase().match(/^(\d{1,2})-(d|n)$/);
    if (m) set.add(`${parseInt(m[1], 10)}-${m[2]}`);
  });
  return { raw: String(locks.raw || ''), cells: Array.from(set) };
}

function isReqXyLocked(data, ci) {
  const locks = normalizeReqXyLocks(data && data.reqXyLocks);
  const col = getReqCalCols(parseInt(data.month, 10), parseInt(data.year, 10))[ci];
  return !!(col && locks.cells.includes(`${col.day}-${col.dn}`));
}

const REQ_RECEPTION_CLOSED_MSG = 'Období pro editaci požadavků ještě nezačalo, nebo již skončilo.';

async function canManageRequirementsServer(req) {
  const user = req.session.user;
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (user.role === 'admin' || role.includes('ved') || role === 'pb6') return true;
  return (await hasButtonPerm(user, 'raspis', 'req_edit_all', false))
    || (await hasButtonPerm(user, 'raspis', 'req_create', false))
    || (await hasButtonPerm(user, 'raspis', 'req_toggle_reception', false))
    || (await hasButtonPerm(user, 'raspis', 'req_send_tvorba', false));
}

function parseRequirementStaffIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function getRequirementHotelLetters(data) {
  const letters = new Set();
  const hotels = Array.isArray(data && data.hotels) ? data.hotels : [];
  const month = parseInt(data && data.month, 10);
  const year = parseInt(data && data.year, 10);
  const currentIdx = Number.isFinite(month) && Number.isFinite(year) ? (year * 12 + month) : null;
  const monthIdx = (value) => {
    if (!value) return null;
    if (typeof value === 'string') {
      const m = value.match(/^(\d{4})-(\d{1,2})/);
      if (!m) return null;
      return (parseInt(m[1], 10) * 12) + parseInt(m[2], 10);
    }
    const y = parseInt(value.year, 10);
    const mo = parseInt(value.month, 10);
    return Number.isFinite(y) && Number.isFinite(mo) ? (y * 12 + mo) : null;
  };
  hotels.forEach(h => {
    const letter = String(h && h.letter || '').trim().toUpperCase();
    if (!letter || h.active === false) return;
    if (currentIdx !== null) {
      const from = monthIdx(h.activeFrom);
      const inactive = monthIdx(h.inactiveFrom);
      if (from !== null && currentIdx < from) return;
      if (inactive !== null && currentIdx >= inactive) return;
    }
    letters.add(letter);
  });
  return letters;
}

function rtFindLiveRequirementStaff(row, user, liveStaff, month, year) {
  const staff = Array.isArray(liveStaff) ? liveStaff : [];
  const rowId = row && row.userId ? String(row.userId) : '';
  const rowName = rtNormalizeStaffName(row && row.name);
  const rowLogins = getRequirementStaffLoginKeys(row);
  return staff.find(s => {
    if (!rtIsStaffActiveForMonth(s, month, year)) return false;
    if (rowId && s.userId && String(s.userId) === rowId) return true;
    for (const key of getRequirementStaffLoginKeys(s)) {
      if (rowLogins.has(key)) return true;
    }
    return rowName && rtNormalizeStaffName(s.name) === rowName;
  }) || null;
}

function rtRefreshRequirementStaffRow(row, live) {
  if (!live) return row || {};
  const current = row || {};
  return {
    ...current,
    userId: live.userId || current.userId || null,
    name: live.name || current.name || '',
    login: live.login || current.login || '',
    type: live.type || current.type || '',
    contract: live.contract || current.contract || '',
    hotelSkills: Array.isArray(live.hotelSkills) ? live.hotelSkills : (Array.isArray(current.hotelSkills) ? current.hotelSkills : []),
    noStandby: !!live.noStandby,
    reqXLimit: rtReqLimit(live.reqXLimit, rtReqLimit(current.reqXLimit, 7)),
    reqYLimit: rtReqLimit(live.reqYLimit, rtReqLimit(current.reqYLimit, 0)),
    activeFrom: live.activeFrom || current.activeFrom || null,
    activeUntil: live.activeUntil || current.activeUntil || null,
    inactive: false
  };
}

function validateRequirementStaffRowValues(currentData, incomingSchedule, si, sourceSi = si) {
  const staff = Array.isArray(currentData.staff) ? currentData.staff : [];
  const row = staff[si] || {};
  const prefix = `${sourceSi}_`;
  const hotelLetters = getRequirementHotelLetters(currentData);
  const xLimit = rtReqLimit(row.reqXLimit, 7);
  const yLimit = rtReqLimit(row.reqYLimit, 0);
  let xCount = 0;
  let yCount = 0;

  for (const [key, rawVal] of Object.entries(incomingSchedule || {})) {
    if (!key.startsWith(prefix)) continue;
    const val = String(rawVal || '').trim();
    if (!val) continue;
    const up = val.toUpperCase();
    if (up === 'X') { xCount += 1; continue; }
    if (up === 'Y') { yCount += 1; continue; }
    if (up === 'Z' || up === 'Ž') return 'Nemáte oprávnění psát z ani ž.';
    if (/^[A-Z]$/.test(up)) {
      if (hotelLetters.size && !hotelLetters.has(up)) return `Hotel ${up} není v požadavcích povolený.`;
      continue;
    }
    return `Hodnota "${val}" není v požadavcích povolená.`;
  }

  if (xCount > xLimit) return `Je možné napsat maximálně ${xLimit} x.`;
  if (yCount > yLimit) {
    if (yLimit <= 0) return 'Nemáte oprávnění psát y.';
    return `Je možné napsat maximálně ${yLimit} y.`;
  }
  return '';
}

function mergeRequirementStaffRow(currentData, incomingData, user, requestedStaffIndex = null, liveStaff = [], allowedStaffIndexes = null) {
  const current = currentData && typeof currentData === 'object' ? currentData : {};
  const incoming = incomingData && typeof incomingData === 'object' ? incomingData : {};
  const staff = Array.isArray(current.staff) ? current.staff : [];
  const ownSi = staff.findIndex(s => isSessionUserRequirementStaff(s, user));
  const allowed = allowedStaffIndexes instanceof Set
    ? allowedStaffIndexes
    : (Array.isArray(allowedStaffIndexes) ? new Set(allowedStaffIndexes) : null);
  const si = requestedStaffIndex !== null ? requestedStaffIndex : ownSi;
  let sourceSi = si;
  if (si < 0) return { error: 'V požadavcích nemám přiřazený váš řádek.' };
  if (!staff[si] || sourceSi < 0 || (allowed && !allowed.has(si))) {
    return { error: 'Tento radek pozadavku nemuzete ulozit.' };
  }

  const merged = JSON.parse(JSON.stringify(current));
  const live = rtFindLiveRequirementStaff(merged.staff[si], user, liveStaff, merged.month, merged.year);
  if (live) merged.staff[si] = rtRefreshRequirementStaffRow(merged.staff[si], live);
  merged.schedule = merged.schedule && typeof merged.schedule === 'object' ? merged.schedule : {};
  const incomingSchedule = incoming.schedule && typeof incoming.schedule === 'object' ? incoming.schedule : {};
  const prefix = `${si}_`;
  let sourcePrefix = `${sourceSi}_`;
  if (sourceSi !== si && !Object.keys(incomingSchedule).some(key => key.startsWith(sourcePrefix))) {
    sourceSi = si;
    sourcePrefix = prefix;
  }
  const validationError = validateRequirementStaffRowValues(merged, incomingSchedule, si, sourceSi);
  if (validationError) return { error: validationError };
  for (const [key, val] of Object.entries(incomingSchedule)) {
    if (!key.startsWith(sourcePrefix)) continue;
    const ci = parseInt(key.split('_')[1], 10);
    if (Number.isFinite(ci) && /^[xy]$/i.test(String(val || '').trim()) && isReqXyLocked(current, ci)) {
      return { error: 'V tomto dni/noci není možné psát x ani y.' };
    }
  }
  Object.keys(merged.schedule).forEach(key => {
    if (key.startsWith(prefix)) delete merged.schedule[key];
  });
  Object.entries(incomingSchedule).forEach(([key, val]) => {
    if (!key.startsWith(sourcePrefix) || !String(val || '').trim()) return;
    const ci = key.split('_')[1];
    if (ci !== undefined) merged.schedule[`${si}_${ci}`] = val;
  });
  const noteKey = rtRequestNoteKey(merged.staff[si], si);
  if (noteKey) {
    merged.reqNotes = merged.reqNotes && typeof merged.reqNotes === 'object' ? merged.reqNotes : {};
    const incomingNotes = incoming.reqNotes && typeof incoming.reqNotes === 'object' ? incoming.reqNotes : {};
    const sourceNoteKey = rtRequestNoteKey(incoming.staff?.[sourceSi], sourceSi);
    const noteSourceKey = Object.prototype.hasOwnProperty.call(incomingNotes, noteKey)
      ? noteKey
      : (sourceNoteKey && Object.prototype.hasOwnProperty.call(incomingNotes, sourceNoteKey) ? sourceNoteKey : '');
    if (noteSourceKey) {
      const incomingNote = incomingNotes[noteSourceKey];
      const noteText = typeof incomingNote === 'object'
        ? String(incomingNote.note || '').trim()
        : String(incomingNote || '').trim();
      if (noteText) {
        merged.reqNotes[noteKey] = {
          note: noteText,
          staffIndex: si,
          staffUserId: merged.staff[si]?.userId || null,
          staffLogin: String(merged.staff[si]?.login || noteKey).trim().toUpperCase(),
          staffName: merged.staff[si]?.name || ''
        };
      } else {
        delete merged.reqNotes[noteKey];
      }
    }
  }

  const mKey = `${merged.year}-${merged.month}`;
  if (mKey) {
    merged.monthlyData = merged.monthlyData && typeof merged.monthlyData === 'object' ? merged.monthlyData : {};
    const monthData = merged.monthlyData[mKey] && typeof merged.monthlyData[mKey] === 'object'
      ? merged.monthlyData[mKey]
      : {};
    monthData.schedule = JSON.parse(JSON.stringify(merged.schedule));
    monthData.extras = monthData.extras || {};
    monthData.requirements = monthData.requirements || {};
    monthData.reqNotes = JSON.parse(JSON.stringify(merged.reqNotes || {}));
    monthData.fondHpp = merged.fondHpp || '';
    monthData.fondZpp = merged.fondZpp || '';
    monthData.holidays = merged.holidays || '';
    merged.monthlyData[mKey] = monthData;
  }
  return { data: merged, staffIndex: si };
}

function mergeRequirementStaffRows(currentData, incomingData, user, staffIndexes, liveStaff = []) {
  const indexes = Array.from(new Set((Array.isArray(staffIndexes) ? staffIndexes : [])
    .map(v => Number(v))
    .filter(v => Number.isInteger(v) && v >= 0)));
  if (!indexes.length) return { error: 'V pozadavcich nemate prirazeny zadny povoleny radek.' };
  let mergedData = currentData;
  const allowed = new Set(indexes);
  for (const si of indexes) {
    const merged = mergeRequirementStaffRow(mergedData, incomingData, user, si, liveStaff, allowed);
    if (merged.error) return merged;
    mergedData = merged.data;
  }
  return { data: mergedData, staffIndexes: allowed };
}

function updateRequirementMeta(currentData, nextData, user, staffIndex = null) {
  const current = currentData && typeof currentData === 'object' ? currentData : {};
  const next = nextData && typeof nextData === 'object' ? nextData : {};
  const curSchedule = current.schedule && typeof current.schedule === 'object' ? current.schedule : {};
  const nextSchedule = next.schedule && typeof next.schedule === 'object' ? next.schedule : {};
  const meta = current.reqMeta && typeof current.reqMeta === 'object'
    ? JSON.parse(JSON.stringify(current.reqMeta))
    : {};
  const keys = new Set([...Object.keys(curSchedule), ...Object.keys(nextSchedule)]);
  const changedAt = new Date().toISOString();
  const staffScope = staffIndex instanceof Set
    ? staffIndex
    : (Array.isArray(staffIndex) ? new Set(staffIndex) : null);
  keys.forEach(key => {
    if (staffScope) {
      const si = parseInt(String(key).split('_')[0], 10);
      if (!staffScope.has(si)) return;
    } else if (staffIndex !== null && !key.startsWith(`${staffIndex}_`)) return;
    const oldVal = String(curSchedule[key] || '').trim();
    const newVal = String(nextSchedule[key] || '').trim();
    if (oldVal === newVal) return;
    if (newVal) {
      meta[key] = {
        value: newVal,
        userId: user.id || null,
        username: user.username || '',
        userName: user.name || user.username || '',
        timestamp: changedAt
      };
    } else {
      delete meta[key];
    }
  });
  next.reqMeta = meta;
  const mKey = `${next.year}-${next.month}`;
  if (next.monthlyData && next.monthlyData[mKey]) {
    next.monthlyData[mKey].reqMeta = JSON.parse(JSON.stringify(meta));
  }
  return next;
}

const REQ_DUP_SKIP = new Set(['X', 'Y', 'Z', 'Ž']);

function isRequirementDuplicateValue(value) {
  const val = String(value || '').trim();
  return !!val && !REQ_DUP_SKIP.has(val.toUpperCase());
}

function summarizeRequirementDuplicates(data, staffIndex = null) {
  const src = data && typeof data === 'object' ? data : {};
  const staff = Array.isArray(src.staff) ? src.staff : [];
  const schedule = src.schedule && typeof src.schedule === 'object' ? src.schedule : {};
  const month = parseInt(src.month, 10);
  const year = parseInt(src.year, 10);
  const calCols = getReqCalCols(month, year);
  const groups = new Map();
  calCols.forEach((col, ci) => {
    staff.forEach((s, si) => {
      const raw = String(schedule[`${si}_${ci}`] || '').trim();
      if (!isRequirementDuplicateValue(raw)) return;
      const key = `${ci}|${raw.toUpperCase()}`;
      if (!groups.has(key)) groups.set(key, { col, ci, val: raw.toUpperCase(), people: [] });
      groups.get(key).people.push({ si, name: s && s.name ? s.name : `Řádek ${si + 1}` });
    });
  });
  const staffScope = staffIndex instanceof Set
    ? staffIndex
    : (Array.isArray(staffIndex) ? new Set(staffIndex) : null);
  return Array.from(groups.values())
    .filter(g => g.people.length > 1)
    .filter(g => staffScope ? g.people.some(p => staffScope.has(p.si)) : (staffIndex === null || g.people.some(p => p.si === staffIndex)))
    .map(g => {
      const label = `${g.col.day}. ${month}. ${year} ${g.col.dn}`;
      return `${label} - ${g.val}: ${g.people.map(p => p.name).join(', ')}`;
    });
}

app.get('/api/rt/requirements', requireLogin, async (req, res) => {
  try {
    const db = getPool();
    const manager = await canManageRequirementsServer(req);
    const { rows } = await db.query(
      `SELECT key, month, year, label, status, allow_duplicates, updated_at, opened_at, closed_at, archived_at
       FROM rt_requirements
       WHERE archived_at IS NULL
         ${manager ? '' : "AND status = 'open'"}
       ORDER BY year DESC, month DESC`
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    console.error('GET /api/rt/requirements:', err);
    res.status(500).json({ ok: false, items: [] });
  }
});

app.get('/api/rt/requirements/archive', requireLogin, requirePermDefault('raspis', 'req_archive', false), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT key, month, year, label, status, updated_at, archived_at, archived_by
       FROM rt_requirements
       WHERE archived_at IS NOT NULL
       ORDER BY archived_at DESC`
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    console.error('GET /api/rt/requirements/archive:', err);
    res.status(500).json({ ok: false, items: [] });
  }
});

app.get('/api/rt/requirements/:key', requireLogin, async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rt_requirements WHERE key = $1', [key]);
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Nenalezeno.' });
    const entry = rows[0];
    const manager = await canManageRequirementsServer(req);
    if (!manager && (entry.archived_at || entry.status !== 'open')) {
      return res.json({
        ok: true,
        hidden: true,
        msg: REQ_RECEPTION_CLOSED_MSG,
        entry: {
          key: entry.key,
          month: entry.month,
          year: entry.year,
          label: entry.label,
          status: entry.status,
          archived_at: entry.archived_at
        }
      });
    }
    let parsed = {};
    try { parsed = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data; } catch(e) { parsed = {}; }
    parsed = await augmentRtDataWithActiveReceptionists(parsed, db);
    parsed = await augmentRtDataWithSpecialStaff(parsed, req.session.user.id, db);
    res.json({ ok: true, entry: { ...entry, data: parsed } });
  } catch (err) {
    console.error('GET /api/rt/requirements/:key:', err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/rt/requirements/create', requireLogin, requirePermDefault('raspis', 'req_create', false), async (req, res) => {
  const month = parseInt(req.body.month, 10);
  const year = parseInt(req.body.year, 10);
  const reqSettings = {
    fondHpp: String(req.body.fondHpp || '').trim(),
    fondZpp: String(req.body.fondZpp || '').trim(),
    holidays: String(req.body.holidays || '').trim(),
    xyLocks: normalizeReqXyLocks(req.body.xyLocks),
    allowDuplicates: req.body.allowDuplicates !== false && String(req.body.allowDuplicates || 'true') !== 'false'
  };
  if (!month || !year || month < 1 || month > 12) return res.json({ ok: false, msg: 'Neplatny mesic.' });
  const key = rtMonthKey(month, year);
  const prev = previousMonth(month, year);
  const prevKey = rtMonthKey(prev.month, prev.year);
  try {
    const db = getPool();
    const existing = await db.query('SELECT key FROM rt_requirements WHERE key = $1', [key]);
    if (existing.rows.length) return res.json({ ok: false, msg: 'Pozadavky pro tento mesic uz existuji.', key });
    const source = await db.query('SELECT data FROM rt_schedules WHERE key = $1', [prevKey]);
    if (!source.rows.length) {
      return res.json({ ok: false, msg: `Nenalezen publikovany rozpis predchoziho mesice (${prevKey}).` });
    }
    const raw = source.rows[0].data;
    const sourceData = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    let data = await augmentRtDataWithActiveReceptionists(buildInitialRequirementsData(sourceData, month, year, reqSettings), db);
    data = await augmentRtDataWithSpecialStaff(data, req.session.user.id, db);
    const label = reqLabel(month, year);
    await db.query(
      `INSERT INTO rt_requirements (key, month, year, label, data, status, allow_duplicates, xy_locks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$8)`,
      [key, month, year, label, JSON.stringify(data), reqSettings.allowDuplicates, JSON.stringify(reqSettings.xyLocks), req.session.user.name]
    );
    await db.query(
      `INSERT INTO rt_requirements_log (req_key, user_id, user_name, action, details)
       VALUES ($1,$2,$3,'create',$4)`,
      [key, req.session.user.id, req.session.user.name, JSON.stringify({ from: prevKey })]
    );
    res.json({ ok: true, key });
  } catch (err) {
    console.error('POST /api/rt/requirements/create:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/rt/requirements/archive', requireLogin, requirePermDefault('raspis', 'req_archive', false), async (req, res) => {
  const key = String(req.body.key || '');
  if (!key) return res.json({ ok: false, msg: 'Chybí požadavky.' });
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE rt_requirements
       SET archived_at = NOW(), archived_by = $2, updated_at = NOW(), updated_by = $2
       WHERE key = $1 AND archived_at IS NULL`,
      [key, req.session.user.name]
    );
    if (!rowCount) return res.json({ ok: false, msg: 'Nenalezeno.' });
    await db.query(
      `INSERT INTO rt_requirements_log (req_key, user_id, user_name, action, details)
       VALUES ($1,$2,$3,'archive',$4)`,
      [key, req.session.user.id, req.session.user.name, '{}']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/rt/requirements/archive:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/rt/requirements/restore', requireLogin, requirePermDefault('raspis', 'req_archive', false), async (req, res) => {
  const key = String(req.body.key || '');
  if (!key) return res.json({ ok: false, msg: 'Chybí požadavky.' });
  try {
    const db = getPool();
    const { rowCount } = await db.query(
      `UPDATE rt_requirements
       SET archived_at = NULL, archived_by = NULL, updated_at = NOW(), updated_by = $2
       WHERE key = $1`,
      [key, req.session.user.name]
    );
    if (!rowCount) return res.json({ ok: false, msg: 'Nenalezeno.' });
    await db.query(
      `INSERT INTO rt_requirements_log (req_key, user_id, user_name, action, details)
       VALUES ($1,$2,$3,'restore',$4)`,
      [key, req.session.user.id, req.session.user.name, '{}']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/rt/requirements/restore:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.delete('/api/rt/requirements/:key', requireLogin, requirePermDefault('raspis', 'req_delete', false), async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const db = getPool();
    const { rowCount } = await db.query('DELETE FROM rt_requirements WHERE key = $1 AND archived_at IS NOT NULL', [key]);
    if (!rowCount) return res.json({ ok: false, msg: 'Trvale smazat lze jen archivované požadavky.' });
    await db.query(
      `INSERT INTO rt_requirements_log (req_key, user_id, user_name, action, details)
       VALUES ($1,$2,$3,'delete',$4)`,
      [key, req.session.user.id, req.session.user.name, '{}']
    ).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/rt/requirements/:key:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/rt/requirements/status', requireLogin, requirePermDefault('raspis', 'req_toggle_reception', false), async (req, res) => {
  const key = String(req.body.key || '');
  const status = String(req.body.status || '');
  if (!key || !['draft', 'open', 'closed'].includes(status)) return res.json({ ok: false, msg: 'Neplatny stav.' });
  try {
    const db = getPool();
    const opened = status === 'open' ? ', opened_at = NOW()' : '';
    const closed = status === 'closed' ? ', closed_at = NOW()' : '';
    const { rowCount } = await db.query(
      `UPDATE rt_requirements
       SET status = $2, updated_at = NOW(), updated_by = $3${opened}${closed}
       WHERE key = $1`,
      [key, status, req.session.user.name]
    );
    if (!rowCount) return res.json({ ok: false, msg: 'Nenalezeno.' });
    await db.query(
      `INSERT INTO rt_requirements_log (req_key, user_id, user_name, action, details)
       VALUES ($1,$2,$3,'status',$4)`,
      [key, req.session.user.id, req.session.user.name, JSON.stringify({ status })]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/rt/requirements/status:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/rt/requirements/send-to-tvorba', requireLogin, requirePermDefault('raspis', 'req_send_tvorba', false), async (req, res) => {
  const key = String(req.body.key || '');
  if (!key) return res.json({ ok: false, msg: 'Chybí požadavky.' });
  try {
    const db = getPool();
    const existing = await db.query('SELECT * FROM rt_requirements WHERE key = $1 AND archived_at IS NULL', [key]);
    if (!existing.rows.length) return res.json({ ok: false, msg: 'Požadavky nejsou nalezené.' });
    const entry = existing.rows[0];
    if (entry.status === 'open') {
      return res.json({ ok: false, msg: 'Nejdřív ukončete editaci recepčním.' });
    }

    let data = {};
    try { data = typeof entry.data === 'string' ? JSON.parse(entry.data) : (entry.data || {}); } catch(e) { data = {}; }
    const month = parseInt(entry.month, 10);
    const year = parseInt(entry.year, 10);
    const prev = previousMonth(month, year);
    const prevKey = rtMonthKey(prev.month, prev.year);
    let prevData = null;
    try {
      const prevRows = await db.query('SELECT data FROM rt_schedules WHERE key = $1', [prevKey]);
      if (prevRows.rows.length) {
        const rawPrev = prevRows.rows[0].data;
        prevData = typeof rawPrev === 'string' ? JSON.parse(rawPrev) : (rawPrev || null);
      }
    } catch(e) {
      prevData = null;
    }
    data.month = data.month || month;
    data.year = data.year || year;
    data = await augmentRtDataWithActiveReceptionists(data, db);
    data = await augmentRtDataWithSpecialStaff(data, req.session.user.id, db);
    const autoFillSummary = rtAutoFillMonthlySchedule(data, prevData, req.body.autoFill || {});
    const mKey = `${year}-${month}`;
    const draftData = JSON.parse(JSON.stringify(data || {}));
    draftData.month = month;
    draftData.year = year;
    draftData.schedule = draftData.schedule && typeof draftData.schedule === 'object' ? draftData.schedule : {};
    draftData.extras = draftData.extras && typeof draftData.extras === 'object' ? draftData.extras : {};
    draftData.requirements = JSON.parse(JSON.stringify(draftData.schedule));
    draftData.monthlyData = draftData.monthlyData && typeof draftData.monthlyData === 'object' ? draftData.monthlyData : {};
    const monthData = draftData.monthlyData[mKey] && typeof draftData.monthlyData[mKey] === 'object'
      ? draftData.monthlyData[mKey]
      : {};
    monthData.schedule = JSON.parse(JSON.stringify(draftData.schedule));
    monthData.extras = JSON.parse(JSON.stringify(draftData.extras));
    monthData.requirements = JSON.parse(JSON.stringify(draftData.schedule));
    monthData.fondHpp = draftData.fondHpp || '';
    monthData.fondZpp = draftData.fondZpp || '';
    monthData.holidays = draftData.holidays || '';
    monthData.reqMeta = JSON.parse(JSON.stringify(draftData.reqMeta || {}));
    monthData.reqXyLocks = JSON.parse(JSON.stringify(draftData.reqXyLocks || {}));
    monthData.reqNotes = JSON.parse(JSON.stringify(draftData.reqNotes || {}));
    draftData.monthlyData[mKey] = monthData;
    const requestNotesCount = await saveRequestNotesForTvorba(db, draftData, month, year, req.session.user);

    const { rows } = await db.query(
      `INSERT INTO rt_drafts (user_id, month, year, data, saved_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, month, year) DO UPDATE SET data = $4, saved_at = NOW()
       RETURNING id`,
      [req.session.user.id, month, year, JSON.stringify(draftData)]
    );

    await db.query(
      `UPDATE rt_requirements
       SET status = 'closed',
           sent_to_tvorba_at = NOW(),
           archived_at = NOW(),
           archived_by = $2,
           updated_at = NOW(),
           updated_by = $2
       WHERE key = $1`,
      [key, req.session.user.name]
    );
    await db.query(
      `INSERT INTO rt_requirements_log (req_key, user_id, user_name, action, details)
       VALUES ($1,$2,$3,'send_to_tvorba',$4)`,
      [key, req.session.user.id, req.session.user.name, JSON.stringify({ draftId: rows[0].id, month, year, autoFill: autoFillSummary, requestNotes: requestNotesCount })]
    );
    res.json({ ok: true, draftId: rows[0].id, month, year, autoFill: autoFillSummary, requestNotes: requestNotesCount });
  } catch (err) {
    console.error('POST /api/rt/requirements/send-to-tvorba:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/rt/requirements/save', requireLogin, async (req, res) => {
  const key = String(req.body.key || '');
  const data = req.body.data;
  const confirmDuplicates = req.body.confirmDuplicates === true || String(req.body.confirmDuplicates || '') === 'true';
  const requestedStaffIndex = parseRequirementStaffIndex(req.body.staffIndex);
  if (!key || !data) return res.json({ ok: false, msg: 'Chybí data.' });
  const manager = await canManageRequirementsServer(req);
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const rollbackJson = async (payload) => {
      await client.query('ROLLBACK');
      return res.json(payload);
    };
    const existing = await client.query('SELECT status, data, allow_duplicates FROM rt_requirements WHERE key = $1 AND archived_at IS NULL FOR UPDATE', [key]);
    if (!existing.rows.length) {
      return rollbackJson({ ok: false, msg: 'Nenalezeno.' });
    }
    const raw = existing.rows[0].data;
    let currentData = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    currentData = await augmentRtDataWithActiveReceptionists(currentData, client);
    currentData = await augmentRtDataWithSpecialStaff(currentData, req.session.user.id, client);
    let saveData = data;
    let logScope = 'full-data';
    let staffIndex = null;
    let staffScope = null;
    const rowScopedSave = requestedStaffIndex !== null || !manager;
    if (rowScopedSave) {
      if (existing.rows[0].status !== 'open') {
        return rollbackJson({ ok: false, msg: 'Editace požadavků není povolena.' });
      }
      const liveStaff = await loadRtPortalReceptionists(client);
      const proxyLogins = manager ? new Set() : await getRequirementProxyAllowedLoginSet(req.session.user, client);
      const allowedStaffIndexes = manager
        ? null
        : getAllowedRequirementStaffIndexes(currentData, req.session.user, proxyLogins);
      const merged = (!manager && requestedStaffIndex === null && proxyLogins.size)
        ? mergeRequirementStaffRows(currentData, data, req.session.user, allowedStaffIndexes, liveStaff)
        : mergeRequirementStaffRow(currentData, data, req.session.user, requestedStaffIndex, liveStaff, allowedStaffIndexes);
      if (merged.error) return rollbackJson({ ok: false, msg: merged.error });
      saveData = merged.data;
      staffIndex = merged.staffIndex;
      staffScope = merged.staffIndexes || staffIndex;
      if (!saveData) return rollbackJson({ ok: false, msg: 'V požadavcích nemám přiřazený váš řádek.' });
      const duplicates = summarizeRequirementDuplicates(saveData, staffScope);
      if (duplicates.length && !existing.rows[0].allow_duplicates) {
        return rollbackJson({ ok: false, msg: `Tato směna už je zapsaná jiným recepčním:\n${duplicates.slice(0, 12).join('\n')}` });
      }
      if (duplicates.length && !confirmDuplicates) {
        return rollbackJson({ ok: false, duplicateWarning: true, duplicates });
      }
      logScope = 'own-row';
    }
    saveData = updateRequirementMeta(currentData, saveData, req.session.user, staffScope);
    const { rowCount } = await client.query(
      `UPDATE rt_requirements
       SET data = $2, updated_at = NOW(), updated_by = $3
       WHERE key = $1`,
      [key, JSON.stringify(saveData), req.session.user.name]
    );
    if (!rowCount) return rollbackJson({ ok: false, msg: 'Nenalezeno.' });
    await client.query(
      `INSERT INTO rt_requirements_log (req_key, user_id, user_name, action, details)
       VALUES ($1,$2,$3,'save',$4)`,
      [key, req.session.user.id, req.session.user.name, JSON.stringify({ scope: logScope })]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    console.error('POST /api/rt/requirements/save:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  } finally {
    client.release();
  }
});

app.get('/api/rt/log/:key', requireLogin, requirePermDefault('raspis', 'log', false), async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM rt_change_log WHERE schedule_key = $1 ORDER BY timestamp DESC LIMIT 500', [key]
    );
    res.json(rows);
  } catch (err) { console.error(err); res.json([]); }
});

app.post('/api/rt/log', requireLogin, requirePermDefault('raspis', 'log', false), async (req, res) => {
  const { key, entries } = req.body;
  if (!key || !Array.isArray(entries)) return res.json({ ok: false });
  try {
    const db = getPool();
    for (const e of entries) {
      await db.query(
        `INSERT INTO rt_change_log (schedule_key, user_id, user_name, is_saved, change_type, staff_name, day, dn, old_value, new_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [key, req.session.user.id, req.session.user.name, e.is_saved||false, e.change_type||'cell',
         e.staff_name||'', e.day||null, e.dn||null, e.old_value||null, e.new_value||null]
      );
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
init()
  .then(() => {
    app.listen(PORT, () => console.log(`AVE Portál běží na portu ${PORT}`));
  })
  .catch(err => {
    console.error('Chyba inicializace databáze:', err.message);
    process.exit(1);
  });
