/* Shared contract periods are edited here and consumed by vacation accounting. */
window.ContractHistoryAdmin = (() => {
  const el=id=>document.getElementById(id);
  let original=[], baseline='', originalContract='', loaded=false;
  const ym=(y,m)=>`${y}-${String(m).padStart(2,'0')}`;
  const canonical=c=>String(c||'').replace('DPČ','DPC');
  function reset() {
    original=[];baseline='';originalContract='';loaded=false;
    el('contract-history-rows').innerHTML='';el('contract-effective').value='';
  }
  function row(p={}) {
    const box=document.createElement('div');box.className='contract-history-row';
    box.style.cssText='display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0';
    box.innerHTML='<select data-contract><option>HPP</option><option>ZPP</option><option value="DPC">DPČ</option><option>DPP</option></select> <label>Od <input type="month" data-from required></label> <label>Do <input type="month" data-to></label> <button type="button">Smazat</button>';
    box.querySelector('[data-contract]').value=canonical(p.contract||'HPP');
    box.querySelector('[data-from]').value=p.from_year?ym(p.from_year,p.from_month):'';
    box.querySelector('[data-to]').value=p.to_year?ym(p.to_year,p.to_month):'';
    box.querySelector('button').onclick=()=>box.remove();
    el('contract-history-rows').appendChild(box);
  }
  function load(data,rs) {
    reset();loaded=true;baseline=data.previous_contract||rs?.contract||'';originalContract=rs?.contract||'';
    original=(data.contract_periods||[]).map(p=>({...p}));original.forEach(row);
  }
  function collect() {
    return [...document.querySelectorAll('.contract-history-row')].map(box=>{
      const from=box.querySelector('[data-from]').value,to=box.querySelector('[data-to]').value;
      if(!from)throw Error('Vyplňte začátek každého období úvazku.');
      const [fy,fm]=from.split('-').map(Number),[ty,tm]=to?to.split('-').map(Number):[null,null];
      return {contract:box.querySelector('[data-contract]').value,from_year:fy,from_month:fm,to_year:ty,to_month:tm};
    });
  }
  function payload(isNew) {
    if(!isNew&&!loaded)throw Error('Historie úvazků se nenačetla. Otevřete uživatele znovu.');
    let periods=collect();const contract=el('raspis-contract').value;
    const from=el('contract-effective').value;
    if(!isNew&&(contract!==originalContract||(!original.length&&baseline&&canonical(contract)!==canonical(baseline)))&&!from)throw Error('Vyberte, od kterého měsíce platí nový úvazek.');
    if(from&&contract) {
      const [year,month]=from.split('-').map(Number),start=year*12+month;
      if(!periods.length&&baseline)periods.push({contract:canonical(baseline),from_year:2000,from_month:1,to_year:null,to_month:null});
      const next=periods.filter(p=>p.from_year*12+p.from_month>start).sort((a,b)=>a.from_year*12+a.from_month-b.from_year*12-b.from_month)[0];
      const before=start-1, after=next?next.from_year*12+next.from_month-1:null;
      periods=periods.filter(p=>p.from_year*12+p.from_month!==start).map(p=>{
        if(p.from_year*12+p.from_month<start&&(!p.to_year||p.to_year*12+p.to_month>=start)) return {...p,to_year:Math.floor((before-1)/12),to_month:(before-1)%12+1};
        return p;
      });
      periods.push({contract:canonical(contract),from_year:year,from_month:month,to_year:after?Math.floor((after-1)/12):null,to_month:after?(after-1)%12+1:null});
    }
    return {contract_periods:periods,expected_contract_periods:original};
  }
  el('raspis-contract').addEventListener('change',()=>{
    if(loaded && el('raspis-contract').value!==originalContract && !el('contract-effective').value) {
      const d=new Date();el('contract-effective').value=ym(d.getFullYear(),d.getMonth()+1);
    }
  });
  el('contract-add-period').onclick=()=>row();
  return {reset,load,payload};
})();
