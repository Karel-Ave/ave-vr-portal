(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ScheduleBonusRules=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const clean=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  function eligible(value,person){
    const v=String(value||'').trim().toUpperCase();
    if(!/^[A-Z]$/.test(v)||['P','Q','F','X','Y','Z'].includes(v)||!Number(person?.userId||person?.id))return false;
    if(/^zz(?:z)?\s/i.test(String(person?.name||person?.displayName||'')))return false;
    return !['pohotovost','vedouci','specialni'].includes(clean(person?.type));
  }
  function sourceDate(year,month,index,mode){
    const day=mode==='vr'?Math.floor(Number(index)/2)+1:Number(index);
    const max=new Date(Date.UTC(year,month,0)).getUTCDate();
    if(!Number.isInteger(Number(index))||(mode==='vr'&&Number(index)<0)||day<1||day>max+(Number(month)===12?1:0))throw Error('Neplatný den směny.');
    return day>max?`${Number(year)+1}-01-01`:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  return {eligible,sourceDate};
});
