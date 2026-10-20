const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const locks=require('../public/requirement-xy-locks');
const vacations=require('../public/requirements-vacations');
const html=fs.readFileSync(path.join(__dirname,'../views/raspis-test.html'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');

test('December example blocks only the requested shifts, including next January day',()=>{
  const value=locks.parse('10n, 24d, 24n, 31d, 31n, 1.1.2027d');
  for(const ci of [19,46,47,60,61,62])assert(locks.isLocked(value,12,2026,ci),'locked '+ci);
  for(const ci of [0,1,18,63])assert.equal(locks.isLocked(value,12,2026,ci),false,'unlocked '+ci);
});
test('January night and day are independent; short 1d/1n refer only to December',()=>{
  const night=locks.parse('1.1.2027n');assert(locks.isLocked(night,12,2026,63));assert.equal(locks.isLocked(night,12,2026,62),false);
  assert.equal(locks.isLocked(night,12,2026,1),false);
  const short=locks.parse('1d, 1n');assert(locks.isLocked(short,12,2026,0));assert(locks.isLocked(short,12,2026,1));assert.equal(locks.isLocked(short,12,2026,62),false);assert.equal(locks.isLocked(short,12,2026,63),false);
});
test('full dates match exact month/year and only available calendar columns',()=>{
  const value=locks.parse('1.1.2027d, 24.12.2026n');assert(locks.isLocked(value,1,2027,0));assert.equal(locks.isLocked(value,1,2026,0),false);assert.equal(locks.isLocked(value,11,2026,62),false);assert.equal(locks.isLocked(value,12,2026,64),false);assert.equal(locks.isLocked(value,12,2025,62),false);assert.equal(locks.isLocked(value,12,2026,-1),false);
});
test('legacy ranges, prefixes, separators and stored cells remain supported',()=>{
  const parsed=locks.parse('3d; n3\n5-7 n, d 12, 7–5d');
  for(const key of ['3-d','3-n','5-n','6-n','7-n','12-d','5-d','6-d','7-d'])assert(parsed.cells.includes(key));
  const stored={raw:'3d',cells:['03-d','3-d','31-n']};assert.deepEqual(locks.normalize(stored),{raw:'3d',cells:['3-d','31-n']});
  assert(locks.isLocked(stored,12,2026,4));assert.equal(locks.isLocked(stored,12,2026,62),false);
});
test('full-date rules survive storage normalization, JSON serialization and browser/server wrappers',()=>{
  const raw='10n, 24d, 24n, 31d, 31n, 1.1.2027d, 1.1.2027n';
  const context={requirementXyLocks:locks,window:{AveRequirementXyLocks:locks},state:{month:12,year:2026}};
  vm.createContext(context);
  vm.runInContext(server.slice(server.indexOf('function normalizeReqXyLocks('),server.indexOf('const REQ_RECEPTION_CLOSED_MSG')),context);
  vm.runInContext(html.slice(html.indexOf('function parseRequirementXyLocks('),html.indexOf('function formatReqMeta(')),context);
  context.state.reqXyLocks=JSON.parse(JSON.stringify(context.normalizeReqXyLocks(context.parseRequirementXyLocks(raw))));
  for(const ci of [0,1,19,46,47,60,61,62,63])assert.equal(context.isRequirementXyLocked(ci),context.isReqXyLocked(context.state,ci));
  assert(context.isReqXyLocked(context.state,62));assert(context.isReqXyLocked(context.state,63));assert.equal(context.isReqXyLocked(context.state,0),false);
});
test('invalid entries cannot silently drop a requested date restriction',()=>{
  for(const text of ['31.2.2027d','29.2.2027n','1.13.2027d','0.1.2027d','1.1.2027','1.1.2027x','abc'])assert.throws(()=>locks.parse(text));
  assert.doesNotThrow(()=>locks.parse('29.2.2028d, 1. 1. 2027 N'));
  assert.deepEqual(locks.normalize({cells:['2027-02-31-d','2027-01-01-n','0-d','32-n']}),{raw:'',cells:['2027-01-01-n']});
});
test('server rejects x and y on January spill even if a client bypasses the browser',()=>{
  const context={requirementXyLocks:locks,findVacationStaffIndex:vacations.findStaffIndex,rtReqLimit:(v,f)=>v==null?f:Number(v),getRequirementHotelLetters:()=>new Set(['A']),isSessionUserRequirementStaff:(r,u)=>r.userId===u.id,rtFindLiveRequirementStaff:()=>null,rtRequestNoteKey:r=>r.login};
  vm.createContext(context);
  vm.runInContext(server.slice(server.indexOf('function normalizeReqXyLocks('),server.indexOf('const REQ_RECEPTION_CLOSED_MSG')),context);
  vm.runInContext(server.slice(server.indexOf('function validateRequirementStaffRowValues('),server.indexOf('function updateRequirementMeta(')),context);
  for(const shift of ['d','n'])for(const val of ['x','y']){
    const ci=shift==='d'?62:63;
    const current={month:12,year:2026,staff:[{userId:1,login:'A',reqYLimit:7}],schedule:{},reqXyLocks:locks.parse('1.1.2027'+shift)};
    const incoming={...current,schedule:{['0_'+ci]:val}};
    assert.match(context.mergeRequirementStaffRow(current,incoming,{id:1},0,[],[0]).error,/není možné psát x ani y/);
    incoming.schedule={'0_0':val};assert.equal(context.mergeRequirementStaffRow(current,incoming,{id:1},0,[],[0]).error,undefined);
  }
});
