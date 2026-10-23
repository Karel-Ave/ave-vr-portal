(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BbAvailability=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const fields=['regular','regularFrom','regularTo','regularOpen','regularExceptionFrom','regularExceptionTo'];
  const weekdays=['po','út','st','čt','pá','so','ne'];
  // Same fixed/extra holiday convention as the receptionist schedule (including 31 December).
  const holidays={1:[1],5:[1,8],7:[5,6],9:[28],10:[28],11:[17],12:[24,25,26,31]};
  function iso(value){const text=String(value||'').trim();if(!text)return '';if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return '';const dt=new Date(text+'T00:00:00Z');return !Number.isNaN(dt.getTime())&&dt.toISOString().slice(0,10)===text?text:'';}
  function normalize(value={}){
    const tokens=new Set(String(value.regular||'').split(',').map(x=>x.trim().toLowerCase()));
    const selected=weekdays.filter(d=>tokens.has(d)||tokens.has(d+'-d')).map(d=>d+'-d');
    if(tokens.has('sv'))selected.push('sv');if(['wk','vik','víkend'].some(d=>tokens.has(d)))selected.push('wk');
    return {regular:selected.join(','),regularFrom:iso(value.regularFrom),regularTo:iso(value.regularTo),regularOpen:[true,1,'1','true'].includes(value.regularOpen),regularExceptionFrom:iso(value.regularExceptionFrom),regularExceptionTo:iso(value.regularExceptionTo)};
  }
  function validate(value){
    for(const field of fields.filter(f=>f!=='regular'&&f!=='regularOpen'))if(value[field]&&!iso(value[field]))throw Error('Zadejte platné datum.');
    const v=normalize(value);
    if(!v.regularOpen&&v.regularFrom&&v.regularTo&&v.regularTo<v.regularFrom)throw Error('Konec platnosti nesmí být před začátkem.');
    if(!!v.regularExceptionFrom!==!!v.regularExceptionTo)throw Error('U výjimky vyplňte datum Od i Do.');
    if(v.regularExceptionFrom&&v.regularExceptionTo<v.regularExceptionFrom)throw Error('Konec výjimky nesmí být před jejím začátkem.');
    return v;
  }
  function isUnavailable(value,year,month,day,extraHolidays=[]){
    const v=normalize(value),text=year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');if(!iso(text)||!v.regular)return false;
    if(v.regularFrom&&text<v.regularFrom)return false;if(!v.regularOpen&&v.regularTo&&text>v.regularTo)return false;
    if(v.regularExceptionFrom&&v.regularExceptionTo&&text>=v.regularExceptionFrom&&text<=v.regularExceptionTo)return false;
    const dow=new Date(text+'T00:00:00Z').getUTCDay(),tokens=new Set(v.regular.split(','));
    return tokens.has(weekdays[(dow+6)%7]+'-d') || (tokens.has('wk')&&(dow===0||dow===6)) || (tokens.has('sv')&&((holidays[month]||[]).includes(Number(day))||extraHolidays.includes(Number(day))));
  }
  return {fields,weekdays,normalize,validate,isUnavailable};
});
