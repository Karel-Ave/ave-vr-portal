const {test}=require('node:test');
const assert=require('node:assert/strict');
const {projectVacations,prepareVacationSave,findStaffIndex,cellKey}=require('../public/requirements-vacations');
const copy=x=>JSON.parse(JSON.stringify(x));
const staff=[{userId:10,login:'ALFA',name:'Stejné jméno',type:'Denní'},{userId:20,login:'BETA',name:'Stejné jméno',type:'Noční'},{userId:30,login:'GAMA',type:'Obojí'}];
const base=()=>({month:11,year:2026,staff:copy(staff),schedule:{'0_0':'x','0_2':'y','0_4':'A','1_1':'B','1_3':'x','2_0':'C','0_8':'z','0_10':'ž'},monthlyData:{'2026-10':{schedule:{'0_0':'Q'}},'2026-11':{fondHpp:'168'}},reqNotes:{ALFA:{note:'ponechat'}},hotels:[{letter:'A'}]});
const vacation=(id=10,days=['2026-11-01','2026-11-02','2026-11-03'])=>({id,staff_user_id:id,staff_login:staff.find(s=>s.userId===id)?.login,status:'approved',month:11,year:2026,days_json:JSON.stringify(days)});
test('exact identity and dates: override x/y/hotel; retain other staff, notes, settings and months',()=>{
 const data=base();projectVacations(data,[vacation()]);assert.deepEqual(data.schedule,{...base().schedule,'0_0':'z','0_2':'z','0_4':'z'});assert.equal(data.automaticVacations.length,3);assert.equal(data.monthlyData['2026-10'].schedule['0_0'],'Q');assert.equal(data.monthlyData['2026-11'].fondHpp,'168');assert.deepEqual(data.reqNotes,base().reqNotes);
 const first=copy(data);projectVacations(data,[vacation()]);assert.deepEqual(data,first);
});
test('previously approved vacations populate a newly created empty month; undated/pending/other month/year ignored',()=>{
 const data=base();data.schedule={};projectVacations(data,[vacation(),{...vacation(),status:'pending'},{...vacation(20),days_json:'[]',days_count:5},{...vacation(20),year:2027},{...vacation(20),month:12}]);assert.deepEqual(data.schedule,{'0_0':'z','0_2':'z','0_4':'z'});
});
test('night staff use night columns and mixed staff follow existing day-column vacation convention',()=>{
 const data=base();projectVacations(data,[vacation(20,['2026-11-01']),vacation(30,['2026-11-01'])]);assert.equal(data.schedule['1_1'],'z');assert.equal(data.schedule['1_0'],undefined);assert.equal(data.schedule['2_0'],'z');assert.equal(data.schedule['2_1'],undefined);
});
test('overlap is idempotent; cancellation and rescheduling restore only automatic values, keeping manual z and ž',()=>{
 const data=base();const before=copy(data.schedule);projectVacations(data,[vacation(),{...vacation(),id:99}]);projectVacations(data,[vacation(10,['2026-11-03'])]);assert.equal(data.schedule['0_0'],'x');assert.equal(data.schedule['0_2'],'y');assert.equal(data.schedule['0_4'],'z');projectVacations(data,[]);assert.deepEqual(data.schedule,before);
});
test('identity survives row reorder and login/name change; duplicate or conflicting identities never target someone else',()=>{
 const data=base();projectVacations(data,[vacation()]);data.staff=[staff[1],{...staff[0],login:'NEW'},staff[2]];data.schedule={'1_0':'z','1_2':'z','1_4':'z','0_1':'B'};projectVacations(data,[]);assert.equal(data.schedule['1_0'],'x');assert.equal(data.schedule['0_1'],'B');
 assert.equal(findStaffIndex(staff,{staff_user_id:999,staff_login:'ALFA'}),-1);assert.equal(findStaffIndex([...staff,{...staff[0]}],vacation()),-1);assert.equal(findStaffIndex(staff,{staff_name:'Stejné jméno'}),-1);
 assert.equal(findStaffIndex([{login:'ALFA'}],vacation()),0);assert.equal(findStaffIndex(staff,{staff_user_id:10,staff_login:'BETA'}),0);
});
test('invalid/out-of-month dates and unknown staff do not create cells; December never touches January spill columns',()=>{
 const data=base();projectVacations(data,[vacation(10,['2026-11-31','2026-12-01','2027-11-01','invalid']),vacation(999)]);assert.deepEqual(data.schedule,base().schedule);
 const december={...base(),month:12,schedule:{'0_62':'A'}};projectVacations(december,[{...vacation(10,['2026-12-31','2027-01-01']),month:12}]);assert.equal(december.schedule['0_60'],'z');assert.equal(december.schedule['0_62'],'A');
});
test('stale saves cannot undo approval or resurrect canceled z, nor overwrite a newer underlying manual value',()=>{
 const stored=base(),stale=copy(stored);projectVacations(stored,[vacation()]);prepareVacationSave(stale,stored);projectVacations(stale,[vacation()],stored);assert.equal(stale.schedule['0_4'],'z');
 const browser=copy(stored);projectVacations(stored,[]);stored.schedule['0_4']='B';prepareVacationSave(browser,stored);projectVacations(browser,[],stored);assert.equal(browser.schedule['0_4'],'B');assert.equal(browser.schedule['0_0'],'x');assert.equal(browser.schedule['0_8'],'z');
});
test('preparation handles a differently sorted browser without index-based writes',()=>{
 const stored=base();projectVacations(stored,[vacation()]);const browser=copy(stored);browser.staff=[staff[1],staff[0],staff[2]];browser.schedule={'1_0':'z','1_2':'z','1_4':'z','0_1':'B'};prepareVacationSave(browser,stored);projectVacations(browser,[vacation()],stored);assert.equal(browser.schedule['1_0'],'z');assert.equal(browser.schedule['0_1'],'B');assert.equal(cellKey(browser,browser.automaticVacations[0]),'1_0');
});
