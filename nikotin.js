const path = require('path');

const INITIAL_PLAN = { start: '2026-10-16', end: '2026-10-18', morning: 15, breaks: [30, 30] };

async function migrateNikotin(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS nikotin_plans (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    start_date DATE NOT NULL, end_date DATE NOT NULL,
    morning_minutes INTEGER NOT NULL CHECK (morning_minutes BETWEEN 1 AND 600),
    break_minutes JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    seed_key TEXT, CHECK (end_date >= start_date), UNIQUE(user_id, start_date), UNIQUE(user_id, seed_key)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS nikotin_days (
    user_id INTEGER NOT NULL REFERENCES users(id), day DATE NOT NULL,
    plan_id INTEGER NOT NULL REFERENCES nikotin_plans(id), tasks JSONB NOT NULL,
    statuses JSONB NOT NULL, puffs INTEGER CHECK (puffs >= 0),
    velo INTEGER CHECK (velo >= 0), note TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id, day)
  )`);
}

function pragueDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
}
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function nextDay(day) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
function tasksForPlan(plan) {
  return [{ kind: 'morning', minutes: plan.morning_minutes }, ...plan.break_minutes.map(minutes => ({ kind: 'break', minutes }))];
}
function completeDay(day) {
  return !!day && day.puffs !== null && day.velo !== null && day.statuses.length === day.tasks.length && day.statuses.every(s => s === 'done' || s === 'missed');
}
function activeDay(plans, days, today) {
  const byDay = new Map(days.map(day => [day.day, day]));
  for (const plan of plans) {
    for (let day = plan.start_date; day <= plan.end_date && day <= today; day = nextDay(day)) {
      if (!completeDay(byDay.get(day))) return day;
    }
  }
  return null;
}
function invalid(message) { const err = new Error(message); err.status = 400; throw err; }
function validatePlan(body) {
  const { start_date, end_date, morning_minutes, break_minutes } = body;
  if (!dateValue(start_date) || !dateValue(end_date) || end_date < start_date || (Date.parse(end_date) - Date.parse(start_date)) / 86400000 > 365) invalid('Zadejte platné období nejvýše 366 dní.');
  if (!Number.isInteger(morning_minutes) || morning_minutes < 1 || morning_minutes > 600) invalid('Ranní pauza musí mít 1 až 600 minut.');
  if (!Array.isArray(break_minutes) || break_minutes.length > 12 || break_minutes.some(v => !Number.isInteger(v) || v < 1 || v > 600)) invalid('Zadejte nejvýše 12 pauz po 1 až 600 minutách.');
  return { start_date, end_date, morning_minutes, break_minutes };
}
function validateDay(body, tasks) {
  if (!Array.isArray(body.statuses) || body.statuses.length !== tasks.length || body.statuses.some(v => v !== null && v !== 'done' && v !== 'missed')) invalid('Neplatný stav úkolů.');
  for (const key of ['puffs', 'velo']) {
    if (body[key] !== null && (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > 1000000)) invalid('Spotřeba musí být celé nezáporné číslo, nebo prázdná hodnota.');
  }
  if (typeof body.note !== 'string' || body.note.length > 10000) invalid('Poznámka může mít nejvýše 10 000 znaků.');
}
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return '"' + (/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"';
}
function exportCsv(days) {
  return '\uFEFF' + [['Datum', 'Splněno', 'Úkolů', 'Puffy', 'Velo', 'Poznámka'], ...days.map(d => [d.day, d.statuses.filter(s => s === 'done').length, d.tasks.length, d.puffs, d.velo, d.note])].map(row => row.map(csvCell).join(';')).join('\r\n');
}
function registerNikotin(app, { getPool, getUserEffectivePerms }) {
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (!err.status) console.error('Nikotin:', err.message);
      res.status(err.status || 500).json({ ok: false, msg: err.status ? err.message : 'Uložení nebo načtení se nepodařilo. Zkuste to znovu.' });
    }
  };
  const guard = async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.session?.user) return res.status(401).json({ ok: false, msg: 'Přihlaste se.' });
    try {
      // Recheck the stored role so an old session cannot retain admin access.
      const { rows } = await getPool().query('SELECT id, role FROM users WHERE id = $1', [req.session.user.id]);
      const user = rows[0];
      if (!user || user.role !== 'admin') return res.status(403).json({ ok: false, msg: 'Přístup má pouze administrátor.' });
      const { groupPerms, userOv } = await getUserEffectivePerms(user);
      const enabled = userOv.nikotin?.enabled ?? groupPerms.nikotin?.enabled ?? true;
      if (enabled !== true) return res.status(403).json({ ok: false, msg: 'Modul není povolen.' });
      req.nikotinUserId = user.id;
      next();
    } catch (err) { res.status(500).json({ ok: false, msg: 'Přístup se nepodařilo ověřit.' }); }
  };
  const plansQuery = `SELECT id, start_date::text, end_date::text, morning_minutes, break_minutes FROM nikotin_plans WHERE user_id = $1 ORDER BY start_date`;
  const daysQuery = `SELECT day::text, plan_id, tasks, statuses, puffs, velo, note, updated_at FROM nikotin_days WHERE user_id = $1 ORDER BY day`;
  app.get('/nikotin', guard, (req, res) => res.sendFile(path.join(__dirname, 'views', 'nikotin.html')));
  app.use('/api/nikotin', guard);
  app.get('/api/nikotin', wrap(async (req, res) => {
    const db = getPool(), userId = req.nikotinUserId;
    await db.query(`INSERT INTO nikotin_plans (user_id, start_date, end_date, morning_minutes, break_minutes, seed_key)
      VALUES ($1,$2,$3,$4,$5,'initial-2026') ON CONFLICT (user_id,seed_key) DO NOTHING`, [userId, INITIAL_PLAN.start, INITIAL_PLAN.end, INITIAL_PLAN.morning, JSON.stringify(INITIAL_PLAN.breaks)]);
    const [plans, days] = await Promise.all([db.query(plansQuery, [userId]), db.query(daysQuery, [userId])]);
    const today = pragueDay();
    res.json({ ok: true, today, plans: plans.rows, days: days.rows, active_day: activeDay(plans.rows, days.rows, today) });
  }));
  app.get('/api/nikotin/export.csv', wrap(async (req, res) => {
    const { rows } = await getPool().query(daysQuery, [req.nikotinUserId]);
    res.set('Content-Disposition', 'attachment; filename="nikotin.csv"').type('text/csv; charset=utf-8').send(exportCsv(rows));
  }));
  app.put('/api/nikotin/days/:day', wrap(async (req, res) => {
    const day = req.params.day, userId = req.nikotinUserId;
    if (!dateValue(day) || day > pragueDay()) invalid('Budoucí den zatím nelze vyplnit.');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [userId]);
      const saved = await client.query('SELECT * FROM nikotin_days WHERE user_id=$1 AND day=$2', [userId, day]);
      let planId = saved.rows[0]?.plan_id, tasks = saved.rows[0]?.tasks;
      if (!tasks) {
        const { rows } = await client.query('SELECT * FROM nikotin_plans WHERE user_id=$1 AND start_date <= $2 AND end_date >= $2', [userId, day]);
        if (!rows.length) invalid('Pro tento den není nastaven plán.');
        planId = rows[0].id; tasks = tasksForPlan(rows[0]);
      }
      validateDay(req.body, tasks);
      const { rows } = await client.query(`INSERT INTO nikotin_days (user_id,day,plan_id,tasks,statuses,puffs,velo,note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id,day) DO UPDATE SET
        statuses=EXCLUDED.statuses,puffs=EXCLUDED.puffs,velo=EXCLUDED.velo,note=EXCLUDED.note,updated_at=NOW()
        RETURNING day::text,plan_id,tasks,statuses,puffs,velo,note,updated_at`,
      [userId, day, planId, JSON.stringify(tasks), JSON.stringify(req.body.statuses), req.body.puffs, req.body.velo, req.body.note]);
      await client.query('COMMIT');
      res.json({ ok: true, day: rows[0] });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }));
  async function savePlan(req, res) {
    const plan = validatePlan(req.body), userId = req.nikotinUserId;
    const id = req.params.id ? Number(req.params.id) : null;
    if (req.params.id && (!Number.isInteger(id) || id < 1)) invalid('Neplatný plán.');
    if (plan.start_date <= pragueDay()) invalid('Upravovat lze pouze budoucí plány.');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [userId]);
      if (id) {
        const { rows } = await client.query('SELECT start_date::text FROM nikotin_plans WHERE user_id=$1 AND id=$2', [userId, id]);
        if (!rows.length || rows[0].start_date <= pragueDay()) invalid('Probíhající ani minulý plán nelze změnit.');
        const days = await client.query('SELECT 1 FROM nikotin_days WHERE user_id=$1 AND plan_id=$2 LIMIT 1', [userId, id]);
        if (days.rows.length) invalid('Plán s uloženými záznamy nelze změnit.');
      }
      const overlap = await client.query('SELECT 1 FROM nikotin_plans WHERE user_id=$1 AND start_date <= $3 AND end_date >= $2 AND ($4::integer IS NULL OR id <> $4)', [userId, plan.start_date, plan.end_date, id]);
      if (overlap.rows.length) invalid('Období se překrývá s jiným plánem.');
      const values = [userId, plan.start_date, plan.end_date, plan.morning_minutes, JSON.stringify(plan.break_minutes)];
      if (id) await client.query('UPDATE nikotin_plans SET start_date=$2,end_date=$3,morning_minutes=$4,break_minutes=$5 WHERE user_id=$1 AND id=$6', [...values,id]);
      else await client.query('INSERT INTO nikotin_plans (user_id,start_date,end_date,morning_minutes,break_minutes) VALUES ($1,$2,$3,$4,$5)', values);
      await client.query('COMMIT'); res.json({ ok: true });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }
  app.post('/api/nikotin/plans', wrap(savePlan));
  app.put('/api/nikotin/plans/:id', wrap(savePlan));
}
module.exports = { migrateNikotin, registerNikotin, pragueDay, dateValue, nextDay, tasksForPlan, completeDay, activeDay, validatePlan, validateDay, exportCsv };
