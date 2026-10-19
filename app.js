/* TASMAN Intelligence / 2026-10-19 research edition
   No invented API values. Dates and source availability are explicit.
   Single-page app: framework-free, accessible SVG charts, browser-only FX API calls.
*/
(() => {
'use strict';
const $ = id => document.getElementById(id);
const SOURCE = {
  melq4: 'https://reiv.com.au/our-industry/news/latest-data-reflects-the-uptick-in-popularity-of-units-and-apartments',
  melq1: 'https://reiv.com.au/our-industry/news/melbourne-s-outer-suburbs-and-regional-victoria-lead-in-quarterly-growth',
  melq2: 'https://reiv.com.au/our-industry/news/median-price-data-highlights-victoria-s-long-term-property-market-resilience',
  melq3: 'https://reiv.com.au/our-industry/news/regional-victoria-leads-property-growth-as-more-affordable-homes-outperform',
  akldec: 'https://www.reinz.co.nz/Web/Web/News/News-Articles/Market-updates/REINZ_December_2025_Data.aspx',
  aklmay: 'https://www.reinz.co.nz/Web/Web/News/News-Articles/Market-updates/REINZ_May_2026_Data.aspx',
  aklaug: 'https://www.knowledgeauckland.org.nz/publications/auckland-economic-update-october-2026/',
  aklsep: 'https://www.reinz.co.nz/Web/Web/News/News-Articles/Market-updates/Measured_national_picture_continues_alongside_strong_regional_results.aspx'
};
const BUILTIN = {
  melbourne:[
    {date:'2025-12-31',price:973500,source:SOURCE.melq4},
    {date:'2026-03-31',price:991500,source:SOURCE.melq1},
    {date:'2026-06-30',price:952500,source:SOURCE.melq2},
    {date:'2026-09-30',price:943000,source:SOURCE.melq3}
  ],
  auckland:[
    {date:'2025-12-31',price:1015000,source:SOURCE.akldec},
    {date:'2026-05-31',price:1005000,source:SOURCE.aklmay},
    {date:'2026-08-31',price:950000,source:SOURCE.aklaug},
    {date:'2026-09-30',price:950000,source:SOURCE.aklsep}
  ]
};
const state={ range:90, history:[], spot:null, spotSource:null, spotDate:null, er:null, frank:null, first:'NZD', market:JSON.parse(JSON.stringify(BUILTIN)), toastTimer:null };
const stamp = (d)=>{ const t=new Date(`${d}T12:00:00Z`);return Number.isNaN(t.valueOf())?d:t.toLocaleDateString('zh-CN',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}); };
const dateMs = s => new Date(`${s}T12:00:00Z`).getTime();
const fmt = (v,dec=4)=>Number.isFinite(Number(v))?Number(v).toLocaleString('en-AU',{minimumFractionDigits:dec,maximumFractionDigits:dec}):'—';
const money = (v,cur='AUD') => Number.isFinite(v)?new Intl.NumberFormat('en-AU',{style:'currency',currency:cur,maximumFractionDigits:2}).format(v):'—';
const roundMoney = v => Math.round(v).toLocaleString('en-AU');
const safeText = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('visible');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.remove('visible'),3900)}
function showPage(page){if(!$('page-'+page))return;document.querySelectorAll('.page').forEach(x=>x.classList.toggle('current',x.id==='page-'+page));document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));const headings={overview:'MARKET OVERVIEW',fx:'FX LABORATORY',policy:'POLICY WATCH',housing:'PROPERTY OBSERVATORY',method:'METHODOLOGY'};$('crumb-page').textContent=headings[page];window.scrollTo({top:0,behavior:'instant'});if(location.hash!==`#${page}`)history.replaceState(null,'',`#${page}`);if(page==='fx')renderFX();if(page==='housing')renderHousing();if(page==='overview')renderOverviewChart();}
function drawClock(){const date=new Date();$('mel-clock').textContent='Melbourne · '+new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)}
async function getJson(url,timeout=12000){const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),timeout);try{const r=await fetch(url,{signal:ctrl.signal,cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(timer)}}
const daysAgo=n=>{const d=new Date();d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10)};
async function fetchLive(){
  let dbLatest=null;
  try { const db=await getJson('/api/research-data?kind=fx',9000); const points=Array.isArray(db.points)?db.points:[]; const latest=points.at(-1);
    if(latest && /^\d{4}-\d{2}-\d{2}$/.test(latest.date) && Number.isFinite(latest.rate) && latest.rate>0){dbLatest={rate:latest.rate,date:latest.date,time:dateMs(latest.date)}; $('health-backend').textContent='连接成功 · 已入库';}
  } catch(e){ $('health-backend').textContent='未配置或离线 · 使用公开参考源'; }
  $('fx-live-status').textContent='更新中';$('health-spot').textContent='正在检查';
  let have=false;
  const values=await Promise.allSettled([
    getJson('https://open.er-api.com/v6/latest/NZD'),
    getJson('https://api.frankfurter.dev/v1/latest?base=NZD&symbols=AUD')
  ]);
  if(values[0].status==='fulfilled'){
    const o=values[0].value;
    if(o.result==='success'&&Number.isFinite(o.rates?.AUD)&&o.rates.AUD>0&&Number.isFinite(o.time_last_update_unix)){
      state.er={rate:o.rates.AUD,date:new Date(o.time_last_update_unix*1000).toISOString().slice(0,10),time:o.time_last_update_unix*1000};have=true;
    }
  }
  if(values[1].status==='fulfilled'){
    const o=values[1].value;
    if(Number.isFinite(o.rates?.AUD)&&o.rates.AUD>0&&/^\d{4}-\d{2}-\d{2}$/.test(o.date)){
      state.frank={rate:o.rates.AUD,date:o.date,time:dateMs(o.date)};have=true;
    }
  }
  if(have || dbLatest){
    const fallback=state.er && (!state.frank || state.er.time>=state.frank.time-86400000) ? state.er : state.frank;
    const primary=dbLatest && (!fallback || dbLatest.time >= fallback.time-3*86400000) ? dbLatest : fallback;
    state.spot=primary.rate;state.spotDate=primary.date;state.spotSource=primary===dbLatest?'TASMAN 数据库 / ECB 日度参考价':primary===state.er?'ExchangeRate-API':'Frankfurter / ECB';
    $('fx-live-status').innerHTML='<i></i> 最新可用';$('fx-live-status').classList.remove('error');
    $('overview-rate').textContent=fmt(state.spot,5);$('fx-full-rate').textContent=fmt(state.spot,5);
    $('fx-last-update').textContent=`${state.spotSource} · ${stamp(state.spotDate)} · 非逐秒报价`;
    $('fx-provider-line').textContent=`${state.spotSource} · 报价日期 ${stamp(state.spotDate)} · 免费源每日更新`;
    $('health-spot').textContent='成功 · '+state.spotDate;
  }else{
    $('fx-live-status').innerHTML='<i></i> 未连接';$('fx-live-status').classList.add('error');
    $('overview-rate').textContent='—';$('fx-full-rate').textContent='—';
    $('fx-last-update').textContent='最新报价不可用，请检查网络或稍后刷新';
    $('fx-provider-line').textContent='未获取到实时源，请勿使用旧值计算成交金额';
    $('health-spot').textContent='失败 · 请重试';
    state.spot=null;state.spotDate=null;state.spotSource=null;
  }
  $('fx-secondary').textContent=state.er?fmt(state.er.rate,5):'不可用';
  $('fx-primary').textContent=dbLatest?fmt(dbLatest.rate,5):state.frank?fmt(state.frank.rate,5):'不可用';
  $('rate-comparison').textContent=state.er&&state.frank?`两数据商参考价相差 ${fmt(Math.abs(state.er.rate/state.frank.rate-1)*100,3)}%，可能来自截点和口径不同。`:'当前只有部分报价源可用；不会以虚构数据补齐。';
  updateConverter();updateRatesMetrics();
}
async function fetchHistorical(){
  $('chart-status').textContent='正在获取 Frankfurter 工作日历史数据…';$('health-history').textContent='连接中';
  try{
    try{
      const db=await getJson('/api/research-data?kind=fx',9000);
      const points=(db.points||[]).map(v=>({date:v.date,price:Number(v.rate)})).filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v.date)&&Number.isFinite(v.price)&&v.price>0).sort((a,b)=>a.date.localeCompare(b.date));
      if(points.length>=3){state.history=points;$('health-history').textContent='数据库 · '+points.length+' 点';$('chart-status').textContent=`数据库 ${points.length} 个日度观测点 · 截至 ${stamp(points.at(-1).date)}`;renderOverviewChart();renderFX();return;}
    }catch(e){ /* Supabase not configured: use public reference feed transparently. */ }
    const from=daysAgo(390);
    const o=await getJson(`https://api.frankfurter.dev/v1/${from}..?base=NZD&symbols=AUD`,16000);
    if(!o.rates||typeof o.rates!=='object')throw new Error('格式错误');
    const points=Object.entries(o.rates).map(([date,v])=>({date,price:Number(v?.AUD)})).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isFinite(x.price)&&x.price>0).sort((a,b)=>a.date.localeCompare(b.date));
    if(points.length<3)throw new Error('有效观测点不足');
    state.history=points;
    $('health-history').textContent='成功 · '+points.length+' 点';
    $('chart-status').textContent=`${points.length} 个有效观测点 · 截至 ${stamp(points.at(-1).date)}`;
    renderOverviewChart();renderFX();
  }catch(e){state.history=[];$('chart-status').textContent='历史汇率暂不可用 · 请检查网络';$('health-history').textContent='失败 · 请重试';renderOverviewChart();renderFX()}
}
function filterFX(){return state.history.filter(v=>dateMs(v.date)>=Date.now()-state.range*86400000)}
function renderOverviewChart(){const recent=state.history.filter(v=>dateMs(v.date)>=Date.now()-90*86400000);renderChart($('overview-chart'),[{points:recent,color:'teal'}],{format:v=>fmt(v,4),height:250,area:true, xLabels:3,axis:true});}
function updateRatesMetrics(){
 const a=filterFX();
 if(a.length){const min=Math.min(...a.map(v=>v.price)),max=Math.max(...a.map(v=>v.price));$('fx-low').textContent=fmt(min,5);$('fx-high').textContent=fmt(max,5);
 const last=a.at(-1).price,first=a[0].price,chg=(last/first-1)*100;
 $('fx-period-change').textContent=`${chg>=0?'+':''}${fmt(chg,2)}%`;
 $('fx-period-change').style.color=chg>=0?'var(--teal)':'var(--red)';
 $('fx-observation').textContent=`${a.length} 点`;
 const percentile=a.filter(v=>v.price<=last).length/a.length*100;
 $('fx-percentile').textContent=fmt(percentile,0)+'th';
 const last20=a.slice(-20);$('fx-sma').textContent=fmt(last20.reduce((s,v)=>s+v.price,0)/last20.length,5);
 }else{['fx-low','fx-high','fx-period-change','fx-observation','fx-percentile','fx-sma'].forEach(id=>$(id).textContent='—')}
}
function renderFX(){const a=filterFX();renderChart($('fx-detail-chart'),[{points:a,color:'teal'}],{height:310,format:v=>fmt(v,4),area:true,xLabels:5,axis:true});updateRatesMetrics()}
function updateConverter(){
 const first=state.first,reverse=first==='AUD',rate=reverse?(state.spot?1/state.spot:null):state.spot;
 $('source-unit').textContent=first;$('target-unit').textContent=reverse?'NZD':'AUD';$('amount-symbol').textContent=reverse?'A$':'NZ$';
 $('converter-from').textContent=reverse?'🇦🇺 AUD':'🇳🇿 NZD';$('converter-to').textContent=reverse?'🇳🇿 NZD':'🇦🇺 AUD';
 let amount=Number($('fx-amount').value); if(!Number.isFinite(amount)||amount<0)amount=0;
 const converted=rate!==null?amount*rate:null;
 $('converted-amount').textContent=converted!==null?money(converted,reverse?'NZD':'AUD'):'—';
 const shock=Number($('shock-slider').value)/100;
 $('shock-label').textContent=`${shock>=0?'+':''}${fmt(shock*100,1)}%`;
 $('scenario-conversion').textContent=converted!==null?money(converted*(1+shock),reverse?'NZD':'AUD'):'—';
 $('scenario-diff').textContent=converted!==null?`差额 ${shock>=0?'+':''}${money(converted*shock,reverse?'NZD':'AUD')}`:'请先获取最新参考汇率';
}
function copyCSV(rows,filename){const blob=new Blob([rows.map(r=>r.join(',')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('CSV 已生成，包含数据日期与来源');}
function chartEmpty(el){el.innerHTML='<div class="empty-chart"><span>真实历史数据暂不可用<br/>连接网络后自动显示 · 不使用演示假数据</span></div>'}
function renderChart(el,series,options={}){
  if(!el)return;
  const all=series.flatMap(x=>x.points||[]).filter(x=>Number.isFinite(x.price)&&Number.isFinite(dateMs(x.date))).sort((a,b)=>a.date.localeCompare(b.date));
  if(all.length<2){chartEmpty(el);return;}
  const W=780,H=options.height||250,left=options.axis===false?18:53,right=18,top=19,bottom=options.axis===false?18:36;
  const dataMin=Math.min(...all.map(v=>v.price)),dataMax=Math.max(...all.map(v=>v.price)),delta=dataMax-dataMin,spread=Math.max(delta*0.18,options.minPad|| (Math.abs(dataMin)*0.006),0.000001);
  const lo=dataMin-spread,hi=dataMax+spread;
  const dates=all.map(v=>dateMs(v.date)),xmin=Math.min(...dates),xmax=Math.max(...dates),span=Math.max(1,xmax-xmin);
  const X=d=>left+(dateMs(d)-xmin)/span*(W-left-right);
  const Y=v=>top+(hi-v)/(hi-lo)*(H-top-bottom);
  const pathOf=points=>points.map((p,i)=>`${i?'L':'M'} ${X(p.date).toFixed(2)} ${Y(p.price).toFixed(2)}`).join(' ');
  const fx=options.format|| (v=>fmt(v,1));
  const axisCount=4;
  let svg=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="真实数据趋势图">`;
  const id='fill-'+el.id;
  svg+=`<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#69e2bd" stop-opacity=".20"/><stop offset="1" stop-color="#69e2bd" stop-opacity="0"/></linearGradient></defs>`;
  for(let i=0;i<=axisCount;i++) {const y=top+i*(H-top-bottom)/axisCount;const v=hi-i*(hi-lo)/axisCount;svg+=`<line class="chart-gridline" x1="${left}" y1="${y}" x2="${W-right}" y2="${y}"/>`;if(options.axis!==false)svg+=`<text class="axis-label" x="${left-12}" y="${y+4}" text-anchor="end">${fx(v)}</text>`;}
  for(let i=0;i<(options.xLabels||4);i++){const u=i/((options.xLabels||4)-1||1),v=xmin+span*u;const date=new Date(v).toLocaleDateString('en-AU',{month:'short',year:options.xLabels===3?'2-digit':undefined,timeZone:'UTC'});svg+=`<text class="axis-label" x="${left+u*(W-left-right)}" y="${H-8}" text-anchor="${i===0?'start':i===(options.xLabels||4)-1?'end':'middle'}">${date}</text>`}
  series.forEach((s,i)=>{const pts=(s.points||[]).filter(p=>Number.isFinite(p.price));if(pts.length<2)return;const path=pathOf(pts);const cl=s.color==='amber'?'secondary':'';if(options.area&&i===0){const first=pts[0],last=pts.at(-1);svg+=`<path d="${path} L ${X(last.date)} ${H-bottom} L ${X(first.date)} ${H-bottom} Z" fill="url(#${id})"/>`;}svg+=`<path d="${path}" class="line ${cl}" vector-effect="non-scaling-stroke"/>`;const last=pts.at(-1);svg+=`<circle class="chart-dot ${s.color==='amber'?'orange':''}" cx="${X(last.date)}" cy="${Y(last.price)}" r="4.5" vector-effect="non-scaling-stroke"/>`;});
  svg+=`<line class="hover-line" id="${el.id}-hover" x1="0" y1="${top}" x2="0" y2="${H-bottom}" visibility="hidden"/><rect x="${left}" y="${top}" width="${W-left-right}" height="${H-top-bottom}" fill="transparent" class="hover-region" />`;
  svg+='</svg>';el.innerHTML=svg;
  let tt=el.querySelector('.chart-tooltip');if(!tt){tt=document.createElement('div');tt.className='chart-tooltip';tt.hidden=true;el.appendChild(tt)}
  const overlay=el.querySelector('.hover-region'),line=el.querySelector('.hover-line');
  overlay.addEventListener('pointermove',ev=>{
    const rect=el.querySelector('svg').getBoundingClientRect();let norm=clamp((ev.clientX-rect.left)/rect.width,0,1),xUnits=norm*W,selectedDate=xmin+clamp((xUnits-left)/(W-left-right),0,1)*span;
    let nearest=all.reduce((a,b)=>Math.abs(dateMs(b.date)-selectedDate)<Math.abs(dateMs(a.date)-selectedDate)?b:a);
    const x=X(nearest.date);line.setAttribute('x1',x);line.setAttribute('x2',x);line.setAttribute('visibility','visible');
    let entries=series.map(s=>{const p=(s.points||[]).find(v=>v.date===nearest.date);return p?`${s.name||'报价'}: <b>${safeText(fx(p.price))}</b>`:''}).filter(Boolean);
    tt.innerHTML=`<div style="color:#8fb8ba">${safeText(stamp(nearest.date))}</div>${entries.join('<br/>')||('观测值: <b>'+safeText(fx(nearest.price))+'</b>')}`;
    const posX=clamp((x/W)*rect.width+6,2,Math.max(2,rect.width-145));tt.style.left=posX+'px';tt.style.top=clamp((Y(nearest.price)/H)*rect.height-65,1,Math.max(1,rect.height-72))+'px';tt.hidden=false;
  });
  overlay.addEventListener('pointerleave',()=>{line.setAttribute('visibility','hidden');tt.hidden=true});
}
function dateCompare(a,b){return a.date.localeCompare(b.date)}
function housingPoints(market){return state.market[market].slice().sort(dateCompare)}
function asIndex(market){const pts=housingPoints(market);const baseline=pts.find(x=>x.date==='2025-12-31');if(!baseline)return [];return pts.map(x=>({...x,price:x.price/baseline.price*100}));}
function renderHousing(){
  for(const [market,prefix,currency] of [['melbourne','melb','AUD'],['auckland','akl','NZD']]){
    const points=housingPoints(market),current=points.at(-1),before=points.at(-2);
    if(current){
      $(prefix+'-current').textContent=(currency==='AUD'?'A$':'NZ$')+roundMoney(current.price);
      const chg=before?((current.price/before.price)-1)*100:0;
      $(prefix+'-change').innerHTML=`${chg<0?'↘':'↗'} ${chg>=0?'+':''}${fmt(chg,2)}% <small>较前一观测点（${stamp(before?.date||current.date)}）</small>`;
      $(prefix+'-change').style.color=chg<0?'var(--red)':'var(--teal)';
      $(prefix+'-current-date').textContent=`最近观测：${stamp(current.date)} · 2025 Dec = 基期100${current.source==='User imported CSV'?' · 用户导入':''}`;
    }
  }
  renderChart($('melb-chart'),[{name:'墨尔本',points:asIndex('melbourne'),color:'teal'}],{height:185,format:v=>fmt(v,1),minPad:1,xLabels:3,area:true});
  renderChart($('akl-chart'),[{name:'奥克兰',points:asIndex('auckland'),color:'amber'}],{height:185,format:v=>fmt(v,1),minPad:1,xLabels:3,area:false});
  renderChart($('compare-chart'),[{name:'墨尔本',points:asIndex('melbourne'),color:'teal'},{name:'奥克兰',points:asIndex('auckland'),color:'amber'}],{height:260,format:v=>fmt(v,1),minPad:1,xLabels:4,area:false});
}
function getSavedHousing(){try{const s=localStorage.getItem('tasman-user-housing-v1');if(!s)return;const d=JSON.parse(s);if(!d||typeof d!=='object')return;for(const m of ['melbourne','auckland'])if(Array.isArray(d[m]))state.market[m]=mergePoints(state.market[m],d[m].filter(p=>p.source==='User imported CSV'));}catch(e){console.warn('Housing data load skipped:',e)}}
function mergePoints(a,b){const base=new Map(a.map(p=>[p.date,p]));for(const p of b){if(p&&/^\d{4}-\d{2}-\d{2}$/.test(p.date)&&Number.isFinite(p.price)&&p.price>1000&&p.price<100000000)base.set(p.date,{date:p.date,price:p.price,source:p.source||'User import'});}return [...base.values()].sort(dateCompare)}
function parseCSV(text){const out=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted}else if(c===','&&!quoted){row.push(cell);cell=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))out.push(row);row=[];cell=''}else cell+=c}row.push(cell);if(row.some(v=>v.trim()))out.push(row);return out}
async function importHousing(event){const f=event.target.files?.[0];if(!f)return;try{if(f.size>2e6)throw new Error('文件超过 2 MB');const rows=parseCSV(await f.text());if(rows.length<2)throw new Error('CSV 为空');const headers=rows[0].map(x=>x.trim().toLowerCase());const idx=['market','date','price'].map(k=>headers.indexOf(k));if(idx.some(i=>i<0))throw new Error('需要 market,date,price 三列');let changes=0,bad=0;for(const cells of rows.slice(1)){const [market,date,p]=idx.map(i=>(cells[i]||'').trim());const price=Number(p);const m=market.toLowerCase();const validDate=/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(dateMs(date));if(!['melbourne','auckland'].includes(m)||!validDate||!Number.isFinite(price)||price<=1000||price>=1e8){bad++;continue}state.market[m]=mergePoints(state.market[m],[{date,price,source:'User imported CSV'}]);changes++}
if(!changes)throw new Error(`没有有效记录（${bad} 行跳过）`);
let saved=true;try{localStorage.setItem('tasman-user-housing-v1',JSON.stringify(state.market))}catch(e){saved=false}renderHousing();$('import-message').textContent=`成功导入 ${changes} 行${bad?'，跳过 '+bad+' 行':''}。${saved?'已保存到本浏览器':'当前环境不允许本地持久化，请导出 CSV 保存。'}`;toast('历史数据已导入；注意用户数据来源未验证。');}catch(e){$('import-message').textContent='导入失败：'+e.message;toast('导入失败：'+e.message)}event.target.value=''}
async function fetchBackendHousing(){
  try{
    const data=await getJson('/api/research-data?kind=housing',9000);
    if(!Array.isArray(data.points)||!data.points.length)throw new Error('No versioned property points');
    for(const market of ['melbourne','auckland']){
      const list=data.points.filter(p=>p.market===market&&Number.isFinite(p.price)&&p.price>1000&&/^\d{4}-\d{2}-\d{2}$/.test(p.date))
        .map(p=>({date:p.date,price:p.price,source:p.source}));
      state.market[market]=mergePoints(BUILTIN[market],list);
    }
    getSavedHousing();renderHousing();
    $('health-housing').textContent='数据库已连接 · '+data.points.length+' 条版本化数据';
  }catch(e){$('health-housing').textContent='内置历史快照 · 暂无云端新数据';}
}
async function fetchBackendStatus(){
  try{const db=await getJson('/api/research-data?kind=status',9000);const runs=db.runs||[];
    const latest=runs[0];
    $('health-backend').textContent=latest?`已连接 · ${latest.source_key} ${latest.status==='success'?'成功':'失败'}`:'已连接 · 等待首次采集';
    $('backend-status-details').textContent=latest?`最近采集：${latest.source_key} / ${latest.status} / ${new Date(latest.completed_at).toLocaleString('zh-CN',{timeZone:'Australia/Melbourne'})}。最新入库汇率日期：${db.fx_latest_date||'尚无'}。`:'数据库已配置，但尚未运行采集任务。';
  }catch(e){$('health-backend').textContent='未配置 / 不可用';$('backend-status-details').textContent='数据库尚未连接。免费公开汇率源可独立运行；云端版本化与定时采集需要先配置 Supabase 和 GitHub Actions。';}
}
function isOfficialURL(url){try{const u=new URL(url);return u.protocol==='https:'&&['www.rba.gov.au','www.rbnz.govt.nz'].includes(u.hostname)}catch(e){return false}}
function displayFeed(items,extra){items=(items||[]).filter(x=>isOfficialURL(x.url));const root=$('policy-feed');if(!items?.length){root.innerHTML=`<div class="feed-empty">${safeText(extra||'当前没有可访问的官方更新。请直接打开官方来源核对最新政策。')}</div>`;return;}root.innerHTML=`${extra?`<div class="feed-empty">${safeText(extra)}</div>`:''}`+items.map(it=>`<div class="feed-item"><div><b>${safeText(it.title)}</b><small>${safeText(it.source)} · ${safeText(it.date||'发布日期未核验')} · 官方消息标题（不代替正文）</small></div><a href="${it.url}" target="_blank" rel="noopener noreferrer">原文 ↗</a></div>`).join('');}
async function loadPolicyNews(){ $('policy-feed').innerHTML='<div class="feed-empty">连接官方公告数据库中…</div>';$('health-news').textContent='检测中';try{let resp;try{resp=await getJson('/api/research-data?kind=news',9000);if(!resp.items?.length)throw new Error('No stored news');}catch(e){resp=await getJson('/api/policy-news',11000);}if(!Array.isArray(resp.items))throw new Error('服务器未返回结构化结果');const extra=(resp.warnings||[]).join('；');displayFeed(resp.items,extra?`部分来源访问受限：${extra}`:'');$('health-news').textContent=resp.items.length?`已收到 ${resp.items.length} 条公告`:'未取得新公告';}catch(e){$('health-news').textContent='不可用 · 本地/未部署';displayFeed([], '官方公告代理尚未部署或目前不可用。此处不会把旧的政策快照伪称为最新公告；请访问 RBA / RBNZ 官方网站核验。')}}
function install(){
 document.querySelectorAll('[data-page]').forEach(x=>x.addEventListener('click',()=>showPage(x.dataset.page)));
 document.querySelectorAll('[data-goto]').forEach(x=>x.addEventListener('click',()=>showPage(x.dataset.goto)));
 document.querySelectorAll('[data-range]').forEach(x=>x.addEventListener('click',()=>{state.range=Number(x.dataset.range);document.querySelectorAll('[data-range]').forEach(b=>b.classList.toggle('selected',b===x));renderFX()}));
 $('fx-amount').addEventListener('input',updateConverter);$('swap-currency').addEventListener('click',()=>{state.first=state.first==='NZD'?'AUD':'NZD';updateConverter()});$('shock-slider').addEventListener('input',updateConverter);
 $('btn-refresh').addEventListener('click',async()=>{toast('正在获取最新可用数据…');await Promise.allSettled([fetchLive(),fetchHistorical(),loadPolicyNews(),fetchBackendHousing(),fetchBackendStatus()]);toast('已完成在线数据检查，请查看各数据源状态')});
 $('policy-fetch').addEventListener('click',loadPolicyNews);$('check-health').addEventListener('click',()=>Promise.allSettled([fetchLive(),fetchHistorical(),loadPolicyNews(),fetchBackendHousing(),fetchBackendStatus()]));
 $('download-fx').addEventListener('click',()=>{if(!state.history.length){toast('历史数据尚未加载，无法导出');return}copyCSV([['date','base','quote','rate','source'],...state.history.map(p=>[p.date,'NZD','AUD',p.price,'Frankfurter / ECB'])],'tasman-NZD-AUD-history.csv')});
 $('download-property').addEventListener('click',()=>copyCSV([['market','date','price','currency','definition','source'],...Object.entries(state.market).flatMap(([m,points])=>points.map(p=>[m,p.date,p.price,m==='melbourne'?'AUD':'NZD',m==='melbourne'?'Metro house transaction median':'Region all-dwelling transaction median',p.source]))],'tasman-property-verified-sources.csv'));
 $('housing-file').addEventListener('change',importHousing);
 $('reset-housing').addEventListener('click',()=>{state.market=JSON.parse(JSON.stringify(BUILTIN));try{localStorage.removeItem('tasman-user-housing-v1')}catch(e){};$('import-message').textContent='已恢复内置数据。';renderHousing();toast('已恢复已核对的研究数据')});
 window.addEventListener('hashchange',()=>{const page=location.hash.replace('#','');if(['overview','fx','policy','housing','method'].includes(page))showPage(page)});
 drawClock();setInterval(drawClock,60000);getSavedHousing();renderHousing();renderOverviewChart();renderFX();updateConverter();const page=location.hash.replace('#','');showPage(['overview','fx','policy','housing','method'].includes(page)?page:'overview');
 // Live data is fetched only from documented public endpoints. Does not imply streaming market data.
 Promise.allSettled([fetchLive(),fetchHistorical(),loadPolicyNews(),fetchBackendHousing(),fetchBackendStatus()]);
 // Free quotes refresh daily; hourly recheck while the dashboard is open (not tick streaming).
 setInterval(()=>{if(!document.hidden)fetchLive()},60*60*1000);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
