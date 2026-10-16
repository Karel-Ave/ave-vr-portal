(function () {
'use strict';

// Automatic vacation cells retain their original values separately. Identity is
// resolved anew on every projection, never by a stored table row number or name.
function findStaffIndex(staff, person) {
  const rows = Array.isArray(staff) ? staff : [];
  const id = person?.userId ?? person?.staff_user_id;
  const login = String(person?.login ?? person?.staff_login ?? '').trim().toUpperCase();
  if (id != null && id !== '') {
    const ids = rows.map((row, index) => ({row, index})).filter(({row}) => row?.userId != null && String(row.userId) === String(id));
    if (ids.length) return ids.length === 1 ? ids[0].index : -1;
  }
  const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => {
    if (id != null && id !== '' && row?.userId != null && row.userId !== '') return String(row.userId) === String(id);
    return login && String(row?.login || row?.username || '').trim().toUpperCase() === login;
  });
  return matches.length === 1 ? matches[0].index : -1;
}
function cellKey(data, record) {
  if (!record || Number(record.year) !== Number(data.year) || Number(record.month) !== Number(data.month)) return null;
  const day = Number(record.day);
  if (!Number.isInteger(day) || day < 1 || day > new Date(Date.UTC(Number(data.year), Number(data.month), 0)).getUTCDate()) return null;
  if (record.shift !== 'd' && record.shift !== 'n') return null;
  const si = findStaffIndex(data.staff, record);
  return si < 0 ? null : `${si}_${(day - 1) * 2 + (record.shift === 'n' ? 1 : 0)}`;
}
function syncMonthlySchedule(data) {
  data.monthlyData = data.monthlyData && typeof data.monthlyData === 'object' ? data.monthlyData : {};
  const key = `${data.year}-${data.month}`;
  data.monthlyData[key] = { ...(data.monthlyData[key] || {}), schedule: { ...data.schedule } };
}
function projectVacations(data, vacations, previous = data) {
  const old = Array.isArray(previous.automaticVacations) ? previous.automaticVacations : [];
  data.schedule = data.schedule && typeof data.schedule === 'object' ? data.schedule : {};
  for (const record of old) {
    const key = cellKey(data, record);
    if (key && String(data.schedule[key] || '').trim().toLowerCase() === 'z') {
      if (record.value) data.schedule[key] = record.value;
      else delete data.schedule[key];
    }
  }
  const records = new Map();
  for (const vacation of vacations || []) {
    if (vacation.status !== 'approved' || Number(vacation.month) !== Number(data.month) || Number(vacation.year) !== Number(data.year)) continue;
    const si = findStaffIndex(data.staff, vacation);
    if (si < 0) continue; // Ambiguous, deleted or unmatched identity: never guess.
    const staff = data.staff[si];
    const type = String(staff.type || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const shifts = type.includes('noc') ? ['n'] : (type.includes('den') || type.includes('oboj')) ? ['d'] : [];
    let days = vacation.days ?? vacation.days_json;
    if (typeof days === 'string') { try { days = JSON.parse(days); } catch { days = []; } }
    for (const date of Array.isArray(days) ? days : []) {
      const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match || Number(match[1]) !== Number(data.year) || Number(match[2]) !== Number(data.month)) continue;
      for (const shift of shifts) {
        const record = { userId: staff.userId || null, login: staff.login || staff.username || '', year: Number(data.year), month: Number(data.month), day: Number(match[3]), shift };
        const key = cellKey(data, record);
        if (!key) continue;
        if (!records.has(key)) records.set(key, { ...record, value: data.schedule[key] || '' });
        data.schedule[key] = 'z';
      }
    }
  }
  data.automaticVacations = [...records.values()];
  syncMonthlySchedule(data);
  return data;
}
// A stale browser must not write its old automatic z back after cancellation,
// or restore an old x/hotel over a more recent manual change on the server.
function prepareVacationSave(incoming, current) {
  const records = [
    ...(Array.isArray(incoming.automaticVacations) ? incoming.automaticVacations : []),
    ...(Array.isArray(current.automaticVacations) ? current.automaticVacations : [])
  ];
  incoming.schedule = incoming.schedule && typeof incoming.schedule === 'object' ? incoming.schedule : {};
  for (const record of records) {
    const target = cellKey(incoming, record);
    const source = cellKey(current, record);
    if (!target || !source) continue;
    if (current.schedule?.[source]) incoming.schedule[target] = current.schedule[source];
    else delete incoming.schedule[target];
  }
  incoming.automaticVacations = Array.isArray(current.automaticVacations) ? current.automaticVacations : [];
  syncMonthlySchedule(incoming);
  return incoming;
}
const api = { findStaffIndex, cellKey, projectVacations, prepareVacationSave };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.AveRequirementVacations = api;

})();
