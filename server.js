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
  cookie: { maxAge: 12 * 60 * 60 * 1000 } // 12 hodin
}));

// ── Auth helpery ──────────────────────────────────────────────────────────────

const requireLogin = (req, res, next) =>
  req.session.user ? next() : res.redirect('/');

const requireAdmin = (req, res, next) =>
  req.session.user?.role === 'admin' ? next() : res.redirect('/portal');

// ── In-memory zámky (zabrání dvěma uživatelům editovat zároveň) ──────────────

const locks = {};
const lockTimers = {};
const LOCK_TTL = 10 * 60 * 1000; // 10 minut

function setLockTimer(key) {
  if (lockTimers[key]) clearTimeout(lockTimers[key]);
  lockTimers[key] = setTimeout(() => { delete locks[key]; delete lockTimers[key]; }, LOCK_TTL);
}

// ── Stránky ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) =>
  req.session.user ? res.redirect('/portal') : res.sendFile(path.join(__dirname, 'views', 'login.html'))
);

app.get('/portal', requireLogin, (req, res) =>
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
    res.redirect('/portal');
  } catch (err) {
    console.error('Chyba přihlášení:', err);
    res.redirect('/?error=1');
  }
});

app.get('/logout', (req, res) => {
  if (req.session.user) {
    Object.keys(locks).forEach(k => {
      if (locks[k]?.userId === req.session.user.id) delete locks[k];
    });
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
  if (!['admin', 'vedoucí'].includes(role)) {
    return res.json({ ok: false, msg: 'Neplatná role.' });
  }
  try {
    const db = getPool();
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

app.get('/api/my-permissions', requireLogin, async (req, res) => {
  try {
    const db   = getPool();
    const user = req.session.user;
    const { rows: gr } = await db.query('SELECT perms FROM permission_groups WHERE name = $1', [user.role]);
    const groupPerms   = gr.length ? JSON.parse(gr[0].perms || '{}') : {};
    const { rows: ur } = await db.query('SELECT perm_overrides FROM users WHERE id = $1', [user.id]);
    const userOv       = (ur.length && ur[0].perm_overrides) ? JSON.parse(ur[0].perm_overrides) : {};
    const result = {};
    const DEFAULTS = { raspis: { enabled: true, buttons: { import: user.role === 'admin', delete: user.role === 'admin', trash: user.role === 'admin', edit: true, export: true } } };
    const allApps = new Set([...Object.keys(DEFAULTS), ...Object.keys(groupPerms), ...Object.keys(userOv)]);
    for (const appKey of allApps) {
      const gp   = groupPerms[appKey] || DEFAULTS[appKey] || { enabled: true, buttons: {} };
      const uo   = userOv[appKey] || {};
      const enabled = (uo.enabled != null) ? uo.enabled : gp.enabled;
      const buttons = {};
      const allBtns = new Set([...Object.keys(gp.buttons || {}), ...Object.keys(uo.buttons || {})]);
      for (const btnKey of allBtns) {
        const gb = (gp.buttons || {})[btnKey]; const ub = (uo.buttons || {})[btnKey];
        buttons[btnKey] = (ub != null) ? ub : (gb != null ? gb : true);
      }
      result[appKey] = { enabled, buttons };
    }
    res.json(result);
  } catch(err) { console.error(err); res.json({}); }
});

// ── API: Zámky ────────────────────────────────────────────────────────────────

app.get('/api/lock/:app', requireLogin, (req, res) =>
  res.json({ lock: locks[req.params.app] || null })
);

app.post('/api/lock/:app/acquire', requireLogin, (req, res) => {
  const key  = req.params.app;
  const user = req.session.user;
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
    res.json({ ok: true, key, label });
  } catch (err) {
    console.error('Chyba uložení rozpisu:', err);
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

app.post('/api/drafts/save', requireLogin, async (req, res) => {
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

app.delete('/api/drafts/:id', requireLogin, async (req, res) => {
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

app.post('/api/drafts/restore/:id', requireLogin, async (req, res) => {
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

// ── Blacklist ─────────────────────────────────────────────────────────────────

app.get('/blacklist', requireLogin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'blacklist.html'))
);

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
    return `<div style="margin: 0 0 10px 0; padding: 11px 15px; border: 1px dashed ${borderColor}88; border-left: 4px solid ${borderColor}; background: ${bgColor}; font-size: 11pt; word-break: break-word; line-height: 1.6; box-sizing: border-box;">
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
          doc.rect(x, y, col.w, rh).fill(isHeader ? '#A9D08E' : '#ffffff');
          doc.restore();
          doc.rect(x, y, col.w, rh).stroke('#000000');
          doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(fs).fillColor('#000000')
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

// ── Start ─────────────────────────────────────────────────────────────────────

init()
  .then(() => {
    app.listen(PORT, () => console.log(`AVE Portál běží na portu ${PORT}`));
  })
  .catch(err => {
    console.error('Chyba inicializace databáze:', err.message);
    process.exit(1);
  });
