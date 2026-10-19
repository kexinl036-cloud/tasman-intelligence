import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import os
from decimal import Decimal

PATH = Path(__file__).resolve().parents[1] / 'ingest.py'
spec = importlib.util.spec_from_file_location('ingest', PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class IngestTests(unittest.TestCase):
 def test_fx_cross_rate_on_matching_dates(self):
  raw=[{'date':'2026-10-15','base':'EUR','quote':'AUD','rate':1.62},
       {'date':'2026-10-15','base':'EUR','quote':'NZD','rate':1.9},
       {'date':'2026-10-16','base':'EUR','quote':'AUD','rate':1.6},
       {'date':'2026-10-17','base':'EUR','quote':'NZD','rate':1.88}]
  points=mod.fx_payload(raw,mod.ECB)
  self.assertEqual(len(points),1)
  self.assertEqual(points[0]['observed_on'],'2026-10-15')
  self.assertAlmostEqual(float(points[0]['value']),1.62/1.9,places=7)
  self.assertEqual(points[0]['source_url'],mod.ECB)
  self.assertTrue(points[0]['metadata']['daily_reference_not_spot'])
 def test_fx_bad_rate_rejected(self):
  with self.assertRaises(ValueError):mod.fx_payload([{'date':'2026-10-19','base':'EUR','quote':'AUD','rate':'NaN'}],mod.ECB)
 def test_no_pair_rejected(self):
  with self.assertRaises(ValueError):mod.fx_payload([{'date':'2026-10-19','base':'EUR','quote':'AUD','rate':1.6}],mod.ECB)
 def test_hash_stable_field_order(self):
  self.assertEqual(mod.snapshot_digest({'a':1,'b':2}), mod.snapshot_digest({'b':2,'a':1}))
  self.assertNotEqual(mod.snapshot_digest({'a':1}), mod.snapshot_digest({'a':2}))
 def test_hosts_enforced(self):
  self.assertTrue(mod.official_url('https://www.rba.gov.au/media-releases/',{'www.rba.gov.au'}))
  for u in ['http://www.rba.gov.au/','https://www.rba.gov.au.attacker.org/', 'https://localhost/', 'file:///etc/passwd','https://a:secret@www.rba.gov.au/']:
   self.assertFalse(mod.official_url(u,{'www.rba.gov.au'}))
 def test_rba_parse(self):
  xml=b'<rss><channel><item><title>Statement by the Monetary Policy Board</title><link>https://www.rba.gov.au/media-releases/2026/mr-26-27.html</link><pubDate>Tue, 29 Sep 2026 14:30:00 +1000</pubDate></item></channel></rss>'
  articles=mod.parse_rba_rss(xml)
  self.assertEqual(articles[0]['published_on'],'2026-09-29')
  self.assertEqual(len(articles),1)
 def test_rbnz_parse_allowlist(self):
  html=b'<a href="/news-and-events/news/a-real-story">Important New Zealand monetary policy briefing</a><a href="https://evil.test/news-and-events/news/fake">Untrusted long news headline</a>'
  articles=mod.parse_rbnz_news(html)
  self.assertEqual(len(articles),1)
  self.assertIn('www.rbnz.govt.nz',articles[0]['article_url'])
 def test_housing_rejects_bad_source(self):
  csv='market,date,price,source_url\nmelbourne,2026-09-30,943000,https://wrong.test/data\n'
  with self.assertRaises(ValueError):mod.parse_housing_csv(csv,{'reiv.com.au'})
 def test_housing_valid_with_metric_definition(self):
  csv='market,date,price,source_url\nmelbourne,2026-09-30,943000,https://reiv.com.au/news/story\n'
  r=mod.parse_housing_csv(csv,{'reiv.com.au'})
  self.assertEqual(r[0]['unit'],'metro_house_sale_median')
  self.assertEqual(r[0]['evidence_status'],'curated')
 def test_policy_approved_required(self):
  with patch.dict(os.environ, {'POLICY_CSV_PATH':str(PATH.parent/'data'/'policy-REVIEW-BEFORE-IMPORT.csv')}):
   with self.assertRaises(ValueError):mod.collect_verified_policy()
 def test_new_secret_api_key_uses_apikey_header_only(self):
  class MockResponse:
   def __enter__(self): return self
   def __exit__(self,*args): pass
   def read(self,n): return b'{"ok":true}'
  requests=[]
  def fake_open(req,timeout):
   requests.append(req)
   return MockResponse()
  with patch.dict(os.environ,{'SUPABASE_URL':'https://example.supabase.co','SUPABASE_SECRET_KEY':'sb_secret_synthetic-example'},clear=True):
   with patch.object(mod,'urlopen',fake_open):
    self.assertEqual(mod.backend_rpc('tasman_ingest_batch',{}),{'ok':True})
  self.assertEqual(requests[0].get_header('Apikey'),'sb_secret_synthetic-example')
  self.assertIsNone(requests[0].get_header('Authorization'))
 def test_legacy_service_role_key_still_supported(self):
  class MockResponse:
   def __enter__(self): return self
   def __exit__(self,*args): pass
   def read(self,n): return b'{"ok":true}'
  requests=[]
  def fake_open(req,timeout):
   requests.append(req)
   return MockResponse()
  with patch.dict(os.environ,{'SUPABASE_URL':'https://example.supabase.co','SUPABASE_SERVICE_ROLE_KEY':'synthetic-jwt-key'},clear=True):
   with patch.object(mod,'urlopen',fake_open):
    self.assertEqual(mod.backend_rpc('tasman_ingest_batch',{}),{'ok':True})
  self.assertEqual(requests[0].get_header('Authorization'),'Bearer synthetic-jwt-key')
 def test_empty_key_rpc_fails_cleanly(self):
  with patch.dict(os.environ,{'SUPABASE_URL':'https://example.supabase.co','SUPABASE_SERVICE_ROLE_KEY':''},clear=True):
   with self.assertRaises(RuntimeError):mod.backend_rpc('tasman_ingest_batch',{})

if __name__=='__main__': unittest.main()
