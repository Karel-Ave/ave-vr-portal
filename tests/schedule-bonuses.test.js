const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const rules=require('../public/schedule-bonus-rules'),{createScheduleBonusService}=require('../schedule-bonuses'),{fixture}=require('./bb.test');
const clone=v=>JSON.parse(JSON.stringify(v));let sequence=0;const uuid=()=>`10000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
function setup(){
 let allowed=true,internalAllowed=true,failWrite=false;
 const bonusService=createScheduleBonusService({canAdd:async()=>allowed,canTouch:async()=>allowed,canInternal:async()=>internalAllowed});
 const f=fixture({bonusService,extraQuery:async(sql,args,state,users)=>{
  const rows=values=>({rows:clone(values)});
  if(sql.includes('schedule_edit_receipts')||sql.includes('schedule_bonus_receipts')){
    const table=sql.includes('schedule_edit_receipts')?'saves':'bonusReceipts';state[table]=state[table]||{};
    if(sql.startsWith('SELECT'))return rows(state[table][args[0]]?[state[table][args[0]]]:[]);
    if(sql.startsWith('INSERT')){if(state[table][args[0]])return rows([]);state[table][args[0]]={user_id:args[1],scope:args[2],payload_hash:args[3],record_id:args[4]};return rows([{id:args[0]}]);}
  }
  if(sql==='SELECT id,name,username,role,perm_overrides FROM users WHERE id=$1')return rows(users.filter(u=>u.id===args[0]));
  if(sql.startsWith('INSERT INTO priplatky_zaznamy')){if(failWrite)throw Error('simulated bonus failure');state.bonuses=state.bonuses||[];const id=(state.bonusSequence||0)+1;state.bonusSequence=id;state.bonuses.push({id,args:clone(args)});return rows([{id}]);}
 }});
 const user=f.users.find(u=>u.id===99);
 let handler;const context={console:{error(){}},requireLogin(){},requirePerm:()=>()=>{},getPool:()=>f.pool,augmentRtDataWithActiveReceptionists:async x=>x,augmentRtDataWithSpecialStaff:async x=>x,syncRtKnownHotelsFromSchedule:async()=>({}),bbService:f.service,scheduleBonusService:bonusService,vacationParseScheduleKey:()=>({month:12,year:2026}),vacationTrySyncScheduleZMovements:async()=>({ok:true}),vacationSyncManualScheduleZRequests:async()=>({ok:true}),broadcastWidgetUpdate(){},app:{post:(route,...fn)=>handler=fn.at(-1)}};
 vm.createContext(context);const src=fs.readFileSync(require.resolve('../server.js'),'utf8');vm.runInContext(src.slice(src.indexOf("app.post('/api/rt/schedules/save-edits'"),src.indexOf('// ── Change log',src.indexOf("app.post('/api/rt/schedules/save-edits'"))),context);
 return {f,bonusService,user,deny(){allowed=false},denyInternal(){internalAllowed=false},fail(){failWrite=true},async vr(body){let result;await handler({body,session:{user}},{json:v=>result=v});return result;}};
}
const item=(userId=11,index=0,value='A')=>({id:uuid(),userId,index,value,amount:500,reason:'Směna navíc',note:'Zástup',internalNote:'Interní',date:'2026-12-01',hotel:value,paymentMonth:12,paymentYear:2026});
test('eligibility excludes every unpaid code and each special row, with exact December/January day/night dates',()=>{
 const person={userId:10,name:'Štěpánek Ondřej',type:'Denní'};
 for(const value of ['P','Q','F','x','y','z','ž','p','q','f','','12'])assert.equal(rules.eligible(value,person),false,value);
 for(const value of ['A','B','W'])assert.equal(rules.eligible(value,person),true);
 for(const name of ['zz Pohotovost','zzz Essence','zzz Theatrino','zzz Waldstein'])assert.equal(rules.eligible('A',{...person,name}),false,name);
 assert.equal(rules.sourceDate(2026,12,62,'vr'),'2027-01-01');assert.equal(rules.sourceDate(2026,12,63,'vr'),'2027-01-01');assert.equal(rules.sourceDate(2026,12,32,'bb'),'2027-01-01');assert.throws(()=>rules.sourceDate(2026,11,60,'vr'));
});
test('VR save writes shifts and bonus together once, preserves other employees and protects retries after manual bonus deletion',async()=>{
 const {f,vr}=setup(),key='RT:12/2026';await f.storeVr(f.vr({'0_0':'A','0_2':'B'}));const next=f.vr({'1_0':'A','0_2':'B'}),body={key,data:next,saveId:uuid(),bonuses:[item()]};
 assert.equal((await vr(body)).ok,true);assert.equal(f.state.bonuses.length,1);assert.equal(f.state.bonuses[0].args[2],'B');assert.equal(f.state.bonuses[0].args[5],500);assert.equal(f.state.schedules[key].schedule['0_2'],'B');
 const after=JSON.stringify(f.state);assert.equal((await vr(body)).ok,true);assert.equal(JSON.stringify(f.state),after);
 f.state.bonuses=[];assert.equal((await vr(body)).ok,true);assert.equal(f.state.bonuses.length,0);assert.equal(f.state.schedules[key].schedule['1_0'],'A');
 const later={key,data:f.vr({'1_0':'A','1_4':'B','0_2':'B'}),saveId:uuid(),bonuses:[item(11,4,'B')]};assert.equal((await vr(later)).ok,true);assert.equal(f.state.bonuses.length,1);assert.equal(f.state.schedules[key].schedule['1_0'],'A');
});
test('a bonus failure, forbidden user or excluded code rolls the entire VR change back',async()=>{
 for(const mode of ['write','permission','internal','unchanged','excluded']){
  const s=setup(),{f}=s,key='RT:12/2026';await f.storeVr(f.vr({'0_0':'A'}));const before=JSON.stringify(f.state);
  if(mode==='write')s.fail();if(mode==='permission')s.deny();if(mode==='internal')s.denyInternal();
  const value=mode==='excluded'?'P':'A',uid=mode==='unchanged'?10:11,bonus=item(uid,0,value),data=f.vr(mode==='unchanged'?{'0_0':'A'}:{'1_0':value});
  const result=await s.vr({key,data,saveId:uuid(),bonuses:[bonus]});assert.equal(result.ok,false,mode);assert.equal(JSON.stringify(f.state),before,mode);
 }
});
test('BB save includes its W bonus atomically, retries before revision checks, and rejects a later conflicting shift without adding a bonus',async()=>{
 const {f}=setup();await f.create();assert.equal((await f.publish()).ok,true);const e=f.state.months['2026-12'];
 const body={month:12,year:2026,revision:e.published_revision,saveId:uuid(),data:{staffIds:[1,2],cells:{'1-2':'W'}},bonuses:[{...item(1,2,'W'),date:'2026-12-02'}]};
 assert.equal((await f.call('/api/bb/schedule',body)).ok,true);assert.equal(f.state.bonuses.length,1);const after=JSON.stringify(f.state);assert.equal((await f.call('/api/bb/schedule',body)).ok,true);assert.equal(JSON.stringify(f.state),after);
 const bad={...body,saveId:uuid(),revision:f.state.months['2026-12'].published_revision,data:{staffIds:[1,2],cells:{'1-2':'W','2-2':'W'}},bonuses:[item(2,2,'W')]};assert.equal((await f.call('/api/bb/schedule',bad)).ok,false);assert.equal(JSON.stringify(f.state),after);
});
test('Jan 1 bonus in December keeps December payroll and supports manually changed actual date and amount',async()=>{
 const {f,vr}=setup(),key='RT:12/2026';await f.storeVr(f.vr({}));const bonus={...item(11,62,'A'),date:'2027-01-01',amount:850};assert.equal((await vr({key,data:f.vr({'1_62':'A'}),saveId:uuid(),bonuses:[bonus]})).ok,true);assert.deepEqual(f.state.bonuses[0].args.slice(0,6),[2026,12,'B','2027-01-01','A',850]);
});
