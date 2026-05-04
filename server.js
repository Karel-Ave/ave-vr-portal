const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ROZPISY_FILE = path.join(DATA_DIR, 'rozpisy.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([
    { id: 1, name: 'Karel', username: 'Karel-Ave', password: bcrypt.hashSync('Karel.AVE', 10), role: 'admin' },
    { id: 2, name: 'Adam', username: 'Adam-Ave', password: bcrypt.hashSync('Adam.AVE', 10), role: 'user' },
    { id: 3, name: 'Matej', username: 'Matej-Ave', password: bcrypt.hashSync('Matej.AVE', 10), role: 'user' }
  ], null, 2));
}
if (!fs.existsSync(ROZPISY_FILE)) fs.writeFileSync(ROZPISY_FILE, JSON.stringify({ current: null, history: [] }, null, 2));
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ staff: [], hotels: [], hotelOverrides: {}, customHotels: [] }, null, 2));

const getUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const saveUsers = u => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
const getRozpisy = () => JSON.parse(fs.readFileSync(ROZPISY_FILE, 'utf8'));
const saveRozpisy = r => fs.writeFileSync(ROZPISY_FILE, JSON.stringify(r, null, 2));
const getSettings = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
const saveSettings = s => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ave-portal-secret-2026',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

const requireLogin = (req, res, next) => req.session.user ? next() : res.redirect('/');

// Locks
let locks = { tvorba: null, rozpis: null, 'rozpis-view': null };

// ââ Auth ââ
app.get('/', (req, res) => req.session.user ? res.redirect('/portal') : res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = getUsers().find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.redirect('/?error=1');
  req.session.user = { id: user.id, name: user.name, username: user.username, role: user.role };
  res.redirect('/portal');
});
app.get('/logout', (req, res) => {
  if (req.session.user) {
    Object.keys(locks).forEach(k => { if (locks[k] && locks[k].userId === req.session.user.id) locks[k] = null; });
  }
  req.session.destroy();
  res.redirect('/');
});

// ââ Pages ââ
app.get('/portal', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'portal.html')));
app.get('/tvorba-rozpisu', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'ave-portal', 'public', 'Rozpis ke zmene.html')));
app.get('/rozpis-view', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'rozpis-view.html')));
app.use('/static', express.static(path.join(__dirname, 'public')));

// ââ API: me ââ
app.get('/api/me', requireLogin, (req, res) => res.json(req.session.user));

// ââ API: change password ââ
app.post('/api/change-password', requireLogin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.json({ ok: false, msg: 'NovÃ© heslo musÃ­ mÃ­t alespoÅ 6 znakÅ¯.' });
  const users = getUsers();
  const user = users.find(u => u.id === req.session.user.id);
  if (!bcrypt.compareSync(oldPassword, user.password)) return res.json({ ok: false, msg: 'SouÄasnÃ© heslo nenÃ­ sprÃ¡vnÃ©.' });
  user.password = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  res.json({ ok: true, msg: 'Heslo bylo zmÄnÄno.' });
});

// ââ API: locks ââ
app.get('/api/lock/:app', requireLogin, (req, res) => res.json({ lock: locks[req.params.app] || null }));
app.post('/api/lock/:app/acquire', requireLogin, (req, res) => {
  const key = req.params.app;
  const user = req.session.user;
  if (locks[key] && locks[key].userId !== user.id) return res.json({ ok: false, lock: locks[key] });
  locks[key] = { userId: user.id, userName: user.name, since: new Date().toISOString() };
  res.json({ ok: true, lock: locks[key] });
});
app.post('/api/lock/:app/release', requireLogin, (req, res) => {
  const key = req.params.app;
  if (locks[key] && locks[key].userId === req.session.user.id) locks[key] = null;
  res.json({ ok: true });
});

// ââ API: settings ââ
app.get('/api/settings', requireLogin, (req, res) => res.json(getSettings()));
app.post('/api/settings', requireLogin, (req, res) => {
  const { staff, hotels, hotelOverrides, customHotels, fondHpp, fondZpp, holidays } = req.body;
  const s = getSettings();
  if (staff !== undefined) s.staff = staff;
  if (hotels !== undefined) s.hotels = hotels;
  if (hotelOverrides !== undefined) s.hotelOverrides = hotelOverrides;
  if (customHotels !== undefined) s.customHotels = customHotels;
  if (fondHpp !== undefined) s.fondHpp = fondHpp;
  if (fondZpp !== undefined) s.fondZpp = fondZpp;
  if (holidays !== undefined) s.holidays = holidays;
  saveSettings(s);
  res.json({ ok: true });
});

// ââ API: rozpisy ââ
app.get('/api/rozpisy', requireLogin, (req, res) => {
  const r = getRozpisy();
  res.json({ current: r.current, history: r.history.map(h => ({ key: h.key, label: h.label, month: h.month, year: h.year, publishedAt: h.publishedAt, publishedBy: h.publishedBy })) });
});
app.get('/api/rozpisy/:key', requireLogin, (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const entry = getRozpisy().history.find(r => r.key === key);
  if (!entry) return res.status(404).json({ ok: false });
  res.json({ ok: true, entry });
});
app.post('/api/rozpisy/publish', requireLogin, (req, res) => {
  const { month, year, data } = req.body;
  if (!month || !year || !data) return res.json({ ok: false, msg: 'ChybÃ­ data.' });
  const key = `${String(month).padStart(2,'0')}/${year}`;
  const label = `Rozpis ${String(month).padStart(2,'0')}/${year}`;
  const r = getRozpisy();
  r.history = r.history.filter(h => h.key !== key);
  r.history.unshift({ key, label, month, year, data, publishedAt: new Date().toISOString(), publishedBy: req.session.user.name });
  r.current = key;
  saveRozpisy(r);
  res.json({ ok: true, label });
});
app.post('/api/rozpisy/delete', requireLogin, (req, res) => {
  const { key } = req.body;
  const r = getRozpisy();
  r.history = r.history.filter(h => h.key !== key);
  if (r.current === key) r.current = r.history[0] ? r.history[0].key : null;
  saveRozpisy(r);
  res.json({ ok: true });
});

app.post('/api/rozpisy/set-current', requireLogin, (req, res) => {
  const { key } = req.body;
  const r = getRozpisy();
  if (!r.history.find(h => h.key === key)) return res.json({ ok: false });
  r.current = key;
  saveRozpisy(r);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`AVE PortÃ¡l bÄÅ¾Ã­ na portu ${PORT}`));
