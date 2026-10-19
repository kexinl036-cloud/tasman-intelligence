# TASMAN Intelligence · V2 — automated data ingestion and versioned database

**2026-10-19 build · phone + desktop web app.** This repository contains the existing TASMAN dashboard plus a deployable **scheduled collector → Supabase PostgreSQL history → Netlify read API → web dashboard**. No cloud accounts or secrets are bundled, and **nothing is scheduled until you configure and deploy it**. Updated for October 2026 Supabase `sb_secret_` keys; legacy `service_role` JWTs remain supported via `SUPABASE_SERVICE_ROLE_KEY` as a temporary fallback.

## What is automated (and what isn't)

| Dataset | Collector | Frequency after deployment | Important qualification |
|---|---|---|---|
| NZD/AUD FX reference | ECB quotes via [Frankfurter v2](https://frankfurter.dev/); derive NZD/AUD from EUR/AUD and EUR/NZD same-date quotes | Daily, GitHub Actions at 18:23 UTC | Business-day **reference price**, not tick-by-tick executable quote |
| Official central bank headlines | [RBA RSS](https://www.rba.gov.au/rss/), RBNZ official news page | 3 times per day, GitHub Actions | Headlines only; **not** automatically verified policy decisions or AI-made summaries |
| RBA cash target / RBNZ OCR | Human-reviewed decision CSV | Only after explicit approval and manual import | No automatic silent change to published interest rates |
| Melbourne house median / Auckland all-dwelling median | Curated CSV / **licensed** HTTPS CSV provider | Weekly *if* authorized feed configured | No unauthorized REIV / REINZ scraping; frequencies and property types differ |

### Architecture

```
ECB / RBA / RBNZ / (licensed housing CSV)
         |    Python validation, official-domain allowlist
         v
  GitHub Actions scheduled workflows
         |    service-role key (GitHub secret only)
         v
Supabase PostgreSQL
  • tasman_ingestion_runs           every successful/failed polling run
  • tasman_raw_snapshots            immutable original fetched payload, SHA-256 dedup
  • tasman_run_snapshots            links polls to snapshot content
  • tasman_observation_versions     append-only revision_no per series/date
  • tasman_article_versions         append-only title revisions per canonical URL
  • tasman_current_observations     read view, latest revision for each date
  • tasman_current_articles         read view, latest title for each article
         ^    Netlify Function (secret held server side)
         |
  /api/research-data?kind=fx|housing|news|policy|status
         |
 TASMAN responsive mobile/desktop UI (no secret in client JS)
```

## Deploy step by step (about 3 accounts)

### 1. Supabase — create Postgres tables
1. Create a [Supabase](https://supabase.com/) project in a suitable region. This deploy creates a new database project; there is no safe way to use a database you have not authorized.
2. In **SQL Editor**, paste/run `backend/sql/001_schema.sql` **once**. Confirm the tables and `tasman_ingest_batch` function appear.
3. In **Project Settings → API Keys**, create or copy a **secret API key (`sb_secret_...`)**, and get your project URL from **Connect** or **Project Settings**. Do not use the `sb_publishable_...` key. Never commit the secret to Git, put it in `index.html`, or send it to a browser.
4. Confirm Row Level Security (RLS) is enabled and no policies grant public access on TASMAN tables. `public` schema is exposed through PostgREST, but read/write rights are granted only to service_role. Treat service_role as a database admin secret.

### 2. GitHub — scheduled collectors
1. Upload the **entire project contents**, including the hidden `.github/workflows/collect.yml`, to a **private** GitHub repository.
2. Repository **Settings → Secrets and variables → Actions → New repository secret**:
   - `SUPABASE_URL` = `https://YOUR-PROJECT.supabase.co`
   - `SUPABASE_SECRET_KEY` = the new `sb_secret_...` key from Supabase.
3. Go to **Actions → TASMAN verified ingestion → Run workflow**, choose **fx-backfill** *once*. This backfills 2023–present ECB reference data (source availability permitting). Verify a green run and Supabase's `tasman_current_observations` view. The scheduled FX job then checks a recent overlapping 45-day window so upstream corrections are picked up as new versions.
4. Test **news** via Run workflow. Some official news sites may block automated clients; failures are surfaced in Actions and attempts recorded when the database is accessible. No fabricated headlines or summaries are generated.
5. GitHub-hosted cron is best-effort and may run late or occasionally be missed; check the Action history. To receive failure emails, enable GitHub Actions notifications for the repository.

**Schedules (UTC):** `18:23` daily FX; `01:17`, `07:17`, `13:17` news; Monday `20:31` housing *only when authorized*. Neither side effects nor jobs run merely by downloading or opening the HTML file.

### 3. Netlify — private DB access and public read API
1. Import this GitHub repository into [Netlify](https://www.netlify.com/); the included `netlify.toml` publishes `.` and deploys `/netlify/functions`.
2. Add Site configuration → Environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
   Scope to Functions / deploy as appropriate. Redeploy after setting secrets.
3. Open your Netlify URL from phone or desktop. Go to **数据与方法 → 数据服务状态**; if configured, it will display database status and last stored FX date.
4. Check endpoints in your browser:
   - `/api/research-data?kind=status` (latest runs and available dates)
   - `/api/research-data?kind=fx` (ECB reference FX, observation date, revision)
   - `/api/research-data?kind=housing`
   - `/api/research-data?kind=news` (headlines only)
   - `/api/research-data?kind=policy` (reviewed rates only)

Netlify Function queries Supabase using the secret key and emits **only allowlisted public market research fields**, not raw payloads, secrets, or credentials. The frontend automatically prefers saved FX and housing observations if available, otherwise uses its existing public-data/static fallback.

### 4. Property updates — authorization required

Two options:

**Manual approved CSV**, initially use `backend/data/housing-starter.csv` as a *review template* (its `operator_verified` fields are deliberately `no`, inherited from V1 references). Check each value, definition and source against the current source before using it. Set the path (locally only) and run:

```bash
export SUPABASE_URL='https://YOUR-PROJECT.supabase.co'
export SUPABASE_SECRET_KEY='your-sb_secret-key'
export HOUSING_CSV_PATH='backend/data/housing-starter.csv'
python3 backend/ingest.py housing
```

The examples use the V1 research snapshot, not a new verification of those publications. Rates and prices must be examined before putting them in a production decision-support service.

**Licensed HTTPS CSV feed**, set *GitHub repository secrets*:

- `HOUSING_FEED_URL` (exact licensed feed HTTPS URL)
- `HOUSING_FEED_HOST` (exact domain name; no scheme/path)
- `HOUSING_FEED_AUTHORIZED` = `true` (only after checking rights to ingest/store/redisplay)

CSV header must contain `market,date,price,source_url`; supported `market` values: `melbourne`, `auckland`. Each observation must cite its supporting release or licensed source. The two series are not comparable in property type or currency; the UI only compares percentage / rebased index trends. Stop automatic ingest when your data license expires.

### 5. Policy-rate approvals

Open `backend/data/policy-REVIEW-BEFORE-IMPORT.csv`. After reviewing the **actual official** decision page, supply a nonempty `reviewer` and change `approved` to `yes` for each approved row. Run locally:

```bash
export POLICY_CSV_PATH='backend/data/policy-REVIEW-BEFORE-IMPORT.csv'
python3 backend/ingest.py policy
```

The database then preserves approved cash-rate observations and any later corrections as versioned facts. **Important:** V1's Chinese explanatory paragraphs and headline policy snapshot cards remain visibly dated at `2026-10-19`. The backend does *not* automatically rewrite them after an announcement. The approved history is available at `?kind=policy` for a future grounded summary/approval UI. Do not present an unreviewed news headline as a confirmed rate change.

## Version logic and quality gates

- Ingestion records a run on each successful poll even when no new published data exists.
- Original payloads are keyed by `(source_key, SHA-256)` and immutable. Every run links to a snapshot, deduplicating identical responses.
- Logical observations are keyed by `(series_key, observation_date)`. A different **value, currency, unit or citation URL** adds a new `revision_no` (old versions remain queryable); unchanged observations are not duplicated.
- Articles are keyed by `(source_key, official article URL)`. Updated title or publication date creates a new immutable revision, status `pending`.
- Database write batches are performed in **one Postgres RPC transaction** to avoid half-committed history. Unexpected formats, out-of-range values, malicious URLs, absent sources and missing same-date FX component quotes fail validation rather than filling fake data.
- All tables use RLS, with direct frontend access denied; backend read API is allowlisted. Cloud secrets remain on GitHub and Netlify.
- `tasman_ingestion_runs` includes summary of successes/failures. Monitor the GitHub workflow, API `/status`, and database logs for freshness issues. **No production alert channel is configured automatically.**
- RBA RSS can contain press releases that are not policy decisions. RBNZ HTML may change and block the parser. Both conditions must be handled operationally.
- For full resilience add daily database backups/PITR based on your Supabase plan, contract tests against live feeds, and a manual policy review queue.

## Local development and tests

Frontend only:

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

Backend parsing, calculations, SSRF checks and mock API tests do **not** require real keys or internet:

```bash
python3 -m unittest discover -s backend/tests -v
node tests/smoke.mjs
node tests/backend-api.mjs
node --check app.js
```

**Deployment limitation:** This package was tested with fixture data and mocked API responses, but *not* end-to-end against a user Supabase project or scheduled in your GitHub account. SQL must be applied and actual feeds must be tested after setup. The RBNZ website may change its HTML and require an updated adapter.

## Verified engineering references
- [Frankfurter v2 API and provider endpoints](https://frankfurter.dev/)
- [RBA RSS service](https://www.rba.gov.au/rss/)
- [RBA official cash-rate publication](https://www.rba.gov.au/statistics/cash-rate/)
- [RBNZ monetary policy](https://www.rbnz.govt.nz/monetary-policy)
- [Supabase connection security](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [GitHub Actions schedule semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)

### Not a market-data terminal or trading recommendation
Historical ECB reference rates are **not** live execution quotes. House transaction medians are not price indexes; additional regional features (stock, sales volumes, days to sell, property quality) are needed before drawing investment conclusions. Actual bank/Wise trades may have spreads and fees.
