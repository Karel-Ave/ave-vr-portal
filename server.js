const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
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

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.redirect('/?error=1');
    }
    req.session.user = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role
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
  const { name, role, password } = req.body;

  if (id === req.session.user.id && role && role !== 'admin') {
    return res.json({ ok: false, msg: 'Nemůžete si sami odebrat roli admina.' });
  }

  try {
    const db = getPool();
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

// ── Start ─────────────────────────────────────────────────────────────────────

init()
  .then(() => {
    app.listen(PORT, () => console.log(`AVE Portál běží na portu ${PORT}`));
  })
  .catch(err => {
    console.error('Chyba inicializace databáze:', err.message);
    process.exit(1);
  });
