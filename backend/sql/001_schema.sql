-- TASMAN data store v2 / Supabase PostgreSQL 15+
-- Run in Supabase SQL editor once, BEFORE enabling the GitHub Action.
-- No public or authenticated client receives direct table access.
create table if not exists public.tasman_ingestion_runs (
  run_id bigint generated always as identity primary key,
  source_key text not null check (source_key in ('fx_ecb', 'rba_media', 'rbnz_news', 'housing_curated', 'policy_verified')),
  status text not null check (status in ('success','failed')),
  fetched_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  new_versions integer not null default 0,
  article_versions integer not null default 0,
  detail text not null default ''
);

create table if not exists public.tasman_raw_snapshots (
  snapshot_id bigint generated always as identity primary key,
  source_key text not null,
  source_url text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  first_seen_at timestamptz not null default now(),
  unique (source_key,payload_sha256)
);

-- A recurring poll references a snapshot even when content did not change.
create table if not exists public.tasman_run_snapshots (
  run_id bigint not null references public.tasman_ingestion_runs(run_id),
  snapshot_id bigint not null references public.tasman_raw_snapshots(snapshot_id),
  primary key (run_id, snapshot_id)
);

-- Append only. Each change to a logical observation gets its own revision_no.
create table if not exists public.tasman_observation_versions (
  version_id bigint generated always as identity primary key,
  series_key text not null check (series_key in (
    'fx_nzd_aud_ecb','housing_melbourne_house_median_aud',
    'housing_auckland_all_dwelling_median_nzd',
    'policy_rba_cash_target_pct','policy_rbnz_ocr_pct')),
  observed_on date not null,
  value numeric(20,8) not null check (value >= 0),
  currency text not null check (currency in ('AUD','NZD','PCT')),
  unit text not null,
  source_key text not null,
  source_url text not null check (source_url ~ '^https://'),
  snapshot_id bigint not null references public.tasman_raw_snapshots(snapshot_id),
  revision_no integer not null check (revision_no > 0),
  recorded_at timestamptz not null default now(),
  evidence_status text not null check (evidence_status in ('provider_data','curated','reviewed')),
  metadata jsonb not null default '{}'::jsonb,
  unique (series_key, observed_on, revision_no)
);
create index if not exists tasman_obs_key_date on public.tasman_observation_versions(series_key,observed_on desc,revision_no desc);

create table if not exists public.tasman_article_versions (
  article_version_id bigint generated always as identity primary key,
  source_key text not null check (source_key in ('rba_media','rbnz_news')),
  article_url text not null,
  title text not null,
  published_on date,
  revision_no integer not null check (revision_no > 0),
  snapshot_id bigint not null references public.tasman_raw_snapshots(snapshot_id),
  recorded_at timestamptz not null default now(),
  review_status text not null default 'pending' check (review_status in ('pending','reviewed')),
  unique(source_key,article_url,revision_no)
);
create index if not exists tasman_article_url on public.tasman_article_versions(source_key,article_url,revision_no desc);

create or replace view public.tasman_current_observations with (security_invoker=true) as
 select distinct on (series_key,observed_on)
 series_key,observed_on,value,currency,unit,source_key,source_url,revision_no,recorded_at,evidence_status,metadata
 from public.tasman_observation_versions
 order by series_key,observed_on,revision_no desc;

create or replace view public.tasman_current_articles with (security_invoker=true) as
 select distinct on (source_key,article_url)
 source_key,article_url,title,published_on,review_status,revision_no,recorded_at
 from public.tasman_article_versions
 order by source_key,article_url,revision_no desc;

-- One database transaction per fetched batch. Idempotent replay and per-date revisioning.
create or replace function public.tasman_ingest_batch(
 p_source_key text,
 p_source_url text,
 p_sha256 text,
 p_payload jsonb,
 p_observations jsonb default '[]'::jsonb,
 p_articles jsonb default '[]'::jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare
 v_run bigint; v_snapshot bigint; v_count integer:=0; v_article_count integer:=0;
 row_data jsonb; prior record; next_rev integer; v_key text; v_date date; v_value numeric(20,8);
 v_currency text; v_unit text; v_src_url text; v_status text; v_title text; v_article_url text;
 v_published date;
begin
 if p_source_key not in ('fx_ecb','rba_media','rbnz_news','housing_curated','policy_verified')
  or p_source_url not like 'https://%' or p_sha256 !~ '^[0-9a-f]{64}$'
  or jsonb_typeof(p_payload) is null
  or jsonb_typeof(p_observations) <> 'array'
  or jsonb_typeof(p_articles) <> 'array'
  or jsonb_array_length(p_observations)>3000 or jsonb_array_length(p_articles)>100
 then raise exception 'Invalid ingest arguments'; end if;
 perform pg_advisory_xact_lock(hashtext(p_source_key));
 insert into public.tasman_ingestion_runs(source_key,status)
 values(p_source_key,'success') returning run_id into v_run;
 insert into public.tasman_raw_snapshots(source_key,source_url,payload_sha256,payload)
 values(p_source_key,p_source_url,p_sha256,p_payload)
 on conflict(source_key,payload_sha256) do nothing;
 select snapshot_id into v_snapshot from public.tasman_raw_snapshots
 where source_key=p_source_key and payload_sha256=p_sha256;
 insert into public.tasman_run_snapshots(run_id,snapshot_id) values(v_run,v_snapshot);
 for row_data in select * from jsonb_array_elements(p_observations) loop
  v_key:=row_data->>'series_key'; v_date:=(row_data->>'observed_on')::date;
  v_value:=(row_data->>'value')::numeric; v_currency:=row_data->>'currency';
  v_unit:=row_data->>'unit'; v_src_url:=row_data->>'source_url';v_status:=row_data->>'evidence_status';
  if v_key is null or v_date is null or v_value is null or v_currency is null or v_unit is null or v_src_url not like 'https://%'
   or v_status not in ('provider_data','curated','reviewed') then raise exception 'Invalid observation'; end if;
  if p_source_key='fx_ecb' and (v_key<>'fx_nzd_aud_ecb' or v_status<>'provider_data') then raise exception 'FX series mismatch'; end if;
  if p_source_key='housing_curated' and (v_key not like 'housing_%' or v_status<>'curated') then raise exception 'Housing series mismatch'; end if;
  if p_source_key='policy_verified' and (v_key not like 'policy_%' or v_status<>'reviewed') then raise exception 'Policy review required'; end if;
  select value,currency,unit,source_url,revision_no into prior
  from public.tasman_observation_versions where series_key=v_key and observed_on=v_date
  order by revision_no desc limit 1;
  if not found then
   next_rev:=1;
  elsif prior.value is distinct from v_value or prior.currency is distinct from v_currency
     or prior.unit is distinct from v_unit or prior.source_url is distinct from v_src_url then
   next_rev:=prior.revision_no+1;
  else next_rev:=0; end if;
  if next_rev>0 then
   insert into public.tasman_observation_versions
     (series_key,observed_on,value,currency,unit,source_key,source_url,snapshot_id,revision_no,evidence_status,metadata)
   values(v_key,v_date,v_value,v_currency,v_unit,p_source_key,v_src_url,v_snapshot,next_rev,v_status,
          coalesce(row_data->'metadata','{}'::jsonb));
   v_count:=v_count+1;
  end if;
 end loop;
 for row_data in select * from jsonb_array_elements(p_articles) loop
  v_article_url:=row_data->>'article_url';v_title:=row_data->>'title';
  v_published:=nullif(row_data->>'published_on','')::date;
  if p_source_key not in ('rba_media','rbnz_news') or length(v_title) not between 8 and 280
     or v_article_url not like 'https://%' then raise exception 'Invalid article'; end if;
  if (p_source_key='rba_media' and v_article_url not like 'https://www.rba.gov.au/%')
     or (p_source_key='rbnz_news' and v_article_url not like 'https://www.rbnz.govt.nz/%') then
     raise exception 'Article host not allowed';end if;
  select title,published_on,revision_no into prior from public.tasman_article_versions
  where source_key=p_source_key and article_url=v_article_url order by revision_no desc limit 1;
  if not found then next_rev:=1;
  elsif prior.title is distinct from v_title or prior.published_on is distinct from v_published then
    next_rev:=prior.revision_no+1;
  else next_rev:=0; end if;
  if next_rev>0 then
    insert into public.tasman_article_versions(source_key,article_url,title,published_on,revision_no,snapshot_id)
    values(p_source_key,v_article_url,v_title,v_published,next_rev,v_snapshot);
    v_article_count:=v_article_count+1;
  end if;
 end loop;
 update public.tasman_ingestion_runs set new_versions=v_count,article_versions=v_article_count
 where run_id=v_run;
 return jsonb_build_object('run_id',v_run,'snapshot_id',v_snapshot,'new_versions',v_count,'article_versions',v_article_count);
end;$$;

create or replace function public.tasman_record_failure(p_source_key text,p_detail text)
returns bigint language plpgsql security invoker set search_path=public as $$
declare id bigint;
begin
 if p_source_key not in ('fx_ecb','rba_media','rbnz_news','housing_curated','policy_verified') then raise exception 'Invalid source';end if;
 insert into public.tasman_ingestion_runs(source_key,status,detail)
 values (p_source_key,'failed',left(p_detail,500)) returning run_id into id;
 return id;
end;$$;

-- REST routes are callable ONLY by service_role, and secret stays server-side.
alter table public.tasman_ingestion_runs enable row level security;
alter table public.tasman_raw_snapshots enable row level security;
alter table public.tasman_run_snapshots enable row level security;
alter table public.tasman_observation_versions enable row level security;
alter table public.tasman_article_versions enable row level security;
revoke all on public.tasman_ingestion_runs, public.tasman_raw_snapshots, public.tasman_run_snapshots,
 public.tasman_observation_versions, public.tasman_article_versions,
 public.tasman_current_observations,public.tasman_current_articles from public,anon,authenticated;
revoke all on function public.tasman_ingest_batch(text,text,text,jsonb,jsonb,jsonb),
 public.tasman_record_failure(text,text) from public,anon,authenticated;
grant select,insert,update on public.tasman_ingestion_runs to service_role;
grant select,insert on public.tasman_raw_snapshots, public.tasman_run_snapshots,
 public.tasman_observation_versions, public.tasman_article_versions to service_role;
grant select on public.tasman_current_observations,public.tasman_current_articles to service_role;
grant usage,select on all sequences in schema public to service_role;
grant execute on function public.tasman_ingest_batch(text,text,text,jsonb,jsonb,jsonb),
 public.tasman_record_failure(text,text) to service_role;

-- Protect all historical versions from accidental UPDATE/DELETE by application roles.
create or replace function public.tasman_reject_history_mutation() returns trigger
language plpgsql as $$ begin raise exception 'TASMAN history is append only'; end; $$;
drop trigger if exists immutability_raw on public.tasman_raw_snapshots;
create trigger immutability_raw before update or delete on public.tasman_raw_snapshots
for each row execute function public.tasman_reject_history_mutation();
drop trigger if exists immutability_obs on public.tasman_observation_versions;
create trigger immutability_obs before update or delete on public.tasman_observation_versions
for each row execute function public.tasman_reject_history_mutation();
drop trigger if exists immutability_articles on public.tasman_article_versions;
create trigger immutability_articles before update or delete on public.tasman_article_versions
for each row execute function public.tasman_reject_history_mutation();
drop trigger if exists immutability_runlinks on public.tasman_run_snapshots;
create trigger immutability_runlinks before update or delete on public.tasman_run_snapshots
for each row execute function public.tasman_reject_history_mutation();
