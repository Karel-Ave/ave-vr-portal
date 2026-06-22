const path = require('path');
const XLSX = require('xlsx');
const { getPool } = require('../db');

const excelPath = process.argv[2];
const shouldApply = process.argv.includes('--apply');
const shouldOverwrite = process.argv.includes('--overwrite');

function formatPhoneForStorage(value, login, name) {
  const raw = String(value || '').trim();
  if (!raw || raw === '+') return null;
  let prefix = '+420';
  let rest = raw;
  const match = raw.match(/^\s*(\+\d{1,4})\s*(.*)$/);
  if (match) {
    prefix = match[1];
    rest = match[2] || '';
  } else if (/^421/.test(raw.replace(/\D/g, '')) || /brisud/i.test(String(name || '')) || String(login || '').toUpperCase() === 'BRIS') {
    prefix = '+421';
  }
  let digits = rest.replace(/\D/g, '');
  if (digits.startsWith(prefix.slice(1))) digits = digits.slice(prefix.length - 1);
  if (!digits) return null;
  return `${prefix} ${digits.replace(/(.{3})(?=.)/g, '$1 ')}`.trim();
}

function readPhones(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const phonesByLogin = new Map();

  for (const row of rows) {
    const name = String(row[1] || '').trim();
    const login = String(row[2] || '').trim().toUpperCase();
    const phone = formatPhoneForStorage(row[3], login, name);
    if (!login || login === 'LOGIN' || !phone) continue;
    phonesByLogin.set(login, { name, login, phone });
  }
  return phonesByLogin;
}

function getReceptionistInfo(user) {
  const ov = typeof user.perm_overrides === 'string'
    ? JSON.parse(user.perm_overrides || '{}')
    : (user.perm_overrides || {});
  const staff = ov.raspis_staff || {};
  return {
    login: String(staff.login || user.username || '').trim().toUpperCase(),
    name: String(staff.displayName || user.name || '').trim(),
    active: staff.active === true || !!staff.login
  };
}

async function main() {
  if (!excelPath) {
    throw new Error('Pouziti: node scripts/import-receptionist-phones.js <soubor.xls> [--apply] [--overwrite]');
  }

  const fullPath = path.resolve(excelPath);
  const phonesByLogin = readPhones(fullPath);
  const db = getPool();
  const { rows: users } = await db.query(`
    SELECT id, name, username, phone, role, perm_overrides
      FROM users
     WHERE role = 'recepční'
        OR perm_overrides::text LIKE '%"raspis_staff"%'
     ORDER BY name
  `);

  const missing = [];
  const toUpdate = [];
  const kept = [];

  for (const user of users) {
    const staff = getReceptionistInfo(user);
    if (!staff.active || !staff.login) continue;
    const excel = phonesByLogin.get(staff.login);
    if (!excel) {
      missing.push(`${staff.name || user.name} (${staff.login})`);
      continue;
    }
    const current = String(user.phone || '').trim();
    if (current && current !== excel.phone && !shouldOverwrite) {
      kept.push(`${staff.name || user.name} (${staff.login}): v DB "${current}", Excel "${excel.phone}"`);
      continue;
    }
    if (current !== excel.phone) {
      toUpdate.push({ id: user.id, name: staff.name || user.name, login: staff.login, phone: excel.phone });
    }
  }

  console.log(`Excel telefonu: ${phonesByLogin.size}`);
  console.log(`Recepcni v DB: ${users.length}`);
  console.log(`K aktualizaci: ${toUpdate.length}`);

  if (kept.length) {
    console.log('\nExistujici odlisna cisla ponechana:');
    kept.forEach(item => console.log(`- ${item}`));
  }

  if (missing.length) {
    console.log('\nRecepcni nenalezeni v Excelu:');
    missing.forEach(item => console.log(`- ${item}`));
  }

  if (!shouldApply) {
    console.log('\nZkusebni beh bez zapisu. Pro zapis pridejte --apply.');
    return;
  }

  for (const item of toUpdate) {
    await db.query('UPDATE users SET phone = $1 WHERE id = $2', [item.phone, item.id]);
    console.log(`Ulozeno: ${item.name} (${item.login}) -> ${item.phone}`);
  }
}

main()
  .catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const pool = getPool();
      await pool.end();
    } catch (_) {}
  });
