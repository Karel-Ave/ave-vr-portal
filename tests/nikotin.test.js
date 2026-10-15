const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { registerNikotin, pragueDay, nextDay, dateValue, tasksForPlan, completeDay, activeDay, validatePlan, validateDay, exportCsv, migrateNikotin } = require('../nikotin');
const plan = { id: 1, start_date: '2026-10-16', end_date: '2026-10-18', morning_minutes: 15, break_minutes: [30, 30] };
const filled = day => ({ day, tasks: tasksForPlan(plan), statuses: ['done', 'missed', 'done'], puffs: 0, velo: 0, note: '' });

test('Prague midnight, unfinished yesterday and zero consumption', () => {
  assert.equal(pragueDay(new Date('2026-10-16T22:30:00Z')), '2026-10-17');
  assert.equal(pragueDay(new Date('2026-12-16T23:30:00Z')), '2026-12-17');
  assert.equal(activeDay([plan], [], '2026-10-15'), null);
  assert.equal(activeDay([plan], [], '2026-10-17'), '2026-10-16');
  assert.equal(activeDay([plan], [{ ...filled('2026-10-16'), puffs: null }], '2026-10-17'), '2026-10-16');
  assert.equal(activeDay([plan], [filled('2026-10-16')], '2026-10-16'), null);
  assert.equal(activeDay([plan], [filled('2026-10-16')], '2026-10-17'), '2026-10-17');
  assert.equal(activeDay([plan], ['16', '17', '18'].map(d => filled('2026-10-' + d)), '2026-10-19'), null);
  assert(completeDay(filled('2026-10-16')));
  assert(!completeDay({ ...filled('2026-10-16'), velo: null }));
  assert(!dateValue('2026-02-30')); assert(!dateValue('2026-13-01'));
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
});

test('input validation and CSV preserve missing versus zero', () => {
  assert.doesNotThrow(() => validatePlan(plan));
  for (const bad of [{...plan, break_minutes:[-1]}, {...plan, morning_minutes:0}, {...plan, end_date:'2026-10-15'}, {...plan, break_minutes:Array(13).fill(30)}]) assert.throws(() => validatePlan(bad));
  assert.doesNotThrow(() => validateDay(filled('2026-10-16'), tasksForPlan(plan)));
  assert.doesNotThrow(() => validateDay({...filled('2026-10-16'),puffs:null}, tasksForPlan(plan)));
  for (const bad of [{puffs:''},{puffs:-1},{velo:1.2},{statuses:['done']},{statuses:['done','arbitrary',null]},{note:'x'.repeat(10001)}]) assert.throws(() => validateDay({...filled('2026-10-16'),...bad}, tasksForPlan(plan)));
  const csv = exportCsv([{...filled('2026-10-16'),puffs:null,note:'=SUM(1;2)\n"test"'}]);
  assert(csv.startsWith('\uFEFF')); assert(csv.includes(';"";"0";'));
  assert(csv.includes('"\'=SUM(1;2)\n""test"""'));
});

test('migration only creates isolated tables and is repeatable', async () => {
  const queries=[]; const db={query:async sql=>{queries.push(sql);return {rows:[]};}};
  await migrateNikotin(db); await migrateNikotin(db);
  assert.equal(queries.length,4);
  assert(queries.every(sql=>sql.startsWith('CREATE TABLE IF NOT EXISTS nikotin_')));
  assert(queries.every(sql=>! /DELETE|DROP|TRUNCATE|UPDATE/.test(sql)));
});

test('portal permissions cannot expose Nikotin to other roles even with enabled overrides', async () => {
  const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const start=source.indexOf("app.get('/api/my-permissions',");
  const end=source.indexOf('// \u2500\u2500 API: Z\u00e1mky',start);
  let handler;
  vm.runInNewContext(source.slice(start,end),{
    app:{get(route,login,fn){handler=fn;}},requireLogin(){},console,
    getPool:()=>({query:async sql=>({rows:sql.includes('permission_groups')?[{perms:'{"nikotin":{"enabled":true,"visible":true}}'}]:[{perm_overrides:'{"nikotin":{"enabled":true,"visible":true}}'}]})})
  });
  for(const role of ['recepční','vedoucí','pb6','admin']) {
    let result;await handler({session:{user:{id:1,role}}},{json:value=>{result=value;}});
    assert.equal(result.nikotin.enabled,role==='admin');
    assert.equal(result.nikotin.visible,role==='admin');
  }
});

async function fixture(t) {
  const days = new Map(), calls=[], plans=[];
  const today = pragueDay();
  const yesterday = new Date(today+'T12:00:00Z'); yesterday.setUTCDate(yesterday.getUTCDate()-1);
  const day = yesterday.toISOString().slice(0,10);
  plans.push({...plan,start_date:day,end_date:today,user_id:1}, {...plan,id:2,start_date:day,end_date:today,user_id:2});
  const query = async (raw, values=[]) => {
    const sql=raw.replace(/\s+/g,' ').trim();calls.push({sql,values});
    if(sql.startsWith('SELECT id, role FROM users'))return {rows:values[0]===3?[{id:3,role:'recepční'}]:values[0]===4?[]:[{id:values[0],role:'admin'}]};
    if(sql.startsWith('INSERT INTO nikotin_plans')) {
      if (!sql.includes('seed_key')) plans.push({user_id:values[0],id:plans.length+1,start_date:values[1],end_date:values[2],morning_minutes:values[3],break_minutes:JSON.parse(values[4])});
      return {rows:[]};
    }
    if(sql.startsWith('SELECT start_date::text'))return {rows:plans.filter(p=>p.user_id===values[0]&&p.id===values[1]).map(p=>({start_date:p.start_date}))};
    if(sql.startsWith('SELECT 1 FROM nikotin_days'))return {rows:[...days.values()].filter(d=>d.user_id===values[0]&&d.plan_id===values[1])};
    if(sql.startsWith('SELECT 1 FROM nikotin_plans'))return {rows:plans.filter(p=>p.user_id===values[0]&&p.start_date<=values[2]&&p.end_date>=values[1]&&p.id!==values[3])};
    if(sql.startsWith('UPDATE nikotin_plans')) {
      const p=plans.find(p=>p.user_id===values[0]&&p.id===values[5]);
      Object.assign(p,{start_date:values[1],end_date:values[2],morning_minutes:values[3],break_minutes:JSON.parse(values[4])});return {rows:[]};
    }
    if(sql.startsWith('SELECT id, start_date::text'))return {rows:plans.filter(p=>p.user_id===values[0])};
    if(sql.startsWith('SELECT day::text'))return {rows:[...days.values()].filter(d=>d.user_id===values[0])};
    if(sql.startsWith('SELECT * FROM nikotin_days'))return {rows:days.has(values.join('|'))?[days.get(values.join('|'))]:[]};
    if(sql.startsWith('SELECT * FROM nikotin_plans'))return {rows:plans.filter(p=>p.user_id===values[0]&&p.start_date<=values[1]&&p.end_date>=values[1])};
    if(sql.startsWith('INSERT INTO nikotin_days')) {
      const [user_id,day,plan_id,tasks,statuses,puffs,velo,note]=values, old=days.get(user_id+'|'+day);
      const item={user_id,day,plan_id:old?.plan_id||plan_id,tasks:old?.tasks||JSON.parse(tasks),statuses:JSON.parse(statuses),puffs,velo,note};days.set(user_id+'|'+day,item);return {rows:[item]};
    }
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    throw new Error('Unexpected test SQL: '+sql);
  };
  const pool={query,connect:async()=>({query,release(){}})};
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.session={user:req.headers['x-user']?{id:Number(req.headers['x-user']),role:'admin'}:null};next();});
  registerNikotin(app,{getPool:()=>pool,getUserEffectivePerms:async user=>({groupPerms:{nikotin:{enabled:user.id!==5}},userOv:{nikotin:{enabled:user.id===3?true:undefined}}})});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(url,user,method='GET',body)=>fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{...(user?{'x-user':String(user)}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {request,days,calls,plans,day,today};
}

test('page and every API operation reject non-admins despite stale sessions and overrides', async t => {
  const {request,calls}=await fixture(t);
  for(const user of [null,3,4,5])for(const [url,method] of [['/nikotin','GET'],['/api/nikotin','GET'],['/api/nikotin/export.csv','GET'],['/api/nikotin/days/2026-10-16','PUT'],['/api/nikotin/plans','POST'],['/api/nikotin/plans/1','PUT']]) {
    const response=await request(url,user,method,method==='GET'?null:{});
    assert.equal(response.status,user===null?401:403,url);
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  assert(!calls.some(c=>c.sql.includes('nikotin_')));
});

test('save and edit yesterday, preserve task snapshots, isolate accounts and exports', async t => {
  const {request,plans,day,days}=await fixture(t);
  let response=await request('/api/nikotin/days/'+day,1,'PUT',{...filled(day),puffs:123,velo:4,note:'Yesterday'});
  assert.equal(response.status,200);assert.equal((await response.json()).day.day,day);
  response=await request('/api/nikotin',2);assert.equal((await response.json()).days.length,0);
  response=await request('/api/nikotin',1);assert.equal((await response.json()).days[0].puffs,123);
  plans[0].morning_minutes=99;
  response=await request('/api/nikotin/days/'+day,1,'PUT',{...filled(day),puffs:0,note:'Corrected'});
  assert.equal(response.status,200);const edited=(await response.json()).day;
  assert.equal(edited.tasks[0].minutes,15);assert.equal(edited.puffs,0);
  response=await request('/api/nikotin/export.csv',2);assert(!(await response.text()).includes('Corrected'));
  response=await request('/api/nikotin/export.csv',1);assert((await response.text()).includes('Corrected'));
  assert.equal(days.size,1);
});

test('reject future and invalid days without changing saved data', async t => {
  const {request,day,today,days,calls}=await fixture(t);
  assert.equal((await request('/api/nikotin/days/'+nextDay(today),1,'PUT',filled(day))).status,400);
  assert.equal((await request('/api/nikotin/days/'+day,1,'PUT',{...filled(day),puffs:-1})).status,400);
  assert.equal(days.size,0);assert(calls.some(c=>c.sql==='ROLLBACK'));
  assert.equal((await request('/api/nikotin/plans',1,'POST',{...plan,start_date:day,end_date:today})).status,400);
});

test('create/edit only future plans, reject overlaps and foreign or historical plans', async t => {
  const {request,today,plans}=await fixture(t);
  const start=nextDay(today), end=nextDay(start);
  const body={start_date:start,end_date:end,morning_minutes:20,break_minutes:[40]};
  assert.equal((await request('/api/nikotin/plans',1,'POST',body)).status,200);
  assert.equal(plans.length,3);
  assert.equal((await request('/api/nikotin/plans',1,'POST',body)).status,400);
  assert.equal((await request('/api/nikotin/plans/3',1,'PUT',{...body,morning_minutes:25})).status,200);
  assert.equal(plans[2].morning_minutes,25);
  assert.equal((await request('/api/nikotin/plans/1',1,'PUT',body)).status,400);
  assert.equal((await request('/api/nikotin/plans/3',2,'PUT',body)).status,400);
  assert.equal(plans[0].morning_minutes,15);
});
