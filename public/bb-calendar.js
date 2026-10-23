(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BbCalendar=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const daysInMonth=(year,month)=>new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate();
  const iso=(year,month,day)=>`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  function defaultPeriod(view,now=new Date()){
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Prague',year:'numeric',month:'numeric'}).formatToParts(now);
    let year=Number(parts.find(p=>p.type==='year').value),month=Number(parts.find(p=>p.type==='month').value);
    if(view==='requests'&&++month===13){month=1;year++;}
    return {month,year};
  }
  function columns(year,month){
    year=Number(year);month=Number(month);
    const result=Array.from({length:daysInMonth(year,month)},(_,i)=>({index:i+1,day:i+1,month,year,spill:false,date:iso(year,month,i+1)}));
    if(month===12)result.push({index:32,day:1,month:1,year:year+1,spill:true,date:iso(year+1,1,1)});
    return result;
  }
  function cellDate(year,month,index){return columns(year,month).find(c=>c.index===Number(index))?.date||null;}
  function dayIndex(year,month,date){return columns(year,month).find(c=>c.date===date)?.index??null;}
  function countShifts(cells,userId,year,month){return columns(year,month).filter(c=>!c.spill&&cells?.[userId+'-'+c.index]==='W').length;}
  function normalizeFunds(value={}){
    const result={};
    for(const [key,label]of [['hpp','HPP'],['zpp','ZPP'],['dpc','DPČ']]){
      const raw=String(value?.[key]??'').trim();
      if(!raw){result[key]='';continue;}
      if(!/^\d+(?:[.,]\d+)?$/.test(raw)||!Number.isFinite(Number(raw.replace(',','.'))))throw Error('Fond '+label+' musí být nezáporný počet hodin.');
      result[key]=String(Number(raw.replace(',','.')));
    }
    return result;
  }
  function normalizeExtraHolidays(value,year,month){
    const parts=Array.isArray(value)?value:String(value??'').trim().split(/[,;\s]+/).filter(Boolean);
    if(parts.some(day=>!/^\d+$/.test(String(day))||Number(day)<1||Number(day)>daysInMonth(year,month)))throw Error('Svátky navíc zadejte jako čísla dnů ve vybraném měsíci, např. 15, 16.');
    return [...new Set(parts.map(Number))].sort((a,b)=>a-b);
  }
  function formatFund(raw){
    if(raw==null||String(raw).trim()==='')return '-';
    const hours=Number(String(raw).replace(',','.'));if(!Number.isFinite(hours)||hours<0)return '-';
    const format=n=>String(n).replace('.',',');
    return format(Math.round(hours/12*10)/10)+' směn / '+format(hours)+' h';
  }
  return {defaultPeriod,columns,cellDate,dayIndex,countShifts,normalizeFunds,normalizeExtraHolidays,formatFund};
});
