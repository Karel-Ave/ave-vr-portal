'use strict';
const {createHash}=require('node:crypto');
const rules=require('./public/schedule-bonus-rules');
function fail(message,status=400){throw Object.assign(Error(message),{status});}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
const fingerprint=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value||''));
const parse=value=>typeof value==='string'?JSON.parse(value||'{}'):(value||{});
function createScheduleBonusService({canAdd,canTouch,canInternal}){
  async function begin(db,body,user,scope){
    const items=body.bonuses||[];
    if(!Array.isArray(items)||items.length>100)fail('Neplatný seznam příplatků.');
    if(!body.saveId){if(items.length)fail('Chybí identifikátor uložení příplatků.');return false;}
    if(!uuid(body.saveId))fail('Neplatný identifikátor uložení.');
    if(items.length&&!await canAdd(user))fail('Nemáte oprávnění přidávat příplatky.',403);
    const hash=fingerprint(body);
    const inserted=await db.query('INSERT INTO schedule_edit_receipts (id,user_id,scope,payload_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id',[body.saveId,user.id,scope,hash]);
    if(inserted.rows.length)return false;
    const row=(await db.query('SELECT user_id,scope,payload_hash FROM schedule_edit_receipts WHERE id=$1',[body.saveId])).rows[0];
    if(!row||Number(row.user_id)!==Number(user.id)||row.scope!==scope||row.payload_hash!==hash)fail('Identifikátor uložení už patří jiné změně. Obnovte rozpis.',409);
    return true;
  }
  async function save(db,body,user,scope,old,incoming,mode){
    const items=body.bonuses||[];if(!items.length)return;
    if(!await canAdd(user))fail('Nemáte oprávnění přidávat příplatky.',403);
    const seen=new Set();
    for(const item of items){
      if(!uuid(item.id)||seen.has(item.id))fail('Neplatný nebo opakovaný příplatek.');seen.add(item.id);
      const hash=fingerprint(item);
      const previous=(await db.query('SELECT user_id,scope,payload_hash FROM schedule_bonus_receipts WHERE id=$1',[item.id])).rows[0];
      if(previous){if(Number(previous.user_id)!==Number(user.id)||previous.scope!==scope||previous.payload_hash!==hash)fail('Tento příplatek už byl uložen s jinými údaji.',409);continue;}
      const uid=Number(item.userId),index=Number(item.index),value=String(item.value||'').trim().toUpperCase();
      const userRow=(await db.query('SELECT id,name,username,role,perm_overrides FROM users WHERE id=$1',[uid])).rows[0];
      if(!userRow)fail('Pracovník příplatku neexistuje.');
      const rs=parse(userRow.perm_overrides).raspis_staff||{};
      const person={userId:uid,name:rs.displayName||userRow.name,type:rs.type};
      if(!rules.eligible(value,person)||!(userRow.role==='bagazista'||['denni','nocni','oboji'].includes(String(rs.type||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase())))fail('Za tuto směnu nelze vytvořit příplatek.');
      const login=String(rs.login||userRow.username||'').trim();if(!login||!await canTouch(user,login))fail('Nemáte oprávnění přidat příplatek tomuto pracovníkovi.',403);
      rules.sourceDate(incoming.year,incoming.month,index,mode);
      let before='',after='';
      if(mode==='vr'){
        const locate=data=>{const matches=(data?.staff||[]).map((p,i)=>({p,i})).filter(p=>Number(p.p.userId)===uid);if(matches.length>1)fail('Nejednoznačný pracovník v rozpisu.');return matches[0];};
        const current=locate(incoming),prior=locate(old);
        if(!current||!rules.eligible(value,current.p))fail('Neplatný řádek příplatku.');
        const cells=data=>data?.monthlyData?.[data.year+'-'+data.month]?.schedule||data?.schedule||data?.cells||{};
        after=String(cells(incoming)[current.i+'_'+index]||'').toUpperCase();before=prior?String(cells(old)[prior.i+'_'+index]||'').toUpperCase():'';
      }else{
        if(!(incoming.staffIds||[]).map(Number).includes(uid)||value!=='W')fail('Neplatný řádek příplatku BB.');
        after=String(incoming.cells?.[uid+'-'+index]||'');before=String(old?.cells?.[uid+'-'+index]||'');
      }
      if(after!==value||before===after)fail('Příplatek neodpovídá nově změněné směně. Zkontrolujte připravené příplatky.',409);
      const amount=Number(item.amount),paymentMonth=Number(item.paymentMonth),paymentYear=Number(item.paymentYear);
      if(!Number.isInteger(amount)||amount<0||amount>1000000||!Number.isInteger(paymentMonth)||paymentMonth<1||paymentMonth>12||!Number.isInteger(paymentYear)||paymentYear<2020||paymentYear>2100)fail('Neplatná částka nebo výplatní měsíc.');
      const date=String(item.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)fail('Neplatné datum příplatku.');
      const hotel=String(item.hotel||value).trim().toUpperCase();if(!/^[A-Z]$/.test(hotel))fail('Neplatný hotel.');
      const reason=String(item.reason||'').trim(),note=String(item.note||'').trim(),internal=String(item.internalNote||'').trim();
      if(!reason||reason.length>500||note.length>10000||internal.length>10000)fail('Zkontrolujte důvod a poznámky příplatku.');
      if(internal&&!await canInternal(user))fail('Nemáte oprávnění pro interní poznámku.',403);
      const record=await db.query(`INSERT INTO priplatky_zaznamy (rok,mesic,sekce,login,datum,hotel,castka,poznamka,internal_note,vlozil)
        VALUES ($1,$2,'braní směn',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[paymentYear,paymentMonth,login,date,hotel,amount,reason+(note?'; '+note:''),internal||null,user.username||user.name||String(user.id)]);
      await db.query('INSERT INTO schedule_bonus_receipts (id,user_id,scope,payload_hash,record_id) VALUES ($1,$2,$3,$4,$5)',[item.id,user.id,scope,hash,record.rows[0].id]);
    }
  }
  return {begin,save};
}
module.exports={createScheduleBonusService,fingerprint};
