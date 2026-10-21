const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
const newcomers=['BEN','CABV','SICK','SLUN'].map((login,i)=>({userId:i+1,login,name:login,type:'Denní',contract:'HPP',activeFrom:'2026-11'}));
const staff=[...newcomers,{userId:5,login:'OLD',contract:'HPP',activeFrom:'2026-01'},{userId:6,login:'DPP',contract:'DPP',activeFrom:'2026-11'},{userId:7,login:'NEXT',contract:'HPP',activeFrom:'2027-01'},{userId:8,login:'LEFT',contract:'HPP',activeFrom:'2026-02',activeUntil:'2026-09'}];
const saved={id:42,staff_user_id:1,staff_login:'BEN',staff_name:'BEN',contract:'HPP',base_days:3,base_hours:22.5,day_hours:7.5,base_from_month:11,base_from_year:2026,note:'Ruční nastavení',moved_days:-1,moved_hours:-7.5};
function setup(manager=true,userId=99){
  let handler;const queries=[];
  const db={async query(sql,params){queries.push({sql,params});assert(sql.trim().startsWith('SELECT'),'display must not introduce writes');return {rows:sql.includes('SELECT b.*')&&params[0].includes('BEN')?[{...saved}]:[]};}};
  const context={Date:class extends Date{constructor(...args){super(...(args.length?args:['2026-10-21T12:00:00Z']));}},vacationBackfillApprovedRequestMovements:async()=>{},canManageVacationsServer:async()=>manager,vacationCanManageBalances:async()=>manager,loadRtPortalReceptionists:async()=>staff,vacationContractPeriodsMap:async()=>new Map(),vacationBalanceMovementSubquery:()=> 'SELECT * FROM vacation_movements',vacationAnnualEntitlementFromPeriods:()=>150,vacationStaffSort:(a,b)=>a.staff_login.localeCompare(b.staff_login),getPool:()=>db,requireLogin(){},app:{get(...args){handler=args.at(-1)}},console};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function rtStaffMonthValue('),source.indexOf('function rtNormalizeStaffName(')),context);
  vm.runInContext(source.slice(source.indexOf('function rtIsStaffActiveForMonth('),source.indexOf('function rtReqLimit(')),context);
  vm.runInContext(source.slice(source.indexOf('function vacationContractKey('),source.indexOf('function vacationMonthIndex(')),context);
  vm.runInContext(source.slice(source.indexOf('function vacationStaffMatchesBalancePeriod('),source.indexOf("app.post('/api/vacations/balances/base-from',")),context);
  return {context,queries,async load(query){let result;await handler({query,session:{user:{id:userId,username:staff.find(s=>s.userId===userId)?.login||'ADMIN'}}},{json(v){result=v;},status(){throw Error('Unexpected API error');}});return result;}};
}

test('November and December expose all four November starters, October does not',async()=>{
  const fixture=setup();for(const month of [11,12]){const result=await fixture.load({month:String(month),year:'2026'});for(const person of newcomers)assert(result.balances.some(b=>b.staff_login===person.login),person.login);assert(!result.balances.some(b=>['NEXT','LEFT','DPP'].includes(b.staff_login)));}
  const october=await fixture.load({month:'10',year:'2026'});assert.deepEqual(Array.from(october.balances,b=>b.staff_login),['OLD']);
});
test('all months includes people active at any time of the selected year, including future starters',async()=>{
  const fixture=setup();const result=await fixture.load({month:'all',year:'2026'});for(const login of ['BEN','CABV','SICK','SLUN','OLD','LEFT'])assert(result.balances.some(b=>b.staff_login===login));assert(!result.balances.some(b=>['NEXT','DPP'].includes(b.staff_login)));assert((await fixture.load({month:'all',year:'2027'})).balances.some(b=>b.staff_login==='NEXT'));assert.equal((await fixture.load({month:'all',year:'2025'})).balances.length,0);
});
test('saved manual amounts, dates and notes do not change with the display filter',async()=>{
  const fixture=setup();for(const month of ['11','12','all']){const result=await fixture.load({month,year:'2026'});const ben=result.balances.find(b=>b.staff_login==='BEN');for(const field of ['id','base_days','base_hours','base_from_month','base_from_year','note'])assert.equal(ben[field],saved[field]);assert.equal(ben.remaining_days,2);assert.equal(ben.remaining_hours,15);}
  assert.equal(saved.base_days,3);assert(fixture.queries.every(q=>q.sql.trim().startsWith('SELECT')));
});
test('recepční remains limited to own balance even when requesting a future period',async()=>{
  const fixture=setup(false,1);const result=await fixture.load({month:'11',year:'2026'});assert.deepEqual(Array.from(result.balances,b=>b.staff_login),['BEN']);assert.equal(result.manager,false);assert.equal((await fixture.load({month:'10',year:'2026'})).balances.length,0);
});
test('period matching retains current-month defaults and respects inclusive start/end boundaries',()=>{
  const {context}=setup();const match=context.vacationStaffMatchesBalancePeriod;assert.equal(match(newcomers[0],{}),false);assert.equal(match(staff[4],{}),true);assert.equal(match({activeFrom:{month:11,year:2026},activeUntil:'2026-11'},{month:'11',year:'2026'}),true);assert.equal(match({activeFrom:'2026-11',activeUntil:'2026-11'},{month:'12',year:'2026'}),false);assert.equal(match({inactive:true},{month:'all',year:'2026'}),false);
});
