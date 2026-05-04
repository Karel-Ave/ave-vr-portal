const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(__dirname, 'data', 'users.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));

if (!fs.existsSync(DATA_FILE)) {
  const users = [
    { id: 1, name: 'Karel', username: 'Karel-Ave', password: bcrypt.hashSync('Karel.AVE', 10), role: 'admin' },
    { id: 2, name: 'Adam', username: 'Adam-Ave', password: bcrypt.hashSync('Adam.AVE', 10), role: 'user' },
    { id: 3, name: 'Matej', username: 'Matej-Ave', password: bcrypt.hashSync('Matej.AVE', 10), role: 'user' }
  ];
  fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

function getUsers() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function saveUsers(u) { fs.writeFileSync(DATA_FILE, JSON.stringify(u, null, 2)); }

app.use(express.json());
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

app.get('/rozpis', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'rozpis.html')));
app.use('/static', express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`AVE Portál běží na portu ${PORT}`));
