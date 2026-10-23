(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BbAdjustments=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function entry(value={}){
  const raw=String(value.val??'').trim().replace(',','.');if(!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)||!Number.isFinite(Number(raw))||Number(raw)===0)throw Error('Zadejte nenulový počet hodin, např. 2 nebo -1,5.');
  const date=String(value.date||'');if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date))throw Error('Zadejte platné datum.');
  const note=String(value.note||'').trim();if(note.length>2000)throw Error('Poznámka může mít nejvýše 2000 znaků.');return {val:Number(raw),note,date,login:String(value.login||'')};
 }
 function normalize(value={},ids=[]){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Neplatné korekce hodin.');const result={};for(const [uid,list]of Object.entries(value)){if(!/^\d+$/.test(uid)||!ids.map(Number).includes(Number(uid))||!Array.isArray(list))throw Error('Neplatný pracovník nebo korekce hodin.');if(list.length)result[uid]=list.map(entry);}return result;}
 const total=list=>Math.round((list||[]).reduce((sum,a)=>sum+Number(a.val||0),0)*1e6)/1e6;
 const format=value=>String(value).replace('.',',');
 const title=list=>(list||[]).map(a=>[a.date,format(a.val)+' h',a.note,a.login?'('+a.login+')':''].filter(Boolean).join(' — ')).join('\n');
 return {entry,normalize,total,format,title};
});
