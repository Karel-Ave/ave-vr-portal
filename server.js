const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(__dirname, 'data', 'users.json');
const ROZPISY_FILE = path.join(__dirname, 'data', 'rozpisy.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));

if (!fs.existsSync(DATA_FILE)) {
  const users = [
    { id: 1, name: 'Karel', username: 'Karel-Ave', password: bcrypt.hashSync('Karel.AVE', 10), role: 'admin' },
    { id: 2, name: 'Adam', username: 'Adam-Ave', password: bcrypt.hashSync('Adam.AVE', 10), role: 'user' },
    { id: 3, name: 'Matej', username: 'Matej-Ave', password: bcrypt.hashSync('Matej.AVE', 10), role: 'user' }
  ];
  fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

if (!fs.existsSync(ROZPISY_FILE)) {
  fs.writeFileSync(ROZPISY_FILE, JSON.stringify({ current: null, history: [] }, null, 2));
}

function getUsers() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function saveUsers(u) { fs.writeFileSync(DATA_FILE, JSON.stringify(u, null, 2)); }
function getRozpisy() { return JSON.parse(fs.readFileSync(ROZPISY_FILE, 'utf8')); }
function saveRozpisy(r) { fs.writeFileSync(ROZPISY_FILE, JSON.stringify(r, null, 2)); }

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ave-portal-secret-2026',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/');
}

let rozpis_lock = null;

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/portal');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.redirect('/?error=1');
  req.session.user = { id: user.id, name: user.name, username: user.username, role: user.role };
  res.redirect('/portal');
});

app.get('/logout', (req, res) => {
  if (rozpis_lock && req.session.user && rozpis_lock.userId === req.session.user.id) rozpis_lock = null;
  req.session.destroy();
  res.redirect('/');
});

app.get('/portal', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'portal.html')));
app.get('/api/me', requireLogin, (req, res) => res.json(req.session.user));

app.post('/api/change-password', requireLogin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.json({ ok: false, msg: 'Nové heslo musí mít alespoň 6 znaků.' });
  const users = getUsers();
  const user = users.find(u => u.id === req.session.user.id);
  if (!bcrypt.compareSync(oldPassword, user.password)) return res.json({ ok: false, msg: 'Současné heslo není správné.' });
  user.password = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  res.json({ ok: true, msg: 'Heslo bylo změněno.' });
});

// Lock API
app.get('/api/lock/rozpis', requireLogin, (req, res) => res.json({ lock: rozpis_lock }));
app.post('/api/lock/rozpis/acquire', requireLogin, (req, res) => {
  const user = req.session.user;
  if (rozpis_lock && rozpis_lock.userId !== user.id) return res.json({ ok: false, lock: rozpis_lock });
  rozpis_lock = { userId: user.id, userName: user.name, since: new Date().toISOString() };
  res.json({ ok: true, lock: rozpis_lock });
});
app.post('/api/lock/rozpis/release', requireLogin, (req, res) => {
  if (rozpis_lock && req.session.user && rozpis_lock.userId === req.session.user.id) rozpis_lock = null;
  res.json({ ok: true });
});

// Rozpisy API
app.post('/api/rozpisy/publish', requireLogin, (req, res) => {
  const { month, year, data } = req.body;
  if (!month || !year || !data) return res.json({ ok: false, msg: 'Chybí data.' });
  const key = `${String(month).padStart(2,'0')}/${year}`;
  const label = `Rozpis ${String(month).padStart(2,'0')}/${year}`;
  const rozpisy = getRozpisy();
  // Remove existing entry for same month/year
  rozpisy.history = rozpisy.history.filter(r => r.key !== key);
  const entry = { key, label, month, year, data, publishedAt: new Date().toISOString(), publishedBy: req.session.user.name };
  // Add to front
  rozpisy.history.unshift(entry);
  // Set as current
  rozpisy.current = key;
  saveRozpisy(rozpisy);
  res.json({ ok: true, label });
});

app.get('/api/rozpisy', requireLogin, (req, res) => {
  const rozpisy = getRozpisy();
  res.json({ current: rozpisy.current, history: rozpisy.history.map(r => ({ key: r.key, label: r.label, publishedAt: r.publishedAt, publishedBy: r.publishedBy })) });
});

app.get('/api/rozpisy/:key', requireLogin, (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const rozpisy = getRozpisy();
  const entry = rozpisy.history.find(r => r.key === key);
  if (!entry) return res.status(404).json({ ok: false });
  res.json({ ok: true, entry });
});

app.post('/api/rozpisy/set-current', requireLogin, (req, res) => {
  const { key } = req.body;
  const rozpisy = getRozpisy();
  if (!rozpisy.history.find(r => r.key === key)) return res.json({ ok: false });
  rozpisy.current = key;
  saveRozpisy(rozpisy);
  res.json({ ok: true });
});

// Pages
app.get('/tvorba-rozpisu', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'rozpis.html')));
app.get('/rozpis-view', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'rozpis-view.html')));
app.use('/static', express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`AVE Portál běží na portu ${PORT}`));
