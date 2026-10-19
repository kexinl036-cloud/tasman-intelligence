#!/usr/bin/env python3
"""TASMAN scheduled ETL. Stdlib-only. All writes are atomic via a Postgres RPC.

Usage: python backend/ingest.py fx | fx-backfill | news | housing | policy
Requires SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) for persistence.
"""
from __future__ import annotations
import csv
from datetime import date, timedelta, datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
from html.parser import HTMLParser
from io import StringIO
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse, urljoin
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

RBA_RSS = 'https://www.rba.gov.au/rss/rss-cb-media-releases.xml'
RBNZ_NEWS = 'https://www.rbnz.govt.nz/news-and-events/news'
ECB = 'https://api.frankfurter.dev/v2/providers/ecb/rates'
SERIES = {
    'melbourne': ('housing_melbourne_house_median_aud', 'AUD', 'metro_house_sale_median', 'quarter'),
    'auckland': ('housing_auckland_all_dwelling_median_nzd', 'NZD', 'regional_all_dwelling_sale_median', 'month'),
}
POLICY = {
    'rba': ('policy_rba_cash_target_pct', 'https://www.rba.gov.au/'),
    'rbnz': ('policy_rbnz_ocr_pct', 'https://www.rbnz.govt.nz/'),
}


def official_url(value: str, allowed_hosts: set[str]) -> bool:
    try:
        u = urlparse(value)
        return u.scheme == 'https' and u.hostname in allowed_hosts and u.username is None and u.password is None and u.port in (None, 443)
    except ValueError:
        return False


def request_bytes(url: str, allowed_hosts: set[str], max_bytes: int = 1300000) -> bytes:
    if not official_url(url, allowed_hosts):
        raise ValueError(f'Unapproved remote host: {url}')
    req = Request(url, headers={'User-Agent': 'TasmanIntelligence/2.0 data researcher', 'Accept': 'application/json,application/rss+xml,text/html,text/csv'})
    with urlopen(req, timeout=18) as resp:
        final_url = resp.url
        if not official_url(final_url, allowed_hosts):
            raise ValueError('Redirect left allowlist')
        data = resp.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError('Upstream response exceeded configured limit')
        return data


def iso_date(value: str) -> str:
    return date.fromisoformat(str(value)).isoformat()


def canonical_payload(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def snapshot_digest(data):
    return hashlib.sha256(canonical_payload(data).encode('utf8')).hexdigest()


def fx_payload(raw: list[dict], url: str):
    """ECB quotes for EUR/AUD and EUR/NZD => NZD/AUD = EUR/AUD ÷ EUR/NZD."""
    if not isinstance(raw, list):
        raise ValueError('Expected Frankfurter V2 array')
    by_date = {}
    for record in raw:
        if not isinstance(record, dict):
            continue
        if record.get('base') != 'EUR' or record.get('quote') not in ('AUD', 'NZD'):
            continue
        d = iso_date(record['date'])
        try:
            rate = Decimal(str(record['rate']))
        except (InvalidOperation, TypeError):
            raise ValueError('Malformed upstream quote')
        if not rate.is_finite() or not (Decimal('0.1') < rate < Decimal('100')):
            raise ValueError('Out-of-range EUR quote')
        by_date.setdefault(d, {})[record['quote']] = rate
    rows = []
    for d, pair in sorted(by_date.items()):
        if not {'AUD', 'NZD'}.issubset(pair):
            continue
        value = pair['AUD'] / pair['NZD']
        if not Decimal('0.3') <= value <= Decimal('2.0'):
            raise ValueError(f'Implausible NZD/AUD derived rate for {d}')
        rows.append({
            'series_key': 'fx_nzd_aud_ecb', 'observed_on': d, 'value': str(value.quantize(Decimal('.00000001'))),
            'currency': 'AUD', 'unit': 'AUD_per_1_NZD', 'source_url': ECB,
            'evidence_status': 'provider_data',
            'metadata': {'provider': 'ECB through Frankfurter v2', 'derivation': 'EUR/AUD divided by EUR/NZD',
                         'eur_aud': str(pair['AUD']), 'eur_nzd': str(pair['NZD']), 'daily_reference_not_spot': True}
        })
    if not rows:
        raise ValueError('No same-day EUR/AUD and EUR/NZD pairs returned')
    if len(rows) > 1800:
        raise ValueError('Unexpected number of daily observations')
    return rows


def collect_fx(backfill=False):
    today = date.today()
    from_date = date(2023, 1, 1) if backfill else today - timedelta(days=45)
    url = ECB + '?' + urlencode({'base': 'EUR', 'quotes': 'AUD,NZD', 'from': from_date.isoformat(), 'to': today.isoformat()})
    raw = json.loads(request_bytes(url, {'api.frankfurter.dev'}))
    rows = fx_payload(raw, url)
    # deterministic snapshot that is independent of whitespace / JSON field order
    return 'fx_ecb', url, raw, rows, []


def parse_rba_rss(doc: bytes) -> list[dict]:
    root = ET.fromstring(doc)
    items = []
    for element in root.findall('.//item')[:40]:
        title = ' '.join((element.findtext('title') or '').split())
        link = (element.findtext('link') or '').strip()
        pub = element.findtext('pubDate') or ''
        published = None
        if pub:
            from email.utils import parsedate_to_datetime
            try:
                published = parsedate_to_datetime(pub).date().isoformat()
            except (ValueError, TypeError):
                pass
        if 8 <= len(title) <= 280 and official_url(link, {'www.rba.gov.au'}):
            items.append({'article_url': link, 'title': title, 'published_on': published})
    if not items:
        raise ValueError('No trustworthy RBA RSS items found; inspect feed structure')
    return items


class OfficialLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.href = None
        self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.href = dict(attrs).get('href')
            self.parts = []
    def handle_data(self, data):
        if self.href is not None:
            self.parts.append(data)
    def handle_endtag(self, tag):
        if tag == 'a' and self.href:
            self.links.append((self.href, ' '.join(' '.join(self.parts).split())))
            self.href = None
            self.parts = []


def parse_rbnz_news(doc: bytes) -> list[dict]:
    parser = OfficialLinks()
    parser.feed(doc.decode('utf8', 'replace'))
    items = []
    seen = set()
    for href, title in parser.links:
        url = urljoin(RBNZ_NEWS, href)
        if not official_url(url, {'www.rbnz.govt.nz'}):
            continue
        if '/news-and-events/news/' not in urlparse(url).path or not 12 <= len(title) <= 280 or url in seen:
            continue
        seen.add(url)
        items.append({'article_url': url, 'title': title, 'published_on': None})
        if len(items) >= 40:
            break
    if not items:
        raise ValueError('No verified RBNZ article links; site may have changed')
    return items


def collect_news():
    yield 'rba_media', RBA_RSS, (doc := request_bytes(RBA_RSS, {'www.rba.gov.au'})).decode('utf8','replace'), [], parse_rba_rss(doc)
    yield 'rbnz_news', RBNZ_NEWS, (doc := request_bytes(RBNZ_NEWS, {'www.rbnz.govt.nz'})).decode('utf8','replace'), [], parse_rbnz_news(doc)


def parse_housing_csv(text: str, trusted_hosts: set[str]):
    reader = csv.DictReader(StringIO(text))
    required = {'market', 'date', 'price', 'source_url'}
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        raise ValueError(f'Housing CSV requires {sorted(required)}')
    rows = []
    for line, rec in enumerate(reader, start=2):
        market = (rec.get('market') or '').strip().lower()
        if market not in SERIES:
            raise ValueError(f'Unknown market on line {line}')
        key, currency, definition, frequency = SERIES[market]
        observed_on = iso_date(rec['date'].strip())
        price = Decimal((rec['price'] or '').strip())
        url = (rec.get('source_url') or '').strip()
        if not price.is_finite() or not Decimal('10000') <= price <= Decimal('10000000'):
            raise ValueError(f'Implausible median on line {line}')
        if not official_url(url, trusted_hosts):
            raise ValueError(f'Untrusted source URL on line {line}')
        rows.append({'series_key': key, 'observed_on': observed_on, 'value': str(price),
                     'currency': currency, 'unit': definition, 'source_url': url, 'evidence_status':'curated',
                     'metadata': {'market':market,'frequency': frequency,'property_type':definition,
                                  'operator_verified':(rec.get('operator_verified','no').strip().lower()=='yes')}})
    if not rows:
        raise ValueError('Empty housing dataset')
    if len(rows) > 3000:
        raise ValueError('Housing dataset too large')
    return rows


def collect_housing():
    file_path = os.getenv('HOUSING_CSV_PATH', '').strip()
    feed_url = os.getenv('HOUSING_FEED_URL', '').strip()
    if bool(file_path) == bool(feed_url):
        raise ValueError('Specify exactly one of HOUSING_CSV_PATH or HOUSING_FEED_URL (licensed data only)')
    if feed_url:
        # Never blindly scrape arbitrary property sites. Only an explicitly licensed feed.
        if os.getenv('HOUSING_FEED_AUTHORIZED','').lower() != 'true':
            raise ValueError('HOUSING_FEED_AUTHORIZED=true required for remote property feed')
        host = os.getenv('HOUSING_FEED_HOST','').strip().lower()
        if not host or host in ('localhost','127.0.0.1') or not official_url(feed_url,{host}):
            raise ValueError('HOUSING_FEED_HOST mismatch')
        raw_bytes=request_bytes(feed_url, {host})
        csvtext=raw_bytes.decode('utf-8-sig')
        url=feed_url
        hosts={host,'www.reiv.com.au','reiv.com.au','www.reinz.co.nz','www.knowledgeauckland.org.nz'}
    else:
        csvtext=Path(file_path).read_text(encoding='utf-8-sig')
        url='https://reiv.com.au/market-insights/about-our-research'  # identity of curated dataset, not a CSV download URL
        hosts={'www.reiv.com.au','reiv.com.au','www.reinz.co.nz','www.knowledgeauckland.org.nz'}
    rows=parse_housing_csv(csvtext,hosts)
    raw={'data_kind':'authorized_property_csv','file_or_url': feed_url or Path(file_path).name,
         'content_sha256':hashlib.sha256(csvtext.encode()).hexdigest(),
         'source_rows':list(csv.DictReader(StringIO(csvtext)))}
    return 'housing_curated',url,raw,rows,[]


def collect_verified_policy():
    # Unlike headlines this is a human-reviewed import. No unverified OCR estimates.
    file_path=os.getenv('POLICY_CSV_PATH','').strip()
    if not file_path:
        raise ValueError('POLICY_CSV_PATH missing')
    content=Path(file_path).read_text(encoding='utf-8-sig')
    reader=csv.DictReader(StringIO(content))
    if not reader.fieldnames or not {'bank','date','rate_pct','source_url','reviewer','approved'}.issubset(reader.fieldnames):
        raise ValueError('Policy CSV requires bank,date,rate_pct,source_url,reviewer,approved')
    rows=[]
    for rec in reader:
        bank=rec['bank'].strip().lower()
        if bank not in POLICY or rec['approved'].strip().lower()!='yes' or not rec['reviewer'].strip():
            raise ValueError('Policy requires named reviewer and approved=yes')
        key, prefix=POLICY[bank]
        url=rec['source_url'].strip()
        if not official_url(url,{urlparse(prefix).hostname}):
            raise ValueError('Policy URL must be official')
        value=Decimal(rec['rate_pct'].strip())
        if not value.is_finite() or not Decimal('0') <= value < Decimal('20'):
            raise ValueError('Invalid policy interest rate')
        rows.append({'series_key':key,'observed_on':iso_date(rec['date']),'value':str(value),
                     'currency':'PCT','unit':'percent_per_annum','source_url':url,'evidence_status':'reviewed',
                     'metadata':{'reviewer':rec['reviewer'].strip(),'reviewed_at':datetime.now(timezone.utc).isoformat(),
                                 'decision_date':rec['date'],'human_approved':True}})
    if not rows:
        raise ValueError('No policy rows')
    raw={'rows':list(csv.DictReader(StringIO(content))), 'source_file':Path(file_path).name}
    return 'policy_verified',rows[0]['source_url'],raw,rows,[]


def backend_rpc(name, payload):
    base=os.getenv('SUPABASE_URL','').rstrip('/')
    secret=os.getenv('SUPABASE_SECRET_KEY','') or os.getenv('SUPABASE_SERVICE_ROLE_KEY','')
    if not base or not official_url(base, {urlparse(base).hostname}) or not base.endswith('.supabase.co'):
        raise RuntimeError('SUPABASE_URL must be a valid HTTPS Supabase endpoint')
    if not secret:
        raise RuntimeError('SUPABASE_SECRET_KEY missing (never store it in frontend)')
    if secret.startswith('sb_publishable_'):
        raise RuntimeError('A publishable key cannot be used for this backend')
    url=base + '/rest/v1/rpc/' + name
    data=canonical_payload(payload).encode('utf8')
    headers={'apikey':secret,'Content-Type':'application/json','Accept':'application/json',
             'Prefer':'return=representation'}
    # New sb_secret_ keys are not JWTs; never put them in Authorization: Bearer.
    if not secret.startswith('sb_secret_'):
        headers['Authorization']='Bearer '+secret
    req=Request(url,data=data,method='POST',headers=headers)
    try:
        with urlopen(req,timeout=25) as res:
            response=res.read(30000).decode('utf8')
    except HTTPError as exc:
        body=exc.read(2000).decode('utf8','replace')
        raise RuntimeError(f'Supabase RPC HTTP {exc.code}: {body}') from exc
    return json.loads(response)


def upload(dataset):
    source,url,raw,observations,articles=dataset
    # Stable digest of upstream body; no duplicated snapshots for repeated polls.
    output=backend_rpc('tasman_ingest_batch', {'p_source_key':source,'p_source_url':url,
      'p_sha256':snapshot_digest(raw), 'p_payload':raw,'p_observations':observations,'p_articles':articles})
    print(json.dumps({'source':source,'result':output,'observation_rows':len(observations),'article_rows':len(articles)},ensure_ascii=False))
    return output


def main(argv):
    if len(argv)<2 or argv[1] not in ('fx','fx-backfill','news','housing','policy'):
        print('Usage: python backend/ingest.py fx|fx-backfill|news|housing|policy',file=sys.stderr)
        return 2
    task=argv[1]
    sources={'fx':['fx_ecb'],'fx-backfill':['fx_ecb'],'news':['rba_media','rbnz_news'],'housing':['housing_curated'],'policy':['policy_verified']}[task]
    try:
        # failure isolation per news source
        if task=='news':
            failures=[]
            for key,url in (('rba_media',RBA_RSS),('rbnz_news',RBNZ_NEWS)):
                try:
                    doc=request_bytes(url,{urlparse(url).hostname})
                    if key=='rba_media':
                        articles=parse_rba_rss(doc)
                    else:
                        articles=parse_rbnz_news(doc)
                    upload((key,url,doc.decode('utf8','replace'),[],articles))
                except Exception as exc:
                    failures.append(f'{key}: {exc}')
                    try: backend_rpc('tasman_record_failure',{'p_source_key':key,'p_detail':str(exc)[:500]})
                    except Exception: pass
            if failures:
                raise RuntimeError('; '.join(failures))
        else:
            item=(collect_fx(task=='fx-backfill') if task in ('fx','fx-backfill') else
                  collect_housing() if task=='housing' else collect_verified_policy())
            upload(item)
    except Exception as exc:
        if task!='news':
            try: backend_rpc('tasman_record_failure',{'p_source_key':sources[0],'p_detail':str(exc)[:500]})
            except Exception: pass
        print(f'INGEST FAILED: {exc}',file=sys.stderr)
        return 1
    return 0


if __name__=='__main__':
    raise SystemExit(main(sys.argv))
