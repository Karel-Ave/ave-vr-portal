const express     = require('express');
const session     = require('express-session');
const bcrypt      = require('bcryptjs');
const path        = require('path');
const PDFDocument = require('pdfkit');
const { getPool, init } = require('./db');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

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
  rolling: true,                                    // reset 30 dní při každém požadavku
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }    // 30 dní
}));

// ── Auth helpery ──────────────────────────────────────────────────────────────

const requireLogin = (req, res, next) =>
  req.session.user ? next() : res.redirect('/');

// Widget: nepřihlášený → login s ?next=/widget (aby se vrátil zpět)
const requireLoginWidget = (req, res, next) =>
  req.session.user ? next() : res.redirect('/?next=/widget');

const requireAdmin = (req, res, next) =>
  req.session.user?.role === 'admin' ? next() : res.redirect('/portal');

// Portál: widget-only uživatelé sem nesmí
const requirePortalAccess = (req, res, next) => {
  if (!req.session.user) return res.redirect('/');
  if (req.session.user.role === 'widget') return res.redirect('/widget');
  return next();
};

// ── In-memory zámky (zabrání dvěma uživatelům editovat zároveň) ──────────────

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

// Middleware: vyžaduje oprávnění pro danou aplikaci a tlačítko
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
  if (req.session.user.role === 'widget') return res.redirect('/widget');
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

// Samostatná karta Rozpis (recepční pohled)
app.get('/rozpis', requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'raspis.html'))
);

// Desktop widget — dnešní rozpis
app.get('/widget', requireLoginWidget, (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'widget.html'))
);

// ── API: Auth ─────────────────────────────────────────────────────────────────

app.get('/api/me', requireLogin, (req, res) => res.json(req.session.user));

// Save theme preference for the current user
app.patch('/api/me/theme', requireLogin, async (req, res) => {
  const theme = req.body.theme === 'dark' ? 'dark' : 'light';
  try {
    const db = getPool();
    await db.query('UPDATE users SET theme = $1 WHERE id = $2', [theme, req.session.user.id]);
    req.session.user.theme = theme;
    res.json({ ok: true });
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
    req.session.user = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      theme: user.theme || 'light'
    };
    logEvent(user.id, user.username, 'login', { role: user.role });
    // Widget-only uživatelé vždy na widget; ostatní dle ?next nebo na portál
    const next = req.body.next || '';
    if (user.role === 'widget' || next === '/widget') {
      return res.redirect('/widget');
    }
    res.redirect('/portal');
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
  if (!newPassword || newPassword.length < 6) {
    return res.json({ ok: false, msg: 'Nové heslo musí mít alespoň 6 znaků.' });
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
      'SELECT id, name, username, role, created_at FROM users ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    console.error('Chyba načtení uživatelů:', err);
    res.status(500).json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.post('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name?.trim() || !username?.trim() || !password || !role) {
    return res.json({ ok: false, msg: 'Vyplňte všechna pole.' });
  }
  if (password.length < 6) {
    return res.json({ ok: false, msg: 'Heslo musí mít alespoň 6 znaků.' });
  }
  try {
    const db = getPool();
    const { rows: validRoles } = await db.query('SELECT name FROM permission_groups');
    if (!validRoles.some(r => r.name === role)) {
      return res.json({ ok: false, msg: 'Neplatná skupina.' });
    }
    await db.query(
      'INSERT INTO users (name, username, password_hash, role) VALUES ($1, $2, $3, $4)',
      [name.trim(), username.trim(), bcrypt.hashSync(password, 10), role]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.json({ ok: false, msg: 'Uživatelské jméno již existuje.' });
    console.error('Chyba vytvoření uživatele:', err);
    res.json({ ok: false, msg: 'Chyba serveru.' });
  }
});

app.patch('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, role, password, username } = req.body;

  if (id === req.session.user.id && role && role !== 'admin') {
    return res.json({ ok: false, msg: 'Nemůžete si sami odebrat roli admina.' });
  }

  try {
    const db = getPool();
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
    if (password) {
      if (password.length < 6) return res.json({ ok: false, msg: 'Heslo musí mít alespoň 6 znaků.' });
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
    const { rows } = await db.query('SELECT name, display_name, perms FROM permission_groups ORDER BY name');
    res.json(rows.map(r => ({ name: r.name, displayName: r.display_name, perms: JSON.parse(r.perms || '{}') })));
  } catch(err) { res.json([]); }
});

app.post('/api/admin/groups', requireLogin, requireAdmin, async (req, res) => {
  const { name, displayName } = req.body;
  if (!name || !displayName) return res.json({ ok: false, msg: 'Chybí data.' });
  try {
    const db = getPool();
    await db.query('INSERT INTO permission_groups (name, display_name) VALUES ($1, $2)', [name, displayName]);
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
    const val = req.body.overrides ? JSON.stringify(req.body.overrides) : null;
    await db.query('UPDATE users SET perm_overrides = $1 WHERE id = $2', [val, req.params.id]);
    res.json({ ok: true });
  } catch(err) { res.json({ ok: false, msg: 'Chyba serveru.' }); }
});

app.get('/api/admin/logs', requireLogin, requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, timestamp, user_id, user_name, action, details
       FROM logs ORDER BY timestamp DESC LIMIT 500`
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
    const isAdm = user.role === 'admin';
    const DEFAULTS = { raspis: { enabled: true, buttons: {
      tab_nastaveni: isAdm, tab_tvorba: isAdm, tab_rozpis_vr: true, tab_rozpis: false,
      import: isAdm, delete: isAdm, trash: isAdm, edit: true, export: true, log: isAdm
    } } };
    const allApps = new Set([...Object.keys(DEFAULTS), ...Object.keys(groupPerms), ...Object.keys(userOv)]);
    for (const appKey of allApps) {
      const gp   = groupPerms[appKey] || DEFAULTS[appKey] || { enabled: true, buttons: {} };
      const uo   = userOv[appKey] || {};
      const enabled = (uo.enabled != null) ? uo.enabled : (gp.enabled != null ? gp.enabled : true);
      const visible = (uo.visible != null) ? uo.visible : (gp.visible != null ? gp.visible : true);
      const buttons = {};
      const allBtns = new Set([...Object.keys(gp.buttons || {}), ...Object.keys(uo.buttons || {})]);
      for (const btnKey of allBtns) {
        const gb = (gp.buttons || {})[btnKey]; const ub = (uo.buttons || {})[btnKey];
        buttons[btnKey] = (ub != null) ? ub : (gb != null ? gb : true);
      }
      result[appKey] = { enabled, visible, buttons };
    }
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
    const { staff, hotels, hotelOverrides, customHotels, fondHpp, fondZpp, holidays } = req.body;
    if (staff !== undefined)        current.staff = staff;
    if (hotels !== undefined)       current.hotels = hotels;
    if (hotelOverrides !== undefined) current.hotelOverrides = hotelOverrides;
    if (customHotels !== undefined) current.customHotels = customHotels;
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

app.post('/api/rozpisy/publish', requireLogin, requireAdmin, async (req, res) => {
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
app.get('/api/widget-today', requireLogin, async (req, res) => {
  try {
    const now        = new Date();
    const todayDay   = parseInt(req.query.day)   || now.getDate();
    const todayMonth = parseInt(req.query.month) || now.getMonth() + 1;
    const todayYear  = parseInt(req.query.year)  || now.getFullYear();
    const key        = `${String(todayMonth).padStart(2, '0')}/${todayYear}`;

    const db = getPool();
    const { rows } = await db.query('SELECT data FROM rozpisy WHERE key = $1', [key]);

    const HOTELS      = ['A','B','C','D','E','G','H','I','J','L','M','N','S','T','U','P','Q'];
    const VALID_TYPES = new Set(['Denní','Noční','Obojí','Vedoucí']);

    const hotelMap = {};
    HOTELS.forEach(h => { hotelMap[h] = { day: null, night: null }; });

    if (rows.length) {
      const raw      = rows[0].data;
      const data     = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const staff    = data.staff    || [];
      const schedule = data.schedule || {};
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
      'SELECT default_raspis_key FROM user_preferences WHERE user_id = $1',
      [req.session.user.id]
    );
    res.json({ default_raspis_key: rows[0]?.default_raspis_key || null });
  } catch (err) {
    res.json({ default_raspis_key: null });
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

app.get('/api/blacklist/entries', requireLogin, async (req, res) => {
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

app.post('/api/blacklist/entries', requireLogin, async (req, res) => {
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

app.put('/api/blacklist/entries/:id', requireLogin, async (req, res) => {
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

app.post('/api/blacklist/remove', requireLogin, async (req, res) => {
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

app.put('/api/blacklist/intro', requireLogin, async (req, res) => {
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

app.get('/api/blacklist/audit', requireLogin, async (req, res) => {
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
app.delete('/api/blacklist/audit/bulk', requireLogin, async (req, res) => {
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
app.delete('/api/blacklist/audit/:id', requireLogin, async (req, res) => {
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
app.get('/api/blacklist/export/email/pending', requireLogin, async (req, res) => {
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
app.post('/api/blacklist/export/email', requireLogin, async (req, res) => {
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

app.get('/api/blacklist/export/pdf', requireLogin, async (req, res) => {
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
  const { rows } = await db.query(
    `SELECT login, full_name, active FROM receptionist_logins ORDER BY full_name`
  );
  res.json(rows);
});

app.post('/api/priplatky/recepni', requireLogin, async (req, res) => {
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

app.patch('/api/priplatky/recepni/:login', requireLogin, async (req, res) => {
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

app.delete('/api/priplatky/recepni/:login', requireLogin, async (req, res) => {
  const db = getPool();
  await db.query('DELETE FROM receptionist_logins WHERE login=$1', [req.params.login]);
  res.json({ ok: true });
});

// Záznamy
app.get('/api/priplatky/zaznamy', requireLogin, async (req, res) => {
  const { rok, mesic } = req.query;
  const db = getPool();
  const { rows } = await db.query(
    `SELECT z.*,
            rl.full_name
     FROM priplatky_zaznamy z
     LEFT JOIN receptionist_logins rl ON rl.login = z.login
     WHERE z.rok = $1 AND z.mesic = $2
     ORDER BY z.datum, z.id`,
    [rok, mesic]
  );
  res.json(rows);
});

app.post('/api/priplatky/zaznamy', requireLogin, async (req, res) => {
  const { den, mesic, rok, mesicDatum, rokDatum, sekce, login, hotel, castka,
          poznamka, partner, klient, koho_skolil } = req.body;
  const db = getPool();
  // mesicDatum/rokDatum = skutečné datum záznamu; mesic/rok = platební měsíc (přehled)
  const dM = mesicDatum || mesic;
  const dR = rokDatum   || rok;
  const datum = `${dR}-${String(dM).padStart(2,'0')}-${String(den).padStart(2,'0')}`;
  try {
    const r = await db.query(
      `INSERT INTO priplatky_zaznamy
         (rok,mesic,sekce,login,datum,hotel,castka,poznamka,partner,klient,koho_skolil,vlozil)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [rok, mesic, sekce, login, datum, hotel||null, castka||0,
       poznamka||null, partner||null, klient||null, koho_skolil||null,
       req.session.user.username]
    );
    await logEvent(req.session.user.id, req.session.user.username,
      'priplatky_add', { id: r.rows[0].id, login, sekce });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    res.status(400).json({ ok: false, msg: err.message });
  }
});

app.patch('/api/priplatky/zaznamy/:id', requireLogin, async (req, res) => {
  const { den, mesic, rok, mesicDatum, rokDatum, sekce, login, hotel, castka,
          poznamka, partner, klient, koho_skolil } = req.body;
  const db = getPool();
  const dM = mesicDatum || mesic;
  const dR = rokDatum   || rok;
  const datum = den
    ? `${dR}-${String(dM).padStart(2,'0')}-${String(den).padStart(2,'0')}`
    : undefined;
  try {
    await db.query(
      `UPDATE priplatky_zaznamy SET
         rok=$1, mesic=$2, sekce=$3, login=$4,
         datum=COALESCE($5,datum), hotel=$6, castka=$7,
         poznamka=$8, partner=$9, klient=$10, koho_skolil=$11,
         upravil=$12, upraveno_kdy=NOW()
       WHERE id=$13`,
      [rok, mesic, sekce, login, datum||null, hotel||null, castka||0,
       poznamka||null, partner||null, klient||null, koho_skolil||null,
       req.session.user.username, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, msg: err.message });
  }
});

app.delete('/api/priplatky/zaznamy/:id', requireLogin, async (req, res) => {
  const db = getPool();
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

app.post('/api/priplatky/poznamky', requireLogin, async (req, res) => {
  const { text, poradi, typ } = req.body;
  const typVal = ['brani','obecne'].includes(typ) ? typ : 'brani';
  const db = getPool();
  const r = await db.query(
    `INSERT INTO priplatky_poznamky (text, poradi, typ) VALUES ($1,$2,$3) RETURNING *`,
    [text, poradi || 0, typVal]
  );
  res.json({ ok: true, row: r.rows[0] });
});

app.patch('/api/priplatky/poznamky/:id', requireLogin, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ ok:false, msg:'Prázdný text.' });
  const db = getPool();
  const r = await db.query(
    `UPDATE priplatky_poznamky SET text=$1 WHERE id=$2 RETURNING *`,
    [text.trim(), req.params.id]
  );
  res.json({ ok: true, row: r.rows[0] });
});

app.delete('/api/priplatky/poznamky/:id', requireLogin, async (req, res) => {
  const db = getPool();
  await db.query(`DELETE FROM priplatky_poznamky WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// Autocomplete pro "Koho školil"
app.get('/api/priplatky/koho-skolil-hints', requireLogin, async (req, res) => {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT DISTINCT koho_skolil
     FROM priplatky_zaznamy
     WHERE koho_skolil IS NOT NULL AND koho_skolil <> ''
     ORDER BY koho_skolil`
  );
  res.json(rows.map(r => r.koho_skolil));
});

// Export XLSX
app.get('/api/priplatky/export/xlsx', requireLogin, async (req, res) => {
  const { rok, mesic } = req.query;
  const db = getPool();

  const SEKCE_ORDER = {'braní směn':1,'recenze':2,'školení':3,'ostatní':4,'pokuta':5};

  const { rows: zaznamy } = await db.query(
    `SELECT z.*, rl.full_name
     FROM priplatky_zaznamy z
     LEFT JOIN receptionist_logins rl ON rl.login = z.login
     WHERE z.rok=$1 AND z.mesic=$2`,
    [rok, mesic]
  );
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
     WHERE z.rok=$1 AND z.mesic=$2
     GROUP BY z.login, rl.full_name ORDER BY z.login`,
    [rok, mesic]
  );

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
app.post('/api/priplatky/import-template', requireLogin, async (req, res) => {
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

// ── Start ─────────────────────────────────────────────────────────────────────
init()
  .then(() => {
    app.listen(PORT, () => console.log(`AVE Portál běží na portu ${PORT}`));
  })
  .catch(err => {
    console.error('Chyba inicializace databáze:', err.message);
    process.exit(1);
  });
