/* Safe allowlist server-side proxy for public central-bank official announcements.
   Extracts titles + verified official URLs only. No claims that titles are a policy summary.
   Note: RSS WAFs can block hosted functions; errors are exposed to the client. */
const SOURCES=[
  {name:'RBA',url:'https://www.rba.gov.au/rss/rss-cb-media-releases.xml',kind:'rss',home:'https://www.rba.gov.au'},
  {name:'RBNZ',url:'https://www.rbnz.govt.nz/news-and-events/news',kind:'html',home:'https://www.rbnz.govt.nz'}
];
function decode(s){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/<[^>]+>/g,'').trim()}
function isTrusted(url,origin){try{const u=new URL(url,origin);return u.protocol==='https:'&&(u.hostname==='www.rba.gov.au'||u.hostname==='www.rbnz.govt.nz')}catch{return false}}
function parseRSS(xml,src){const records=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0,18);return records.map((m)=>{let content=m[1];const field=(tag)=>{const mm=content.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));return mm?decode(mm[1]):''};const title=field('title'),url=field('link'),date=field('pubDate');return {title: title.slice(0,220),url,source:src.name,date:date?new Date(date).toISOString().slice(0,10):''}}).filter(r=>r.title&&isTrusted(r.url,src.home))}
function parseRBNZ(html,src){ // Conservative: only page-local links, never synthesized headlines.
 const links=[...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];const seen=new Set();const out=[];
 for(const m of links){const link=new URL(m[1],src.home).toString(),title=decode(m[2]).replace(/\s+/g,' ').trim();if(!isTrusted(link,src.home)||!link.includes('/news-and-events/news/')||title.length<18||title.length>180||seen.has(link))continue;seen.add(link);out.push({title,url:link,date:'',source:src.name});if(out.length>=7)break}return out;
}
export default async (request,context)=>{
 if(request.method!=='GET')return new Response('Method not allowed',{status:405});
 const results=await Promise.all(SOURCES.map(async src=>{try{const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),6500);let res;try{res=await fetch(src.url,{signal:ctrl.signal,headers:{'Accept':src.kind==='rss'?'application/rss+xml,application/xml;q=0.9':'text/html','User-Agent':'TasmanResearch/1.0 (public market research)'},redirect:'follow'})}finally{clearTimeout(t)}if(!res.ok)throw new Error(`HTTP ${res.status}`);const doc=(await res.text()).slice(0,1100000);const items=src.kind==='rss'?parseRSS(doc,src):parseRBNZ(doc,src);return {items,warning:items.length?'':`${src.name}: 网页结构未匹配，暂无可核验标题`}}catch(e){return {items:[],warning:`${src.name}: ${String(e.message).slice(0,100)}`}}}));
 const items=results.flatMap(x=>x.items).slice(0,12),warnings=results.map(x=>x.warning).filter(Boolean);
 return new Response(JSON.stringify({items,warnings,retrieved_at:new Date().toISOString(),data_type:'official_article_titles_only',policy_metrics_auto_updated:false}),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=0, s-maxage=900','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'}});
};
