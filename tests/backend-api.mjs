import { strict as assert } from 'node:assert';
import handler from '../netlify/functions/research-data.mjs';
const saved={...process.env};
try {
  delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SERVICE_ROLE_KEY;delete process.env.SUPABASE_SECRET_KEY;
  let r=await handler(new Request('https://tasman.example.com/api/research-data?kind=fx'));
  assert.equal(r.status,503);assert.equal((await r.json()).error,'DB_NOT_CONFIGURED');
  r=await handler(new Request('https://tasman.example.com/api/research-data?kind=invalid'));
  assert.equal(r.status,400);
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test-synthetic-secret';
  const original=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{
    assert(url.startsWith('https://example.supabase.co/rest/v1/'));
    assert.equal(options.headers.apikey,'test-synthetic-secret');
    if(url.includes('current_observations'))return new Response(JSON.stringify([
      {observed_on:'2026-10-14',value:'0.84300000',revision_no:1,source_url:'https://api.frankfurter.dev/v2/providers/ecb/rates'},
      {observed_on:'2026-10-15',value:'0.84100000',revision_no:2,source_url:'https://api.frankfurter.dev/v2/providers/ecb/rates'}
    ]),{status:200,headers:{'content-type':'application/json'}});
    throw Error('Unexpected test URL: '+url);
  };
  r=await handler(new Request('https://tasman.example.com/api/research-data?kind=fx'));
  assert.equal(r.status,200);
  const d=await r.json();assert.equal(d.points.length,2);assert.equal(d.points[0].date,'2026-10-15');
  assert.equal(d.points[0].rate,0.841);
  assert.equal(d.points[0].revision,2);
  process.env.SUPABASE_SECRET_KEY='sb_secret_test-synthetic';
  globalThis.fetch=async (url,options)=>{
    assert.equal(options.headers.apikey,'sb_secret_test-synthetic');
    assert.equal(options.headers.Authorization,undefined);
    return new Response(JSON.stringify([]),{status:200,headers:{'content-type':'application/json'}});
  };
  r=await handler(new Request('https://tasman.example.com/api/research-data?kind=fx'));
  assert.equal(r.status,200);
  globalThis.fetch=original;
  console.log('PASS: unconfigured backend, kind allowlist, read-only API, versioned FX records');
} finally{process.env=saved;}
