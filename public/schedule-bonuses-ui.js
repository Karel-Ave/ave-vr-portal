(function(){
  'use strict';
  const rules=window.ScheduleBonusRules;
  const uuid=()=>crypto.randomUUID?crypto.randomUUID():([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let configPromise;
  function options(){if(!configPromise)configPromise=fetch('/api/schedule-bonuses/options',{credentials:'include',cache:'no-store'}).then(async r=>{const v=await r.json();if(!r.ok||!v.ok)throw Error(v.msg||'Nelze načíst příplatky.');return v;}).catch(e=>{configPromise=null;throw e;});return configPromise;}
  function create({current,original,host,onDirty=()=>{},onError=message=>alert(message)}){
    const pending=new Map(),queue=[];let active=false,generation=0,dialog,finish,attempt,waiters=[];
    const key=source=>Number(source.userId)+'/'+Number(source.index);
    const live=source=>{const now=current(source);return now&&rules.eligible(now.value,now.person)&&String(now.value).toUpperCase()===String(source.value).toUpperCase()&&String(original(now)||'').toUpperCase()!==String(now.value).toUpperCase()?now:null;};
    const idle=()=>{if(!active&&!queue.length){for(const resolve of waiters.splice(0))resolve();}};
    function refresh(){
      for(const [k,item]of pending)if(!live(item))pending.delete(k);
      let panel=document.querySelector('[data-bonus-panel="'+host+'"]');
      if(!panel){panel=document.createElement('div');panel.dataset.bonusPanel=host;panel.className='schedule-bonus-panel';const anchor=document.getElementById(host);if(!anchor)return;anchor.before(panel);}
      panel.hidden=!pending.size;
      panel.innerHTML=pending.size?'<strong>Připravené příplatky ('+pending.size+')</strong><div class="sb-hint">Uloží se společně s rozpisem.</div>'+[...pending.values()].map(item=>'<div class="sb-pending"><span>'+esc(item.name)+' · '+esc(item.date.split('-').reverse().join('.'))+' · '+esc(item.hotel)+' · '+item.amount+' Kč</span><button type="button" data-edit="'+esc(key(item))+'">Upravit</button><button type="button" data-remove="'+esc(key(item))+'">Odebrat</button></div>').join(''):'';
      panel.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{pending.delete(button.dataset.remove);onDirty();refresh();});
      panel.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>{const item=pending.get(button.dataset.edit);if(item){queue.push({source:item,edit:true,generation});drain();}});
    }
    function reset(){generation++;queue.splice(0);pending.clear();attempt=null;if(finish)finish(null);refresh();idle();}
    function changed(source,previous){
      if(String(previous||'').toUpperCase()===String(source.value||'').toUpperCase())return;
      pending.delete(key(source));refresh();const now=live(source);if(!now)return;
      queue.push({source:{...now},edit:false,generation});drain();
    }
    async function drain(){
      if(active)return;active=true;
      try{while(queue.length){const job=queue.shift();if(job.generation!==generation)continue;const now=live(job.source);if(!now)continue;
        let cfg;try{cfg=await options();}catch(error){onError(error.message);continue;}
        if(job.generation!==generation||!live(now)||!cfg.canAdd||!(cfg.canAll||Number(now.userId)===Number(cfg.userId)||(cfg.identities||[]).includes(String(now.login||'').toLowerCase())))continue;
        const result=await prompt(now,cfg,job.edit?pending.get(key(now)):null,job.edit);
        if(result&&job.generation===generation&&live(now)){pending.set(key(now),result);onDirty();refresh();}
      }}finally{active=false;idle();}
    }
    async function prompt(source,cfg,existing,edit){
      if(!edit){const yes=await new Promise(resolve=>{
        if(!dialog){dialog=document.createElement('dialog');dialog.className='schedule-bonus-dialog';document.body.appendChild(dialog);}
        dialog.innerHTML='<form><header><strong>Příplatek za směnu</strong><button type="button" data-close aria-label="Zavřít">✕</button></header><div class="sb-scroll"><div class="sb-person">'+esc(source.name)+' · '+esc(source.value)+' · '+esc(source.date.split('-').reverse().join('.'))+(source.shift?' · '+esc(source.shift):'')+'</div><p>Přidat za tuto směnu příplatek?</p></div><footer><button type="button" data-no>Ne</button><button type="button" data-yes class="sb-primary">Ano</button></footer></form>';
        let done=false;finish=value=>{if(done)return;done=true;finish=null;dialog.close();resolve(value);};
        dialog.querySelector('[data-yes]').onclick=()=>finish(true);for(const selector of ['[data-no]','[data-close]'])dialog.querySelector(selector).onclick=()=>finish(false);
        dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.querySelector('form').onsubmit=e=>{e.preventDefault();finish(true);};dialog.showModal();dialog.querySelector('[data-yes]').focus();
      });if(!yes)return null;}
      return new Promise(resolve=>{
        const token=uuid(),frame=document.createElement('iframe');frame.title='Přidat příplatek';frame.className='schedule-bonus-frame';frame.src='/priplatky?scheduleBonusDraft='+encodeURIComponent(token);
        const item=existing||{...source,amount:500,reason:'Směna navíc',note:'',internalNote:'',hotel:source.value,date:source.date,paymentMonth:source.month,paymentYear:source.year};
        let done=false;let timer;
        const handler=event=>{
          if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.token!==token)return;
          if(event.data.type==='schedule-bonus-ready'){clearTimeout(timer);frame.contentWindow.postMessage({type:'schedule-bonus-fill',token,item,source},location.origin);}
          if(event.data.type==='schedule-bonus-cancel')finish(null);
          if(event.data.type==='schedule-bonus-error'){onError(event.data.message);finish(null);}
          if(event.data.type==='schedule-bonus-result'){
            const p=event.data.payload;
            finish({...source,id:uuid(),amount:Number(p.castka),reason:event.data.reason,note:event.data.note,internalNote:p.internal_note||'',hotel:p.hotel||source.value,date:p.rokDatum+'-'+String(p.mesicDatum).padStart(2,'0')+'-'+String(p.den).padStart(2,'0'),paymentMonth:p.mesic,paymentYear:p.rok});
          }
        };
        finish=value=>{if(done)return;done=true;finish=null;clearTimeout(timer);window.removeEventListener('message',handler);frame.remove();resolve(value);};
        window.addEventListener('message',handler);timer=setTimeout(()=>{onError('Formulář příplatku se nepodařilo načíst.');finish(null);},20000);document.body.appendChild(frame);
      });
    }
    function entries(){refresh();return [...pending.values()].map(({person,login,month,year,shift,...item})=>({...item}));}
    function request(body){const bonuses=entries(),signature=JSON.stringify({...body,bonuses});if(!attempt||attempt.signature!==signature)attempt={signature,id:uuid()};return {...body,bonuses,saveId:attempt.id};}
    return {changed,refresh,reset,request,entries,whenIdle:()=>!active&&!queue.length?Promise.resolve():new Promise(resolve=>waiters.push(resolve)),isOpen:()=>active};
  }
  const style=document.createElement('style');style.textContent=`.schedule-bonus-frame{position:fixed;inset:0;width:100%;height:100dvh;border:0;z-index:2147483000;background:transparent}.schedule-bonus-dialog{width:min(560px,calc(100vw - 32px))!important;border-radius:14px!important;box-shadow:0 8px 32px rgba(0,0,0,.2)}.schedule-bonus-dialog header{padding:18px 20px 12px!important;border-bottom:1px solid var(--border)}.schedule-bonus-dialog footer{padding:12px 20px 18px!important;border-top:1px solid var(--border);justify-content:flex-end!important}.schedule-bonus-dialog .sb-scroll{padding:20px!important}.schedule-bonus-dialog button{font:600 13px 'Segoe UI',sans-serif!important;min-height:0!important;padding:7px 14px!important;border-radius:7px!important}.schedule-bonus-dialog{box-sizing:border-box;width:min(520px,calc(100vw - 24px));max-height:calc(100dvh - 24px - env(safe-area-inset-bottom));padding:0;border:1px solid var(--btn-top-border,#aaa);border-radius:12px;background:var(--surface,#fff);color:var(--text,#222);z-index:50000;font:14px 'Segoe UI',sans-serif}.schedule-bonus-dialog::backdrop{background:#0007}.schedule-bonus-dialog form{display:flex;flex-direction:column;max-height:calc(100dvh - 32px - env(safe-area-inset-bottom));margin:0}.schedule-bonus-dialog header,.schedule-bonus-dialog footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;flex-shrink:0;background:var(--surface,#fff)}.schedule-bonus-dialog .sb-scroll{overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 16px 16px}.schedule-bonus-dialog label{display:block;margin:12px 0}.schedule-bonus-dialog input,.schedule-bonus-dialog select,.schedule-bonus-dialog textarea{display:block;box-sizing:border-box;width:100%;min-height:42px;margin-top:5px;padding:8px;font-size:16px;border:1px solid var(--btn-top-border,#aaa);border-radius:6px;background:var(--surface,#fff);color:var(--text,#222)}.schedule-bonus-dialog button,.schedule-bonus-panel button{min-height:40px;cursor:pointer;border:1px solid var(--btn-top-border,#aaa);border-radius:6px;padding:8px 12px;background:var(--surface,#fff);color:var(--text,#222)}.schedule-bonus-dialog .sb-primary{background:var(--accent,#434cb8);color:#fff}.schedule-bonus-dialog [hidden],.schedule-bonus-panel[hidden]{display:none!important}.sb-actions{display:flex;justify-content:flex-end;gap:10px}.sb-hint{font-size:12px;color:var(--text-muted,#666);margin:8px 0}.sb-person{font-weight:600;margin:6px 0}.schedule-bonus-panel{margin:10px 0;padding:10px;border:1px solid var(--btn-top-border,#aaa);border-radius:6px;background:var(--surface,#fff);font:13px 'Segoe UI',sans-serif}.sb-pending{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:5px 0}.sb-pending span{flex:1;min-width:150px}@media print{.schedule-bonus-panel,.schedule-bonus-dialog{display:none!important}}`;
  document.head.appendChild(style);window.ScheduleBonuses={create,uuid};
})();
