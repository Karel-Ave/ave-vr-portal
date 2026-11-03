'use strict';
// Vacation balances are kept in hours. A manual balance may contain carryover;
// only changes to the reference year's entitlement are added to that balance.
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const index = (year, month) => Number(year) * 12 + Number(month);
function key(value) {
  const s = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return s.includes('DPP') ? 'DPP' : s.includes('DPC') ? 'DPC' : s.includes('ZPP') ? 'ZPP' : 'HPP';
}
function dayHours(contract) { return {HPP:7.5,ZPP:4.8,DPC:4,DPP:0}[key(contract)]; }
function monthValue(value) {
  if (typeof value === 'string') { const m=value.match(/^(\d{4})-(\d{1,2})/); return m ? {year:+m[1],month:+m[2]} : null; }
  return value && Number.isInteger(+value.year) && +value.month>=1 && +value.month<=12 ? {year:+value.year,month:+value.month} : null;
}
function covers(p,year,month) { const n=index(year,month);return n>=index(p.from_year,p.from_month) && n<=(p.to_year&&p.to_month?index(p.to_year,p.to_month):Infinity); }
function contract(staff,balance,periods,year,month) { return (periods||[]).find(p=>covers(p,year,month))?.contract || staff?.contract || balance?.contract || ''; }
function annual(staff,balance,periods,year) {
  const from=monthValue(staff?.activeFrom),until=monthValue(staff?.activeUntil);
  let sum=0;
  for(let m=1;m<=12;m++) {
    const n=index(year,m);
    if(staff?.inactive || (from&&n<index(from.year,from.month)) || (until&&n>index(until.year,until.month))) continue;
    sum += 20*dayHours(contract(staff,balance,periods,year,m))/12;
  }
  return round(sum);
}
function reference(staff,balance,periods,year) {
  // Legacy manual balances retain their existing contract as the reference.
  return balance?.entitlement_reference_hours != null ? Number(balance.entitlement_reference_hours)
    : annual({...staff,contract:balance?.contract||staff?.contract},balance,periods,year);
}
function totals(staff,balance,periods,year,month,movedHours=0,displayYear=year) {
  const entitlement=annual(staff,balance,periods,year);
  // An old profile may already have been changed without an effective date.
  // Show its current day length, but defer entitlement changes until history is saved.
  const legacyWithoutHistory=balance && balance.entitlement_reference_hours == null && !(periods||[]).length;
  const correction=balance && !legacyWithoutHistory ? round(entitlement-reference(staff,balance,periods,year)) : 0;
  const base=round((balance?Number(balance.base_hours):entitlement)+correction);
  const c=contract(staff,balance,periods,displayYear,month), h=dayHours(c);
  const remaining=round(base+Number(movedHours));
  return {contract:key(c)==='DPC'?'DPČ':c,day_hours:h,base_hours:base,base_days:h?round(base/h):0,remaining_hours:remaining,remaining_days:h?round(remaining/h):0,annual_entitlement_hours:entitlement,entitlement_adjustment_hours:correction};
}
module.exports={round,index,key,dayHours,monthValue,covers,contract,annual,reference,totals};
