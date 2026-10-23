'use strict';
const path = require('path');
const availability = require('./public/bb-availability');
const clean = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const json = value => typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
const copy = value => JSON.parse(JSON.stringify(value));
const manager = user => user?.role === 'admin' || /ved|^vr$/.test(clean(user?.role));
const isBb = user => clean(user?.role) === 'bagazista' || clean(user?.type) === 'bagazista';
const isReceptionist = user => ['denni','nocni','oboji'].includes(clean(user?.type));
const dayCount = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const date = (year, month, day) => `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
const rtKey = (year, month) => `RT:${String(month).padStart(2,'0')}/${year}`;
function period(month, year) {
  month = Number(month); year = Number(year);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2020 || year > 2100) throw Object.assign(new Error('Neplatný měsíc nebo rok.'),{status:400});
  return {month,year};
}
function fail(message, status=409, extra={}) { throw Object.assign(new Error(message),{status,...extra}); }
function personIndex(staff, uid) {
  const indexes = (staff || []).map((p,i)=>String(p?.userId)===String(uid)?i:-1).filter(i=>i>=0);
  if(indexes.length>1)fail('Nejednoznačná identita pracovníka v rozpisu. Obnovte rozpis a zkontrolujte duplicitní řádky.');
  return indexes.length===1?indexes[0]:-1;
}
function scheduleCells(data) {
  return data.monthlyData?.[`${data.year}-${data.month}`]?.schedule || data.schedule || {};
}
function setSchedule(data, cells) {
  data.schedule=cells; data.monthlyData=data.monthlyData||{};
  const key=`${data.year}-${data.month}`;
  data.monthlyData[key]={...(data.monthlyData[key]||{}),schedule:copy(cells)};
}
function vrAssignments(data, strict=true) {
  const result=[]; const cells=scheduleCells(data); const days=dayCount(data.year,data.month);
  for(const [key,value] of Object.entries(cells)) {
    if(String(value).trim().toUpperCase()!=='W') continue;
    const match=key.match(/^(\d+)_(\d+)$/); if(!match) continue;
    const si=Number(match[1]),ci=Number(match[2]),person=data.staff?.[si];
    if(!person?.userId || !isReceptionist(person)) continue;
    if(ci%2){if(strict)fail(`Směna BB (W) je pouze denní: ${person.name || person.login}.`);continue;}
    if(ci>=days*2 && !(Number(data.month)===12 && ci===62)) continue;
    result.push({date:ci===62?date(Number(data.year)+1,1,1):date(data.year,data.month,ci/2+1),userId:Number(person.userId),name:person.name||person.login,source:'vr',version:0});
  }
  return result;
}
function uniqueAssignments(assignments) {
  const byDate=new Map();
  for(const shift of assignments) {
    const old=byDate.get(shift.date);
    if(old && Number(old.userId)!==Number(shift.userId)) fail(`Dvojí obsazení BB ${shift.date}: ${old.name || old.userId} a ${shift.name || shift.userId}.`);
    if(!old || Number(shift.version)>Number(old.version)) byDate.set(shift.date,shift);
  }
  return [...byDate.values()];
}
function duplicateRequests(data, staff=[]) {
  const groups=new Map();
  for(const [key,value] of Object.entries(data.cells||{})) {
    if(value!=='W') continue;
    const [uid,day]=key.split('-').map(Number); const person=staff.find(p=>p.userId===uid);
    const entry={userId:uid,day,name:person?.name||String(uid),...(data.meta?.[key]||{})};
    if(!groups.has(day)) groups.set(day,[]); groups.get(day).push(entry);
  }
  return [...groups.entries()].filter(([,list])=>list.length>1).map(([day,list])=>({day,people:list.sort((a,b)=>(Number(a.order)&&Number(b.order)?Number(a.order)-Number(b.order):String(a.at||'').localeCompare(String(b.at||'')))||a.userId-b.userId)}));
}
async function migrateBb(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS bb_months (
    year INTEGER NOT NULL, month INTEGER NOT NULL, requirements JSONB NOT NULL DEFAULT '{}',
    published JSONB, status TEXT NOT NULL DEFAULT 'closed', revision INTEGER NOT NULL DEFAULT 1,
    published_revision INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(year,month))`);
  await db.query(`CREATE TABLE IF NOT EXISTS bb_assignments (
    day DATE PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), version BIGSERIAL UNIQUE,
    updated_by INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS bb_audit (
    id BIGSERIAL PRIMARY KEY, year INTEGER NOT NULL, month INTEGER NOT NULL, user_id INTEGER,
    action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const perms={__defaultApp:'bb',bb:{enabled:true,visible:true,buttons:{requests_view:true,requests_edit_own:true,requests_edit_all:false,requests_open:false,create:false,publish:false,schedule_view:true,schedule_edit:false,add_staff:false}},raspis:{enabled:true,visible:true,buttons:{tab_nastaveni:false,tab_tvorba:false,tab_rozpis_vr:false,tab_rozpis:false,tab_denni:true,tab_pozadavky:false,filters:false,publish:false,edit:false,req_create:false,req_edit:false,req_edit_all:false,req_toggle_reception:false,req_send_tvorba:false,settings_monthly:false,settings_add_staff:false}},priplatky:{enabled:true,visible:true,buttons:{viewAll:false,add:false,edit:false,delete:false,export:false,settings:false}},dovolene:{enabled:false,visible:false},blacklist:{enabled:false,visible:false},admin:{enabled:false,visible:false},nikotin:{enabled:false,visible:false}};
  await db.query("INSERT INTO permission_groups(name,display_name,sublist,perms) VALUES ('bagazista','Bagážisté','VR',$1) ON CONFLICT(name) DO NOTHING",[JSON.stringify(perms)]);
}
function createBbService({getPool,getUserEffectivePerms}) {
  async function permissions(user) {
    if(!user) return {};
    const {groupPerms,userOv}=await getUserEffectivePerms(user); const gp=groupPerms.bb||{},up=userOv.bb||{};
    const enabled=up.enabled??gp.enabled??(manager(user)||isBb(user)); const result={enabled,visible:up.visible??gp.visible??enabled};
    for(const key of ['requests_view','requests_edit_own','requests_edit_all','requests_open','create','publish','schedule_view','schedule_edit','add_staff']) {
      const def=manager(user)||(['requests_view','requests_edit_own','schedule_view'].includes(key)&&isBb(user));
      result[key]=enabled&&(up.buttons?.[key]??gp.buttons?.[key]??def);
    }
    return result;
  }
  async function people(db) {
    const {rows}=await db.query('SELECT id,name,username,role,perm_overrides FROM users ORDER BY name,id');
    return rows.map(u=>{const rs=json(u.perm_overrides).raspis_staff||{};return {userId:Number(u.id),name:rs.displayName||u.name,login:rs.login||u.username,role:u.role,type:isBb(u)?'Bagážista':rs.type||'',contract:rs.contract||'',availability:availability.normalize(rs),active:rs.active!==false,activeFrom:rs.activeFrom||null,activeUntil:rs.activeUntil||null};});
  }
  function active(p,month,year) {
    const index=year*12+month;const mi=v=>{if(!v)return null;if(typeof v==='string'){const m=v.match(/^(\d{4})-(\d+)/);return m?Number(m[1])*12+Number(m[2]):null;}return Number(v.year)*12+Number(v.month)};
    return p.active && (mi(p.activeFrom)==null||mi(p.activeFrom)<=index)&&(mi(p.activeUntil)==null||mi(p.activeUntil)>=index);
  }
  async function lock(db,month,year) {
    await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7319,year*12+month]);
    if(month===12)await db.query('SELECT pg_advisory_xact_lock($1,$2)',[7319,(year+1)*12+1]);
  }
  async function transaction(fn) {
    const db=await getPool().connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
  }
  async function rawVr(db,month,year,forUpdate=false) {
    const keys=[rtKey(year,month)]; if(month===1)keys.push(rtKey(year-1,12));
    const {rows}=await db.query('SELECT key,data FROM rt_schedules WHERE key = ANY($1::text[])'+(forUpdate?' FOR UPDATE':''),[keys]);
    return rows.map(r=>({...r,data:json(r.data)}));
  }
  async function assignments(db,month,year,spill=false,strict=true) {
    const end=spill&&month===12?date(year+1,1,1):date(year,month,dayCount(year,month));
    const {rows}=await db.query('SELECT day::text AS date,user_id,version FROM bb_assignments WHERE day BETWEEN $1::date AND $2::date ORDER BY day',[date(year,month,1),end]);
    const canonical=rows.map(r=>({date:r.date,userId:Number(r.user_id),version:String(r.version),source:'bb'}));
    const raw=await rawVr(db,month,year);
    const native=raw.flatMap(r=>vrAssignments(r.data,false)).filter(s=>s.date>=date(year,month,1)&&s.date<=end);
    const values=[...canonical,...native];
    if(strict)return uniqueAssignments(values);
    const distinct=new Map();for(const shift of values){const key=shift.date+':'+shift.userId;const old=distinct.get(key);if(!old||Number(shift.version)>Number(old.version))distinct.set(key,shift);}return [...distinct.values()];
  }
  async function projectVr(data,db=getPool()) {
    if(!data?.month||!data?.year||!Array.isArray(data.staff))return data;
    const linked=await assignments(db,Number(data.month),Number(data.year),true,false);const allPeople=await people(db);const cells={...scheduleCells(data)};
    data.bbLinks=[];data.bbConflicts=[];
    for(const day of new Set(linked.map(s=>s.date)))if(linked.filter(s=>s.date===day).length>1)data.bbConflicts.push({date:day,message:'Dvojí obsazení BB'});
    for(const shift of linked) {
      const person=allPeople.find(p=>p.userId===shift.userId);if(!person||!isReceptionist(person))continue;
      let si=personIndex(data.staff,person.userId);
      if(si<0){si=data.staff.length;data.staff.push({...person});data.staffOrder=(data.staff||[]).map(s=>s.userId||null);}
      const ci=Number(data.month)===12&&shift.date===date(Number(data.year)+1,1,1)?62:(Number(shift.date.slice(8))-1)*2;
      const key=`${si}_${ci}`,old=String(cells[key]||'').trim();
      if(old&&old.toUpperCase()!=='W') {data.bbConflicts=data.bbConflicts||[];data.bbConflicts.push({date:shift.date,userId:person.userId,value:old});continue;}
      cells[key]='W';data.bbLinks.push({...shift});
    }
    setSchedule(data,cells);
    const {rows}=await db.query('SELECT published FROM bb_months WHERE year=$1 AND month=$2',[data.year,data.month]);
    const pub=rows[0]?.published?json(rows[0].published):null;
    data.bbDisplayRows=(pub?.staffIds||[]).map(uid=>allPeople.find(p=>p.userId===Number(uid))).filter(p=>p&&isBb(p)).map(p=>({...p,cells:{...Object.fromEntries(Object.entries(pub.cells||{}).filter(([key,value])=>key.startsWith(p.userId+'-')&&['x','z'].includes(value)).map(([key,value])=>[date(data.year,data.month,Number(key.split('-')[1])),value])),...Object.fromEntries(linked.filter(s=>s.userId===p.userId).map(s=>[s.date,'W']))}}));
    return data;
  }
  async function putAssignment(db,shift,user) {
    await db.query(`INSERT INTO bb_assignments(day,user_id,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(day) DO UPDATE SET user_id=EXCLUDED.user_id,version=nextval('bb_assignments_version_seq'),updated_by=EXCLUDED.updated_by,updated_at=NOW()
      WHERE bb_assignments.user_id <> EXCLUDED.user_id`,[shift.date,shift.userId,user.id]);
  }
  async function updateVrRows(db,shifts,removed,allPeople,excludeKey=null) {
    const dates=[...shifts,...removed].map(s=>s.date);const keys=new Set();
    for(const d of dates){const y=Number(d.slice(0,4)),m=Number(d.slice(5,7));keys.add(rtKey(y,m));if(m===1&&d.slice(8)==='01')keys.add(rtKey(y-1,12));}
    keys.delete(excludeKey);
    if(!keys.size)return;
    const {rows}=await db.query('SELECT key,data FROM rt_schedules WHERE key = ANY($1::text[]) FOR UPDATE',[[...keys]]);
    for(const row of rows){const data=json(row.data),cells={...scheduleCells(data)};let changed=false;
      for(const shift of [...removed,...shifts]){
        const ownMonth=shift.date.slice(0,7)===date(data.year,data.month,1).slice(0,7);
        const spill=Number(data.month)===12&&shift.date===date(Number(data.year)+1,1,1);if(!ownMonth&&!spill)continue;
        const person=allPeople.find(p=>p.userId===shift.userId);if(!person||!isReceptionist(person))continue;
        let si=personIndex(data.staff,person.userId);if(si<0&&removed.includes(shift))continue;
        if(si<0){si=data.staff.length;data.staff.push({...person});data.staffOrder=data.staff.map(p=>p.userId||null);}
        const key=`${si}_${spill?62:(Number(shift.date.slice(8))-1)*2}`,value=String(cells[key]||'').trim();
        if(removed.includes(shift)){if(value.toUpperCase()==='W'){delete cells[key];changed=true;}}
        else {if(value&&value.toUpperCase()!=='W')fail(`Konflikt: ${person.name}, ${shift.date}, v Rozpisu VR je ${value}. Nejdříve vyřešte směnu v Rozpisu VR.`);cells[key]='W';changed=true;}
      }
      if(changed){setSchedule(data,cells);await db.query('UPDATE rt_schedules SET data=$1 WHERE key=$2',[JSON.stringify(data),row.key]);}
    }
  }
  async function writeVrSchedule(data,key,user,writer) {
    return transaction(async db=>{
      const {month,year}=period(data.month,data.year);if(key!==rtKey(year,month))fail('Nesouhlasí měsíc rozpisu.',400);await lock(db,month,year);
      const oldRows=await db.query('SELECT data FROM rt_schedules WHERE key=$1 FOR UPDATE',[key]);const old=oldRows.rows[0]?json(oldRows.rows[0].data):null;
      const existing=await assignments(db,month,year,true,false);const incoming=vrAssignments(data);const cells={...scheduleCells(data)},removed=[];
      const allPeople=await people(db);
      // A stale open VR/draft may still contain W after another editor cancelled it.
      // Its old link is evidence of cancellation, rather than a fresh assignment.
      for(const snapshot of data.bbLinks||[]){
        if(existing.some(shift=>shift.date===snapshot.date&&shift.userId===Number(snapshot.userId)))continue;
        const si=personIndex(data.staff,snapshot.userId);
        const ci=month===12&&snapshot.date===date(year+1,1,1)?62:(Number(String(snapshot.date).slice(8))-1)*2;
        if(si>=0&&String(cells[si+'_'+ci]||'').trim().toUpperCase()==='W')fail('Směna BB '+snapshot.date+' byla mezitím změněna nebo zrušena. Obnovte rozpis před uložením.');
      }
      for(const previous of existing){const person=allPeople.find(p=>p.userId===previous.userId);if(!person||!isReceptionist(person))continue;
        const si=personIndex(data.staff,person.userId);const ci=month===12&&previous.date===date(year+1,1,1)?62:(Number(previous.date.slice(8))-1)*2;
        const value=si<0?'':String(cells[`${si}_${ci}`]||'').trim().toUpperCase();
        const snapshot=(data.bbLinks||[]).find(s=>s.date===previous.date&&Number(s.userId)===previous.userId);
        const explicit=!!snapshot&&String(snapshot.version)===String(previous.version);
        const native=old&&vrAssignments(old,false).some(s=>s.date===previous.date&&s.userId===previous.userId)&&Number(previous.version)===0;
        if(value==='W')continue;
        if(explicit||native){removed.push(previous);continue;}
        if(value)fail(`Konflikt s publikovanou směnou BB: ${person.name}, ${previous.date}.`);
        let index=si;if(index<0){index=data.staff.length;data.staff.push({...person});}
        cells[`${index}_${ci}`]='W';incoming.push(previous);
      }
      const desired=uniqueAssignments([...existing.filter(s=>!isReceptionist(allPeople.find(p=>p.userId===s.userId))),...incoming]);
      for(const shift of removed)await db.query('DELETE FROM bb_assignments WHERE day=$1 AND user_id=$2',[shift.date,shift.userId]);
      for(const shift of desired)await putAssignment(db,shift,user);
      setSchedule(data,cells);await updateVrRows(db,desired,removed,allPeople,key);await writer(db,data);
      await db.query('UPDATE bb_months SET published_revision=published_revision+1 WHERE year=$1 AND month=$2',[year,month]);
      if(month===12)await db.query('UPDATE bb_months SET published_revision=published_revision+1 WHERE year=$1 AND month=1',[year+1]);
      await db.query('INSERT INTO bb_audit(year,month,user_id,action,details) VALUES($1,$2,$3,$4,$5)',[year,month,user.id,'vr_sync',JSON.stringify({shifts:desired,removed})]);
      return projectVr(data,db);
    });
  }
  async function readMonth(db,month,year){const {rows}=await db.query('SELECT * FROM bb_months WHERE year=$1 AND month=$2',[year,month]);return rows[0]||null;}
  async function audit(db,month,year,user,action,details){await db.query('INSERT INTO bb_audit(year,month,user_id,action,details) VALUES($1,$2,$3,$4,$5)',[year,month,user.id,action,JSON.stringify(details)]);}
  function register(app){
    const endpoint=(method,url,fn)=>app[method](url,async(req,res)=>{try{if(!req.session?.user)return res.status(401).json({ok:false,msg:'Přihlaste se.'});const perms=await permissions(req.session.user);if(!perms.enabled)fail('Nemáte přístup k BB.',403);const result=await fn(req,perms);res.json({ok:true,...result});}catch(e){res.status(e.status||500).json({ok:false,msg:e.status?e.message:'Chyba modulu BB.',duplicates:e.duplicates});if(!e.status)console.error('BB:',e);}});
    app.get('/bb',async(req,res,next)=>{try{if(!req.session?.user)return res.redirect('/');const p=await permissions(req.session.user);if(!p.enabled||(!p.requests_view&&!p.schedule_view))return res.status(403).send('Nemáte přístup k BB.');res.sendFile(path.join(__dirname,'views','bb.html'));}catch(e){next(e);}});
    endpoint('get','/api/bb/month',async(req,p)=>{const {month,year}=period(req.query.month,req.query.year);if(!p.requests_view&&!p.schedule_view)fail('Nemáte oprávnění.',403);const db=getPool(),entry=await readMonth(db,month,year),all=await people(db),shifts=await assignments(db,month,year,false,false);const reqData=entry?copy(json(entry.requirements)):null,pub=entry?.published?copy(json(entry.published)):(shifts.length?{staffIds:[...new Set(shifts.map(s=>s.userId))],cells:{}}:null);
      const viewAll=p.requests_edit_all||p.requests_open||p.publish;
      if(reqData&&!viewAll){reqData.notes=Object.fromEntries(Object.entries(reqData.notes||{}).filter(([uid])=>Number(uid)===Number(req.session.user.id)));}
      const ids=new Set([...(reqData?.staffIds||[]),...(pub?.staffIds||[]),...shifts.map(s=>s.userId)]);
      const roster=all.filter(s=>ids.has(s.userId));
      return {month,year,permissions:p,canManageAbsence:manager(req.session.user),userId:req.session.user.id,status:entry?.status||'closed',revision:entry?.revision||0,publishedRevision:entry?.published_revision||0,requirements:p.requests_view?reqData:null,published:p.schedule_view?pub:null,shifts:p.schedule_view?shifts:[],staff:roster,available:p.add_staff?all.filter(s=>active(s,month,year)&&(isReceptionist(s)||isBb(s))):[],duplicates:p.requests_view&&reqData?duplicateRequests(reqData,roster):[]};});
    endpoint('post','/api/bb/create',async(req,p)=>{if(!p.create)fail('Nemáte oprávnění vytvářet požadavky BB.',403);const {month,year}=period(req.body.month,req.body.year);return transaction(async db=>{await lock(db,month,year);if(await readMonth(db,month,year))fail('Požadavky BB už existují.');const roster=(await people(db)).filter(s=>isBb(s)&&active(s,month,year));const data={staffIds:roster.map(s=>s.userId),cells:{},notes:{},meta:{},rowVersions:{}};await db.query('INSERT INTO bb_months(year,month,requirements) VALUES($1,$2,$3)',[year,month,JSON.stringify(data)]);await audit(db,month,year,req.session.user,'create',{});return {};});});
    endpoint('post','/api/bb/status',async(req,p)=>{if(!p.requests_open)fail('Nemáte oprávnění.',403);const {month,year}=period(req.body.month,req.body.year);const status=req.body.status;if(!['open','closed'].includes(status))fail('Neplatný stav.',400);return transaction(async db=>{await lock(db,month,year);await db.query('UPDATE bb_months SET status=$3,revision=revision+1,updated_at=NOW() WHERE year=$1 AND month=$2',[year,month,status]);await audit(db,month,year,req.session.user,'status',{status});return {};});});
    endpoint('post','/api/bb/requests',async(req,p)=>{const {month,year}=period(req.body.month,req.body.year);return transaction(async db=>{await lock(db,month,year);const entry=await readMonth(db,month,year);if(!entry)fail('Nejdříve vytvořte měsíc.',404);const current=copy(json(entry.requirements)),incoming=req.body.data||{};const full=p.requests_edit_all;
      if(full){if(Number(req.body.revision)!==entry.revision)fail('Požadavky mezitím někdo změnil. Obnovte je před úpravou.');}
      else {if(!p.requests_edit_own||entry.status!=='open'||!current.staffIds?.includes(Number(req.session.user.id)))fail('Editace požadavků není povolena.',403);if(Number(req.body.rowVersion||0)!==Number(current.rowVersions?.[req.session.user.id]||0))fail('Váš řádek se mezitím změnil. Obnovte požadavky.');}
      const all=await people(db);const allowed=new Set(full?(incoming.staffIds||current.staffIds||[]).map(Number):[Number(req.session.user.id)]);
      if(full){for(const uid of allowed){const person=all.find(s=>s.userId===uid);if(!person||(!isBb(person)&&!isReceptionist(person)))fail('Neplatný pracovník BB.',400);if(!current.staffIds.includes(uid)&&!p.add_staff)fail('Nemáte oprávnění přidat pracovníka.',403);}for(const uid of current.staffIds)if(!allowed.has(uid))fail('Pracovníka lze ponechat s prázdným řádkem; odstranění řádku není povoleno.',400);current.staffIds=[...allowed];}
      current.cells=current.cells||{};current.meta=current.meta||{};current.notes=current.notes||{};current.rowVersions=current.rowVersions||{};
      for(const uid of allowed){for(let day=1;day<=dayCount(year,month);day++){const key=uid+'-'+day,value=String(incoming.cells?.[key]||'').trim();if(value&&!['W','x','z'].includes(value))fail('Povoleno je W, x nebo z (z pouze admin a VR).',400);if((value==='z'||current.cells[key]==='z')&&value!==String(current.cells[key]||'')&&!manager(req.session.user))fail('Dovolenou z může zadat nebo změnit pouze admin nebo VR.',403);if(value!==String(current.cells[key]||'')){if(value){current.cells[key]=value;current.sequence=Number(current.sequence||0)+1;current.meta[key]={order:current.sequence,at:new Date().toISOString(),author:req.session.user.name||req.session.user.username,userId:req.session.user.id};}else{delete current.cells[key];delete current.meta[key];}}}const note=String(incoming.notes?.[uid]||'').trim();if(note.length>10000)fail('PR je příliš dlouhé.',400);if(note)current.notes[uid]=note;else delete current.notes[uid];current.rowVersions[uid]=(current.rowVersions[uid]||0)+1;}
      const duplicates=duplicateRequests(current,all);if(duplicates.length&&!req.body.confirmDuplicates)fail('BB směnu si zapsalo více lidí. Uložit i přesto?',409,{duplicates});
      await db.query('UPDATE bb_months SET requirements=$3,revision=revision+1,updated_at=NOW() WHERE year=$1 AND month=$2',[year,month,JSON.stringify(current)]);await audit(db,month,year,req.session.user,'requests_save',{staffIds:[...allowed]});return {duplicates};});});
    async function publish(req,p,editing=false){if(editing?!p.schedule_edit:!p.publish)fail('Nemáte oprávnění publikovat nebo upravovat Rozpis BB.',403);const {month,year}=period(req.body.month,req.body.year);return transaction(async db=>{await lock(db,month,year);const entry=await readMonth(db,month,year);if(!entry)fail('Měsíc BB neexistuje.',404);if(editing?Number(req.body.revision)!==entry.published_revision:Number(req.body.revision)!==entry.revision)fail('Data se mezitím změnila. Obnovte stránku.');if(!editing&&Number(req.body.publishedRevision)!==entry.published_revision)fail('Publikované směny BB mezitím někdo změnil. Obnovte stránku.');if(!editing&&entry.status==='open')fail('Nejdříve ukončete editaci požadavků BB.');
      const data=editing?copy(req.body.data||{}):copy(json(entry.requirements));const all=await people(db);const existing=await assignments(db,month,year,false,false);const desired=[];const roster=new Set((data.staffIds||[]).map(Number));
      for(const uid of roster){const person=all.find(s=>s.userId===uid);if(!person||(!isBb(person)&&!isReceptionist(person)))fail('Neplatný pracovník BB.',400);const oldIds=json(entry.published).staffIds||[];if(editing&&!oldIds.map(Number).includes(uid)&&!p.add_staff)fail('Nemáte oprávnění přidat pracovníka.',403);}
      if(editing&&!manager(req.session.user)){const oldCells=json(entry.published).cells||{};for(const key of new Set([...Object.keys(oldCells),...Object.keys(data.cells||{})]))if((oldCells[key]==='z'||data.cells?.[key]==='z')&&oldCells[key]!==data.cells?.[key])fail('Dovolenou z může zadat nebo změnit pouze admin nebo VR.',403);}
      for(const [key,value] of Object.entries(data.cells||{})){const m=key.match(/^(\d+)-(\d+)$/);if(!m||!roster.has(Number(m[1]))||Number(m[2])<1||Number(m[2])>dayCount(year,month))fail('Neplatná buňka BB.',400);if(value&&!['W','x','z'].includes(value))fail('Povoleno je pouze W, x nebo z.',400);const person=all.find(s=>s.userId===Number(m[1]));if(!person||(!isBb(person)&&!isReceptionist(person)))fail('Neplatný pracovník BB.',400);if(value==='W')desired.push({date:date(year,month,Number(m[2])),userId:person.userId,name:person.name});}
      // Publishing requests preserves externally assigned W unless the editor has
      // explicitly opened the published schedule (which contains their rows).
      if(!editing)for(const shift of existing)if(isReceptionist(all.find(p=>p.userId===shift.userId))&&!desired.some(s=>s.date===shift.date&&s.userId===shift.userId)){desired.push(shift);roster.add(shift.userId);data.cells[shift.userId+'-'+Number(shift.date.slice(8))]='W';}
      const shifts=uniqueAssignments(desired);const removed=existing.filter(old=>!shifts.some(s=>s.date===old.date&&s.userId===old.userId));
      await updateVrRows(db,shifts,removed,all);
      for(const old of removed)await db.query('DELETE FROM bb_assignments WHERE day=$1 AND user_id=$2',[old.date,old.userId]);
      for(const shift of shifts)await putAssignment(db,shift,req.session.user);
      const published={staffIds:[...roster],cells:data.cells||{}}; // PR and request timestamps never enter the published snapshot.
      await db.query("UPDATE bb_months SET published=$3,published_revision=published_revision+1,status='closed',revision=revision+1,updated_at=NOW() WHERE year=$1 AND month=$2",[year,month,JSON.stringify(published)]);await audit(db,month,year,req.session.user,editing?'published_edit':'publish',{shifts});return {};});}
    endpoint('post','/api/bb/publish',(req,p)=>publish(req,p,false));endpoint('post','/api/bb/schedule',(req,p)=>publish(req,p,true));
  }
  return {register,permissions,people,assignments,projectVr,writeVrSchedule,transaction,lock};
}
module.exports={createBbService,migrateBb,period,isBb,isReceptionist,personIndex,vrAssignments,uniqueAssignments,duplicateRequests,date};
