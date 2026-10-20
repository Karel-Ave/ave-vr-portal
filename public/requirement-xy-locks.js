(function () {
  'use strict';
  function dateKey(year, month, day) {
    const y = Number(year), m = Number(month), d = Number(day);
    if (!Number.isInteger(y) || y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function parse(raw) {
    const text = String(raw || '').trim();
    const cells = new Set();
    const addRange = (from, to, shift) => {
      const a = Math.max(1, Math.min(31, Number(from)));
      const b = Math.max(1, Math.min(31, Number(to || from)));
      for (let day = Math.min(a, b); day <= Math.max(a, b); day++) cells.add(`${day}-${shift}`);
    };
    text.split(/[,;\n]+/).map(p => p.trim().toLowerCase()).filter(Boolean).forEach(part => {
      let match = part.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s*[-\s]?(d|n)$/);
      if (match) {
        const date = dateKey(match[3], match[2], match[1]);
        if (!date) throw new Error(`Neplatné datum v zákazu x/y: ${part}`);
        cells.add(`${date}-${match[4]}`);
        return;
      }
      match = part.match(/^(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*[-\s]?(d|n)$/);
      if (match) { addRange(match[1], match[2], match[3]); return; }
      match = part.match(/^(d|n)\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?$/);
      if (match) { addRange(match[2], match[3], match[1]); return; }
      throw new Error(`Neplatný zápis v zákazu x/y: ${part}. Použijte například 10n nebo 1.1.2027d.`);
    });
    return { raw: text, cells: [...cells] };
  }
  function normalize(raw) {
    const locks = raw && typeof raw === 'object' ? raw : {};
    const cells = new Set();
    for (const value of Array.isArray(locks.cells) ? locks.cells : []) {
      const key = String(value || '').trim().toLowerCase();
      let match = key.match(/^(\d{1,2})-(d|n)$/);
      if (match && Number(match[1]) >= 1 && Number(match[1]) <= 31) cells.add(`${Number(match[1])}-${match[2]}`);
      match = key.match(/^(\d{4})-(\d{2})-(\d{2})-(d|n)$/);
      if (match) {
        const date = dateKey(match[1], match[2], match[3]);
        if (date) cells.add(`${date}-${match[4]}`);
      }
    }
    return {raw: String(locks.raw || ''), cells: [...cells]};
  }
  function isLocked(locks, month, year, index) {
    const m = Number(month), y = Number(year), ci = Number(index);
    if (!dateKey(y, m, 1) || !Number.isInteger(ci) || ci < 0) return false;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (ci >= (days + (m === 12 ? 1 : 0)) * 2) return false;
    const spill = ci >= days * 2;
    const day = spill ? 1 : Math.floor(ci / 2) + 1;
    const shift = ci % 2 ? 'n' : 'd';
    const date = dateKey(spill ? y + 1 : y, spill ? 1 : m, day);
    const cells = normalize(locks).cells;
    // Short entries refer only to the selected month, never the January spill.
    return cells.includes(`${date}-${shift}`) || (!spill && cells.includes(`${day}-${shift}`));
  }
  const api = {parse, normalize, isLocked};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.AveRequirementXyLocks = api;
})();
