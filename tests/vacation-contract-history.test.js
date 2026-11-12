const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const entitlement=require('../vacation-entitlement');
const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
const periods=[{contract:'ZPP',from_year:2000,from_month:1,to_year:2026,to_month:9},{contract:'HPP',from_year:2026,from_month:10,to_year:null,to_month:null}];
test('9 months ZPP and 3 HPP: 109.5 hours minus 67.2 consumed = 42.3 hours, 5.64 current days',()=>{
  const staff={contract:'HPP',activeFrom:'2020-01'},balance={contract:'ZPP',base_hours:96,entitlement_reference_hours:96};
  const result=entitlement.totals(staff,balance,periods,2026,11,-67.2);
  assert.equal(result.annual_entitlement_hours,109.5);assert.equal(result.remaining_hours,42.3);assert.equal(result.remaining_days,5.64);assert.equal(result.day_hours,7.5);assert.equal(result.entitlement_adjustment_hours,13.5);
  assert.equal(entitlement.dayHours(entitlement.contract(staff,balance,periods,2026,9)),4.8);
  assert.equal(entitlement.annual(staff,balance,periods,2027),150);
});
test('manual carryover and zero balance are preserved, repeated reads and saving a revised baseline never add the delta twice',()=>{
  const staff={contract:'ZPP',activeFrom:'2020-01'},manual={contract:'HPP',base_hours:187.5,entitlement_reference_hours:150};
  const changed=[{contract:'HPP',from_year:2000,from_month:1,to_year:2026,to_month:9},{contract:'ZPP',from_year:2026,from_month:10}];
  const before=JSON.stringify(manual);
  for(let i=0;i<3;i++){const result=entitlement.totals(staff,manual,changed,2026,11,-15);assert.equal(result.remaining_hours,159);assert.equal(result.base_hours,174);}
  assert.equal(JSON.stringify(manual),before);
  assert.equal(entitlement.totals(staff,{base_hours:174,entitlement_reference_hours:136.5},changed,2026,11,-15).remaining_hours,159);
  assert.equal(entitlement.totals({contract:'HPP'},{contract:'HPP',base_hours:0},[],2026,11).remaining_hours,0);
});
test('new November starters have only two months entitlement, with activeUntil and DPČ respected',()=>{
  for(const [contract,hours] of [['HPP',25],['ZPP',16],['DPČ',13.33]]) {
    const staff={contract,activeFrom:'2026-11'};
    const result=entitlement.totals(staff,null,[],2026,11);assert.equal(result.remaining_hours,hours);assert.equal(result.remaining_days,3.33);
    assert.equal(entitlement.annual(staff,null,[],2025),0);
    assert.equal(entitlement.annual({...staff,activeUntil:'2026-11'},null,[],2027),0);
  }
});
function setup(){
  const state={user:{username:'BRIS',role:'recepční',perm_overrides:JSON.stringify({other:{keep:1},raspis_staff:{contract:'HPP',login:'BRIS',activeFrom:{year:2020,month:1}}})},balance:{id:12,contract:'ZPP',base_hours:69.6,base_days:14.5,note:'Ručně od srpna',base_from_year:2026},periods:[],movements:[{staff_login:'BRIS',hours_delta:-19.2}]};
  const queries=[];let snapshot;let fail=false;
  const client={async query(sql,p=[]){queries.push({sql,p});
    if(sql==='BEGIN'){snapshot=JSON.stringify(state);return {rows:[]};}
    if(sql==='COMMIT')return {rows:[]};
    if(sql==='ROLLBACK'){Object.assign(state,JSON.parse(snapshot));return {rows:[]};}
    if(sql.includes('FROM users WHERE id'))return {rows:[state.user]};
    if(sql.includes('FROM vacation_contract_periods'))return {rows:state.periods.map(x=>({...x,staff_login:'BRIS'}))};
    if(sql.includes('SELECT * FROM vacation_balance_settings'))return {rows:[{...state.balance}]};
    if(sql.startsWith('UPDATE vacation_balance_settings')){state.balance.entitlement_reference_hours=p[0];state.balance.entitlement_reference_year=p[1];return {rows:[]};}
    if(sql.startsWith('DELETE FROM vacation_contract_periods')){assert.deepEqual(Array.from(p),['BRIS']);state.periods=[];return {rows:[]};}
    if(sql.startsWith('INSERT INTO vacation_contract_periods')){if(fail)throw Error('simulated write failure');state.periods.push({contract:p[1],from_month:p[2],from_year:p[3],to_month:p[4],to_year:p[5]});return {rows:[]};}
    if(sql.startsWith('UPDATE users')){state.user.perm_overrides=p[0];return {rows:[]};}
    throw Error(sql);
  },release(){}};
  let handler;const context={vacationEntitlement:entitlement,Date,console,getPool:()=>({connect:async()=>client}),requireLogin(){},requirePermDefault(){},parsePermOverridesValue:v=>typeof v==='string'?JSON.parse(v):v,syncReceptionistLoginFromUser:async()=>{},app:{put(...a){handler=a.at(-1)}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function vacationContractKey('),source.indexOf('function vacationScheduleKey(')),context);
  vm.runInContext(source.slice(source.indexOf('const protectedUserGroups'),source.indexOf("app.post('/api/users'")),context);
  vm.runInContext(source.slice(source.indexOf("app.put('/api/admin/users/:id/overrides'"),source.indexOf("app.get('/api/admin/logs'")),context);
  return {state,queries,setFail(){fail=true},context,async save(ps,expected=state.periods,role='admin'){let response,status=200;const overrides=JSON.parse(state.user.perm_overrides);overrides.raspis_staff.contract='HPP';await handler({params:{id:33},body:{overrides,contract_periods:ps,expected_contract_periods:expected},session:{user:{id:99,role}}},{json:v=>response=v,status:v=>{status=v;return{json:r=>response=r}}});return {response,status};}};
}
test('admin history save freezes legacy baseline once, preserving manual balance, other permissions and consumed movements',async()=>{
  const f=setup(),before=JSON.stringify(f.state.movements);const result=await f.save(periods);assert.equal(result.response.ok,true);assert.equal(f.state.balance.entitlement_reference_hours,96);assert.equal(f.state.balance.base_hours,69.6);assert.equal(f.state.balance.note,'Ručně od srpna');assert.equal(JSON.parse(f.state.user.perm_overrides).other.keep,1);assert.equal(JSON.stringify(f.state.movements),before);
  const rs=JSON.parse(f.state.user.perm_overrides).raspis_staff;assert.equal(entitlement.totals(rs,f.state.balance,f.state.periods,2026,11).remaining_hours,83.1);
  assert.equal((await f.save(f.state.periods)).response.ok,true);assert.equal(f.state.balance.entitlement_reference_hours,96);assert.equal(f.queries.filter(q=>q.sql.startsWith('UPDATE vacation_balance_settings')).length,1);
});
test('overlap, stale history and a partial database failure all preserve the original data',async()=>{
  for(const failure of ['overlap','stale','write']){const f=setup();const before=JSON.stringify(f.state);if(failure==='write')f.setFail();const result=await f.save(failure==='overlap'?[...periods,{contract:'ZPP',from_year:2026,from_month:11}]:periods,failure==='stale'?periods:[]);assert.equal(result.response.ok,false,failure);assert.equal(JSON.stringify(f.state),before,failure);assert.equal(f.queries.at(-1).sql,'ROLLBACK');}
});
test('delegated VR cannot write protected account overrides, even with user permissions',async()=>{
  const f=setup();
  for (const role of ['admin','vedoucí']) {
    f.state.user.role=role;
    const before=JSON.stringify(f.state);
    assert.equal((await f.save(periods,[],'vedoucí')).status,403);
    assert.equal(JSON.stringify(f.state),before);
    assert.equal(f.queries.at(-1).sql,'ROLLBACK');
  }
});
test('history validation rejects missing dates, invalid contracts, partial end dates and reverse ranges',()=>{
  const f=setup();for(const p of [{contract:'nonsense',from_month:1,from_year:2026},{contract:'HPP',from_month:0,from_year:2026},{contract:'HPP',from_month:5,from_year:2026,to_month:4,to_year:2026},{contract:'HPP',from_month:1,from_year:2026,to_month:4}])assert.throws(()=>f.context.vacationNormalizeContractPeriods([p]));
});
module.exports={setup,periods};

test('legacy changed contract displays the new day length but never guesses its missing effective date',()=>{
  const result=entitlement.totals({contract:'HPP'},{contract:'ZPP',base_hours:69.6},[],2026,11,-19.2);
  assert.equal(result.day_hours,7.5);assert.equal(result.remaining_hours,50.4);assert.equal(result.entitlement_adjustment_hours,0);
});
test('automatic balance creation prorates November starters and never overwrites an existing zero or manual balance',async()=>{
  const statements=[];const db={async query(sql,args){statements.push({sql,args});assert(sql.startsWith('INSERT INTO vacation_balance_settings'));assert(!sql.includes('base_hours ='));assert(!sql.includes('base_days ='));assert(!sql.includes('day_hours ='));return {rows:[{base_hours:args[5]}]};}};
  const ctx={vacationEntitlement:entitlement,vacationContractPeriodsMap:async()=>new Map(),Date:class extends Date{constructor(...args){super(...(args.length?args:['2026-11-03T12:00:00Z']));}}};vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function vacationContractKey('),source.indexOf('function vacationMonthIndex(')),ctx);
  vm.runInContext(source.slice(source.indexOf('async function vacationEnsureBalance('),source.indexOf('function vacationStaffMatchesBalancePeriod(')),ctx);
  for(const [contract,hours] of [['HPP',25],['ZPP',16],['DPČ',13.33]])assert.equal((await ctx.vacationEnsureBalance(db,{login:'NEW',contract,activeFrom:'2026-11'},{id:99})).base_hours,hours);
  assert(statements.every(x=>x.args[8]===2026));
});
