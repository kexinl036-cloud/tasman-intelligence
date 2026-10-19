/** Read-only JSON API facade for versioned Supabase Postgres observations.
 * The service-role key NEVER leaves this serverless function. */
const SERIES=['fx_nzd_aud_ecb','housing_melbourne_house_median_aud','housing_auckland_all_dwelling_median_nzd',
  'policy_rba_cash_target_pct','policy_rbnz_ocr_pct'];
const HEADERS={'Content-Type':'application/json; charset=utf-8','Cache-Control':'public,max-age=0,s-maxage=300','X-Content-Type-Options':'nosniff'};
const respond=(payload,status=200)=>new Response(JSON.stringify(payload),{status,headers:HEADERS});
async function supabaseFetch(path){
  const rawUrl=process.env.SUPABASE_URL||'';
  const key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(rawUrl)||!key)throw new Error('DB_NOT_CONFIGURED');
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),7500);
  try{
    const r=await fetch(rawUrl.replace(/\/$/,'')+'/rest/v1/'+path,{headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),Accept:'application/json'},signal:ctrl.signal});
    if(!r.ok)throw new Error(`DB_HTTP_${r.status}`);
    const j=await r.json();if(!Array.isArray(j))throw new Error('DB_INVALID_SHAPE');return j;
  }finally{clearTimeout(timer)}
}
export default async function handler(request){
 if(request.method!=='GET')return respond({error:'METHOD_NOT_ALLOWED'},405);
 const url=new URL(request.url);const kind=url.searchParams.get('kind')||'fx';
 if(!['fx','housing','news','policy','status'].includes(kind))return respond({error:'INVALID_KIND'},400);
 try{
  if(kind==='fx'){
   const rows=await supabaseFetch(`tasman_current_observations?select=series_key,observed_on,value,currency,source_url,revision_no,recorded_at,metadata&series_key=eq.fx_nzd_aud_ecb&order=observed_on.desc&limit=650`);
   return respond({kind,source:'ECB through Frankfurter v2, daily reference',points:rows.reverse().map(r=>({date:r.observed_on,rate:Number(r.value),revision:r.revision_no,source_url:r.source_url})),retrieved_at:new Date().toISOString()});
  }
  if(kind==='housing'){
   const filter=SERIES.slice(1,3).join(',');
   const rows=await supabaseFetch(`tasman_current_observations?select=series_key,observed_on,value,currency,source_url,revision_no,recorded_at,metadata&series_key=in.(${filter})&order=observed_on.asc&limit=1200`);
   return respond({kind,points:rows.map(r=>({market:r.series_key.includes('melbourne')?'melbourne':'auckland',date:r.observed_on,price:Number(r.value),currency:r.currency,source:r.source_url,revision:r.revision_no,metadata:r.metadata})),retrieved_at:new Date().toISOString()});
  }
  if(kind==='policy'){
   const rows=await supabaseFetch(`tasman_current_observations?select=series_key,observed_on,value,source_url,evidence_status,recorded_at&series_key=in.(${SERIES.slice(3).join(',')})&order=observed_on.desc&limit=150`);
   return respond({kind,policy:rows.map(r=>({bank:r.series_key.includes('rba')?'RBA':'RBNZ',date:r.observed_on,rate_pct:Number(r.value),source_url:r.source_url,status:r.evidence_status})),retrieved_at:new Date().toISOString()});
  }
  if(kind==='news'){
   const rows=await supabaseFetch('tasman_current_articles?select=source_key,article_url,title,published_on,review_status,revision_no,recorded_at&order=recorded_at.desc&limit=30');
   return respond({kind,items:rows.map(r=>({source:r.source_key==='rba_media'?'RBA':'RBNZ',url:r.article_url,title:r.title,date:r.published_on||'',status:r.review_status,revision:r.revision_no})),retrieved_at:new Date().toISOString(),summarized:false});
  }
  const [runs,fx,housing]=await Promise.all([
    supabaseFetch('tasman_ingestion_runs?select=source_key,status,completed_at,new_versions,article_versions,detail&order=run_id.desc&limit=25'),
    supabaseFetch('tasman_current_observations?select=observed_on&series_key=eq.fx_nzd_aud_ecb&order=observed_on.desc&limit=1'),
    supabaseFetch(`tasman_current_observations?select=series_key,observed_on&series_key=in.(${SERIES.slice(1,3).join(',')})&order=observed_on.desc&limit=20`)
  ]);
  return respond({kind,runs,fx_latest_date:fx[0]?.observed_on||null,housing_latest_date:{melbourne:housing.find(r=>r.series_key.includes('melbourne'))?.observed_on||null,auckland:housing.find(r=>r.series_key.includes('auckland'))?.observed_on||null},retrieved_at:new Date().toISOString()});
 }catch(err){const unconfigured=err.message==='DB_NOT_CONFIGURED';
  return respond({error:unconfigured?'DB_NOT_CONFIGURED':'DB_UNAVAILABLE',detail:unconfigured?'Set SUPABASE_URL and SUPABASE_SECRET_KEY on Netlify':'Secure backend query failed (details in server logs)'},unconfigured?503:502);
 }
}
