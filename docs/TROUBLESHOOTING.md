# Troubleshooting

Every issue below was hit while building or testing Zoltar. Each entry lists the symptom you see, the cause, and the fix. Start with the diagnostic tools; most problems show up there first.

## Diagnostic tools

| Tool | What it tells you |
| --- | --- |
| `make status` | Whether Ollama answers and has the models, then the app's `/healthz`. Changes nothing. |
| `GET /healthz` | DB status, AI mode (`anthropic`, `ollama`, `mock`, `disabled`) and models, Ollama reachability and missing models (Ollama mode, or hybrid search), playbook search mode and embedding model (`kb`), queue counts (`queued`, `running`, `done`, `failed`), last successful model call, whether the monitor is stale. `status` is `degraded` if a job failed in the last minute (`queue.failedLastMinute`), the monitor stopped, or Ollama is not ready. `queue.failed` is the all-time count, so an uptime check polling less than once a minute should watch it go up. |
| Client notices card (incident page) | Every outage notice and all-clear: client, address, status, time. Failed ones show the error. |
| Ops page | Model calls per step with errors and invalid outputs, p50/p95 latency, cost, escalation reasons, queue depth, AI kill switch. |
| Model calls panel (ticket or incident page) | Every call for that item: model, status, attempt, tokens, latency, cost. Failed calls show the error. |
| Incident timeline | Monitor, ticket, AI, and human events in order, including "Brief generation failed". |
| `data/ollama.log` | Output of an Ollama server started by `make services`: model loads, each request's duration, cancelled requests. |
| Server logs | JSON lines with `request_id`, `ticket_id`, `job_id`, `incident_id`. Set `LOG_LEVEL=debug` to include live refresh requests and `/events` connections. Ticket bodies are never logged. |
| `npm run smoke` | Starts a throwaway server in mock mode and checks pages, ingest, triage, CSRF, and monitoring over HTTP. |
| `npm run eval` | Runs the 40 labeled requests through the real pipeline. `--mock` for offline; exits non-zero on any missed escalation. |
| `npm run eval:retrieval` | Keyword against hybrid playbook search on paraphrased questions, and the similarity scores behind the floors. Needs the embedding model (`ollama pull nomic-embed-text`); `--mock` for offline. |

Query the database directly (the server can stay running; SQLite is in WAL mode):

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/zoltar.db');
console.table(db.prepare(\"SELECT id, purpose, model, status, attempt, substr(error,1,120) AS error FROM ai_calls WHERE status != 'ok' ORDER BY id DESC LIMIT 20\").all());
console.table(db.prepare(\"SELECT id, type, ref_id, status, attempts, substr(last_error,1,120) AS last_error FROM jobs WHERE status = 'failed'\").all());
console.table(db.prepare(\"SELECT incident_id, client_id, kind, status, error FROM outbound_messages WHERE status != 'sent'\").all());
"
```

## Start Zoltar on a Mac

These are for the double-click starter and the one-line install. Each message in the Terminal window says what to do; this section explains the rest. When asking someone for help, send them `data/zoltar.log` from the Zoltar folder.

### "Start Zoltar" could not be opened, or Apple "could not verify" it
**Cause:** macOS blocks scripts downloaded from the internet until you allow them once. **Fix:** click Done, open System Settings, then Privacy & Security, scroll down, and click Open Anyway next to "Start Zoltar". Or use the one-line Terminal install, which macOS does not block.

### Double-clicking opens the file in a text editor
**Cause:** the file lost its "can be run" setting, which happens with some unzip tools. **Fix:** in Terminal, run `chmod +x ~/Zoltar/*.command` (use the folder you unzipped into), or use the one-line install.

### The window says "Could not reach..." or "Downloading ... failed"
**Cause:** no internet, or a network that blocks GitHub or nodejs.org (some office networks do). **Fix:** try again on another network. The internet is only needed for the first start.

### "Not enough disk space"
**Cause:** the AI model needs about 6 GB. **Fix:** free up space (empty the Trash, remove large downloads) and start again.

### "Another program is using port 8787"
**Cause:** something else on the Mac uses the same address. **Fix:** quit it, or open `.env` in the Zoltar folder with TextEdit and change `PORT=8787` to `PORT=8788`. Zoltar then opens at http://localhost:8788.

### "The settings file (.env) has an error"
**Fix:** undo the last change in `.env`, or delete `.env`; the next start creates a fresh one with the defaults.

### Zoltar opened but requests stay in "Needs human" with "AI unavailable"
**Cause:** the AI engine stopped while Zoltar was running. **Fix:** close the window and double-click Start Zoltar again; then open each affected request and click "Re-run triage".

### It is slow, or the Mac gets warm and loud
**Cause:** the AI runs on the Mac itself. This is normal during the first 12 minutes or so while it works through the demo requests. Macs with less than 16 GB of memory get a smaller model automatically. Intel Macs work but are much slower than Apple silicon. **Fix:** double-click Stop Zoltar when you are done to free the memory.

### Starting over
Double-click Stop Zoltar, then delete the `data` folder inside the Zoltar folder to remove all requests and incidents; the next start recreates the demo. Deleting the hidden `.runtime` folder (press Command-Shift-. in Finder to see it) makes the next start download Node.js and Ollama again. The AI model is kept in `~/.ollama` and is not downloaded again.

### Removing Zoltar completely
Double-click **Uninstall Zoltar** and type `yes`. It stops Zoltar and removes the AI model, the Node.js and Ollama it downloaded, its data, logs, and settings, and (for the one-line install) the Zoltar folder. If it says it **kept `~/.ollama`**, that folder holds AI models you downloaded yourself with Ollama; delete them with `ollama rm <name>` if you no longer want them. If it says **Homebrew packages were kept because other software still needs them**, they are shared with something else you installed and are safe to leave. A Zoltar folder from an older version has no `.zoltar-installed` record, so the uninstaller removes only the folder's own files; delete `~/.ollama` yourself if Zoltar was the only thing using Ollama.

### Updating to a new version
Run the one-line install again. It replaces the program files and keeps your settings (`.env`) and data.

## Startup and environment

### `No such built-in module: node:sqlite`
**Cause:** Node older than 24. **Fix:** install Node 24 or newer (`node -v`). CI tests on 24 and 26. `make node` checks the version and installs Node with Homebrew if it is missing, but will not replace an older Node you already have.

### `EADDRINUSE: address already in use 127.0.0.1:8787`
**Cause:** another server is on the port, often a leftover Zoltar. **Fix:** `make stop` stops any Zoltar running from this folder, however it was started. Otherwise `lsof -nP -iTCP:8787 -sTCP:LISTEN` finds the program, or run on another port with `PORT=8790 npm run dev`.

### `make start` returned, but where is the app?
**Cause:** it runs in the background, like a service. **Check:** `make status` (the app's `/healthz`), `make logs` to follow its log, or `data/zoltar.log`. **Stop:** `make stop`. If `make start` says the app stopped while starting, the last 20 log lines above the message say why (often an `.env` error or a port in use).

### The app stopped by itself
**Check:** `grep -E 'shutting down|listening on' data/zoltar.log`. A `"signal":"SIGTERM"` line means something asked it to stop: `make stop`, `make restart`, Stop Zoltar, the uninstaller, or a tool that runs one of them. No such line before the next start means it crashed or was force-killed; the lines just before say why. An app started by an automated agent or IDE task can be stopped when that task ends; start it from your own terminal with `make start`.

### `npm run reset` says Zoltar is running
**Cause:** a running server keeps the deleted database open and goes on writing to it, and those writes are lost at the next start. **Fix:** `make stop`, `npm run reset`, `make start`.

### Two dev servers running at once
**Symptom:** `ps` shows two `tsx watch server/main.ts` processes; jobs may be processed twice. **Cause:** `npm run dev` is three processes (npm, the `tsx watch` watcher, the server). Killing only the process on the port leaves the watcher alive, and it starts a new server on the next file change. **Fix:** `make stop`, which stops every app process from this folder, watcher included. Avoid `pkill -f server/main.ts`: it also stops Zoltar running from other folders.

### The app uses Ollama when you expected Claude
**Symptom:** the header shows `AI: ollama` although `ANTHROPIC_API_KEY` is set. **Cause:** by design, a key alone does not switch providers. **Fix:** set `AI_MODE=anthropic` in `.env`, or run `AI_MODE=anthropic make dev` once.

### The app uses Claude when you expected Ollama
**Symptom:** the header shows `AI: anthropic`, and `make services` says "no local services needed". **Cause:** `AI_MODE=anthropic` is set in `.env` or exported in your shell (`echo $AI_MODE`). **Fix:** remove it; empty means Ollama.

### The server exits at start with a config error
**Cause:** invalid setting. The server refuses to start rather than run misconfigured. Common ones: `Invalid AI_MODE`, `AI_MODE=anthropic requires ANTHROPIC_API_KEY` (`live` is accepted as the old name for `anthropic`), `Invalid number for PORT`, `MONITOR_SOURCES must be JSON`, `MONITOR_SOURCES.X: url required`. **Fix:** correct the value in `.env`; `.env.example` lists every setting with its default.

### An old database after upgrading
**Cause:** columns added later (`clients.contact_email`, `incidents.recovered_at`) are not in databases created before them. **Handled automatically:** on start the server adds missing columns, fills seeded clients' contact emails, and marks open incidents recovered if their last monitor event was a recovery. Nothing to do; `npm run reset` is only needed for a clean demo.

### `zsh: no matches found: data/zoltar.db*`
**Cause:** zsh treats an unmatched glob as an error, so a command like `rm data/zoltar.db*` fails when the WAL files do not exist, and anything chained after it does not run. **Fix:** use `npm run reset`.

### Old results after changing models or prompts
**Symptom:** tickets show the previous model in their Model calls panel. **Cause:** triage results are stored; changing the mode, a model setting, or a prompt does not re-run existing tickets. Each call records its model and `prompt_version`, so you can tell old from new. **Fix:** "Re-run triage" on a ticket, or `make reset` and restart to reseed and triage everything again (about $0.80 with Anthropic, about 12 minutes with Ollama).

## Ollama

### "Ollama is not running" in the server log, tickets in Needs human with "AI unavailable"
**Cause:** the app was started with `npm run dev` (which does not start services) or Ollama stopped. **Fix:** `make services`, then "Re-run triage" on affected tickets. `make dev` does the check every time.

### "Ollama models missing" or `model ... is not installed`
**Cause:** the model in `OLLAMA_MODEL_FAST` or `OLLAMA_MODEL_SMART` was never pulled, often after changing it in `.env`. **Fix:** `make services` pulls whatever is configured.

### `make install` fails installing Ollama
**Cause:** on macOS it needs Homebrew; on Linux, `curl` and sudo for the official script. Windows is not handled. **Fix:** install from [ollama.com/download](https://ollama.com/download), then `make services`. The desktop app works too; it runs its own server, which `make services` detects.

### "Ollama did not start within 30 s"
**Cause:** usually another process on port 11434 that is not Ollama, or a broken install. **Fix:** read `data/ollama.log`; `lsof -nP -iTCP:11434 -sTCP:LISTEN` shows what holds the port.

### Every Ollama call fails with "did not answer within 30000 ms"
**Cause:** `AI_TIMEOUT_MS=30000` in `.env`, from an older `.env.example`. Ollama serves one request at a time, so with two workers a request can wait 20 seconds before it starts; `data/ollama.log` shows the cancelled requests as HTTP 500 at exactly 30 s. **Fix:** leave `AI_TIMEOUT_MS` empty; the Ollama default is 180 seconds.

### Triage is slow on Ollama
**Cause:** a local 8B model generates about 22 tokens per second on an M1 Pro, so each request (classify plus draft) takes about 20 seconds, and the 40 seed requests about 12 minutes. **Fix:** this is expected. For speed, set `OLLAMA_MODEL_FAST` to a smaller model (classification is short), run Ollama on a machine with a bigger GPU and set `OLLAMA_URL`, or switch to Claude with `AI_MODE=anthropic` and `ANTHROPIC_API_KEY`. Raising `WORKER_CONCURRENCY` does not help; Ollama queues the requests.

### Odd or low-quality results on Ollama
**Cause:** small local models classify less accurately than Haiku and write plainer drafts. The gate rules still apply, so the usual effect is more requests in Needs human. **Fix:** check `npm run eval` results for the model; try a larger one (`OLLAMA_MODEL_SMART`) if the machine has the memory.

### Ollama keeps using memory after the app stops
**Cause:** models stay loaded for 30 minutes after the last call (`keep_alive`), and `ollama serve` keeps running in the background. **Fix:** double-click Stop Zoltar, or `make stop-ollama`. Both stop only the Ollama that Zoltar started (its process ID is in `data/ollama.pid`). If Ollama runs as the desktop app or `brew services`, stop it from there; Zoltar leaves it alone on purpose.

## Model calls

### HTTP 400: `tool_choice ... is not supported`
**Cause:** Sonnet 5.5 and Opus 5.5 reject a forced tool call. **Handled automatically:** the client retries once with `tool_choice: auto` and remembers the model for the rest of the process. If you see this as a final error, check `server/ai/anthropic.ts` still matches the error text in `isForcedToolUnsupported`.

### HTTP 400: `tool_use ids were found without tool_result blocks`
**Symptom:** an incident shows "Brief generation failed (error). Use the runbook directly." and two calls: `invalid_output` then this 400. **Cause:** in `auto` mode Sonnet split its answer across two tool calls. The first was incomplete (a `timeline` sent as a string, missing fields), and the repair turn answered only one of the two calls, which the API rejects. **Fixed:** requests set `disable_parallel_tool_use`, repair turns answer every tool call, and JSON-encoded fields are decoded. **To recover an existing incident:** click Regenerate on the incident page.

### `invalid_output` on classification with Haiku
**Symptom:** errors like `Invalid option: expected one of "Publishing & Scheduling"...` or `Too big: expected string to have <=600 characters`; some tickets land in manual triage with `AI classify failed (invalid_output)`. **Cause:** Haiku fills fields in schema order. With the long `rationale` first, it sometimes ran over the length cap or dropped `category`. **Fixed** in `classify-v2`: routing fields come first, the rationale is limited to two sentences, and the cap is looser. If it returns, read the exact validation error in the Model calls panel; it names the field.

### `invalid_output` with a field that "looks right"
**Cause:** the model sent a nested array or object as a JSON string (`"timeline": "[{...}]"`). **Handled automatically:** top-level JSON strings are decoded before validation fails. Anything else gets one repair turn with the validation error, then manual triage.

### HTTP 400 about thinking blocks during a repair
**Cause:** models that think require their thinking blocks back in the next turn. **Handled:** repair turns replay the original assistant content (`raw`) unchanged. If you change `toApiMessages`, keep that.

### Tickets stuck in manual triage with "AI unavailable after retries"
**Cause:** repeated 429, 5xx, 529 (overloaded), or timeouts. The job queue retries with backoff up to `JOB_MAX_ATTEMPTS` (the SDK's own retries are off, so `AI_TIMEOUT_MS` is the real limit per call). **Fix:** check Anthropic status and your rate limits; raise `AI_TIMEOUT_MS` for long drafts. Once healthy, "Re-run triage" on affected tickets. The ticket is never lost; it waits in Needs human.

### "Token budget exhausted"
**Cause:** a ticket used more than `TICKET_TOKEN_BUDGET` tokens across its calls, usually a very long message plus repairs. **Fix:** this is a safety cap; triage the ticket by hand or raise the budget.

### Many safe requests land in Needs human
**Cause:** the gate escalates on low confidence and ungrounded drafts. On the eval set about half of safe requests escalate, mostly because the drafting model rates its own draft as low confidence. **Fix:** check escalation reasons on the Ops page; tune `CONFIDENCE_THRESHOLD` against real coordinator edits. Do not loosen category, action, or keyword rules to fix this.

### Odd classifications in mock mode
**Example:** the prompt-injection seed ticket is classified as Billing & Contract because it contains "refund". **Cause:** the mock model is keyword rules for offline demos and tests, not a classifier. **Fix:** none needed; the app only uses the mock when `AI_MODE=mock`. Check behavior with Ollama or Anthropic, or with `npm run eval`.

### Cost shows $0
**Cause:** Ollama or mock mode (both free per call), or an Anthropic model ID missing from the price table. **Fix:** add the model to `server/ai/pricing.ts`.

## Interface

### Blank page when clicking a ticket; fine after refresh
### Header disappears when switching queue tabs
**Cause:** links are boosted by htmx (`hx-boost` on `<body>`), and htmx attributes inherit. The live container's `hx-select="#queue"` and `hx-swap="outerHTML"` were inherited by links inside it, so a click kept only `#queue` from the ticket page (nothing) or replaced the whole `<body>`. **Fixed:** live containers set `hx-disinherit="hx-select hx-swap hx-sync"`. Not `*`: that also cuts off `hx-boost`, so links inside would do full page loads. **Rule for new views:** build live containers with `live()` from `server/views/ui.tsx`, which sets it.

### The back button goes to the wrong page
**Cause:** `app.js` rewrites the back link to the page you came from, using a history kept in `sessionStorage` for this tab. htmx reads a boosted link's `href` once, when the page loads, so it would ignore the rewrite and go to the default (`/queue` or `/incidents`). **Fix:** back links carry `hx-boost="false"`; keep it on any new `data-back` link. Without JavaScript, or in a fresh tab, the link goes to the default on purpose.

### A dropdown resets, or a notice form closes and loses your edits
**Cause:** the page refreshed under you. **Fixed:** `app.js` holds a refresh, and discards one already in flight, while a form control has focus, a control inside the refreshed area has an unsubmitted change, or a `details[data-hold-refresh]` panel (the notice forms) is open, then refreshes when you leave or submit. If it happens, check that `/static/app.js` loads (browser console). **Rule for new views:** give any expandable form `data-hold-refresh`.

### A page does not update until reloaded
**Cause:** the live connection is not running. **Check:** in the browser's network tab, `/events` should be an open `text/event-stream` request. A 503 means 50 tabs or more already hold one; close some. A proxy that buffers responses also breaks it. **Fix:** reload the page; after a refused connection `app.js` also retries every 5 seconds. Pages still refresh every 60 seconds without it, so this is never data loss. A page opened in a tab that has never been visible connects once it is shown or clicked.

### Pages load slowly with many Zoltar tabs open
**Cause:** browsers allow six connections per site, and each visible tab holds one for live updates. **Handled:** hidden tabs give theirs back. Keep fewer than six Zoltar tabs visible at once, for example in separate windows.

### "MONITOR_DEGRADED_CONSECUTIVE is no longer used"
**Cause:** an `.env` from an older version. The monitor now uses durations. **Fix:** replace `MONITOR_DEGRADED_CONSECUTIVE` and `MONITOR_RECOVERY_CONSECUTIVE` with `MONITOR_DEGRADED_MS=20000` and `MONITOR_RECOVERY_MS=30000` (see `.env.example`), or delete the lines.

### `[CLIENT_3]` tokens visible in the UI
**Cause:** model output is stored rehydrated for display; tickets triaged before that fix still hold tokens. **Fix:** "Re-run triage" on the ticket, or reset. Tokens in "What the AI saw" are expected.

### A single client's tickets labeled as an incident
**Cause:** older build. A cluster from one client is a client watch, and the queue chip reads "Client watch #N"; cross-client clusters read "Platform incident #N".

### Browser console shows a Content Security Policy violation
**Cause:** an inline `<script>`, inline `on...=` handler, `style=` attribute, or htmx eval (for example a `[...]` filter in `hx-trigger`) was added. The CSP allows only same-origin scripts and styles, and htmx runs with `allowEval: false`. **Fix:** move behavior to `server/public/app.js` and styles to `styles.css`. The security tests fail on any inline script, `on...=` handler, or `style=` attribute.

### Keyboard shortcuts do nothing
**Cause:** focus is in a text field or dropdown; shortcuts are disabled there on purpose. **Fix:** press `Escape`, then use `j`/`k`, `Enter`, `a`, `r`, `e`, `n` (back to queue after a review).

### Status badge overlaps the title on the incidents list
**Cause:** list rows share a narrow first column sized for P1/P2 badges; "ACKNOWLEDGED" is wider. **Fixed:** incident rows use the `incident-row` class with a wider status column. Give any new list with long badges its own column width instead of widening `.row`, which would shift the queue.

## API

| Status | Meaning and fix |
| --- | --- |
| 421 `Unknown host` | The request used a host name other than `localhost` or an IP address (DNS rebinding protection). Open Zoltar by IP, or add the name to `ALLOWED_HOSTS` in `.env`. |
| 403 `Forbidden` on a POST | CSRF protection. Browsers must post from the app's own origin. Scripts and `curl` must send `Content-Type: application/json` on every POST, including ones without a body: `curl -X POST -H 'Content-Type: application/json' localhost:8787/api/incidents/4/resolve`. |
| 415 | Body sent without `Content-Type: application/json`. |
| 413 | Body over 256 KB. Ticket bodies are limited to 20,000 characters anyway. |
| 400 `Invalid id` | IDs must be positive integers written as digits. |
| 400 with field errors | The zod validation message names the field, e.g. unknown `client_id` or a missing `subject`. |
| 409 `Ticket already reviewed` / `still being triaged` | Reviews are one-time, and only after triage finishes. |
| 409 `Already approved; re-triage is only for unanswered requests` | Re-triage resets the review, so it is refused once a reply was approved, edited, or rejected; the button is hidden then. |
| 409 `The recipients changed since the form was opened` | Someone was notified, or a new client was affected, while the notice form was open. The message lists the current recipients; check them and send again. |
| 409 `Incident already resolved` | Resolved incidents are final; a new problem opens a new incident. |
| 409 `Every affected client has already been notified` | The outage notice went to everyone. Use the all-clear next. |
| 409 `Incident is resolved; send the all-clear instead` | Outage notices are for open incidents. |
| 400 `Notices are only sent for platform incidents` | Client watches concern one client; reply on their ticket. |

## Incidents and monitoring

### `degraded` does not open an incident
**Cause:** by design, `degraded` must last 20 seconds (`MONITOR_DEGRADED_MS`) to avoid paging on a blip. `outage` opens on the first check. "Run checks now" does not shorten the wait: the threshold is time, not a number of checks. **Fix:** wait, or set `MONITOR_DEGRADED_MS=0` to open on the first degraded check.

### A source shows `unknown` and nothing happens
**Cause:** the status source failed: a Statuspage error or bad JSON, a connection or DNS error, or an HTTP probe URL that returns 4xx (misconfigured). `unknown` never opens an incident, so a broken feed cannot page Ops. An HTTP probe that times out or returns 5xx is different: it counts as an `outage`. **Fix:** check the URL in `MONITOR_SOURCES`; the Platforms page shows the source's error detail.

### A ticket spike does not open an incident
**Cause:** the threshold is at least 5 tickets from at least 3 different clients, same platform and category, within 60 minutes (`INCIDENT_MIN_TICKETS`, `INCIDENT_MIN_CLIENTS`, `INCIDENT_WINDOW_MINUTES`), in a category that clusters (Publishing & Scheduling, Analytics & Reporting, Account & Access, or Community & Comments) and on a named platform; tickets with platform `Other` or `None` never open a platform incident. Several tickets from one client open a client watch instead.

### A resolved incident did not reopen
**Cause:** by design, a failure that was already going on when Ops resolved the incident does not reopen it. A new incident opens after the component has been operational once, or when a `degraded` problem that Ops resolved becomes a full `outage`.

### An incident opened right after restarting Zoltar
**Should not happen:** a gap in readings longer than two monitor intervals breaks a streak, so time while the server was stopped never counts toward `MONITOR_DEGRADED_MS`. An `outage` opens on the first check regardless.

### The incident stays open after the platform recovers
**Cause:** by design. 30 seconds of operational checks (`MONITOR_RECOVERY_MS`) add a "recovered" event and a green banner, but only Ops resolves an incident. Use "Resolve and send all-clear" on the incident.

### "Notify affected clients" or the all-clear button is missing
**Cause:** notices exist only for platform incidents, not client watches. The outage button hides once every affected client is notified (by notice or "Mark notified"); the all-clear button hides once everyone who heard about the outage has it. **Fix:** check the Client notices card; its table lists who got what.

### A notice shows `failed`
**Cause:** delivery rejected it, or Zoltar stopped while it was sending (such notices are marked failed at the next start). With the built-in simulated delivery rejections do not happen; tests use a failing notifier to cover it. **Fix:** send the same notice again; only failed and unsent clients get it, never anyone twice.

### "No email on file, contact directly"
**Cause:** the client has no `contact_email`. They are skipped and named in the timeline so someone calls them. Seeded clients all have `.example` addresses; databases created before notices were added get them filled in at startup.

### "Not sent: Subject must be one line" or "Unknown placeholder"
**Cause:** line breaks in the subject are refused, and only `{{client}}` and `{{coordinator}}` are filled in, so a typo like `{{name}}` is caught before anything is sent. When "Resolve and send all-clear" is refused, the incident is not resolved either.

### `/healthz` reports the monitor as stale
**Cause:** no check in three intervals. Usually the monitor was stopped or the process is busy; a slow source cannot hold it longer than its timeout (5 s for Statuspage, 8 s for HTTP probes). **Fix:** check logs for `monitor_source_failed`, and click "Run checks now" on the Platforms page.

### An incident was resolved but the platform still shows a failure
**Cause:** by design, the monitor does not reopen an incident Ops resolved while the same failure is still going on. **Fix:** nothing, if resolving was intended. If the platform recovers and then fails again, a new incident opens.

### The green "recovered" banner disappeared
**Cause:** the platform failed again after recovering. The timeline says "failing again after recovery: outage. Hold the all-clear." (or `degraded`). **Fix:** wait for the next recovery before telling clients it is fixed.

## Tests and CI

### A test fails only in CI
**Cause:** CI runs on Node 24 and 26 with no API key. **Fix:** reproduce with the same Node version; tests always use the mock model and an in-memory DB, so they never need a key.

### Drafts cite the wrong article, or none, for requests worded differently from the playbook
**Cause:** keyword search misses paraphrases. **Fix:** `KB_SEARCH=hybrid` (Ollama mode pulls `nomic-embed-text`, about 270 MB, on the next `make services` or start). `npm run eval:retrieval` compares both on paraphrased questions.

### Logs show `kb_embeddings_unavailable_using_keyword_search`
**Cause:** hybrid search is on but the embedding model failed, usually because it is not pulled or Ollama stopped. Search uses BM25 alone and tries again after a minute; tickets are not affected. `/healthz` lists the model under `missingModels`. **Fix:** `make services`, or `ollama pull nomic-embed-text`.

### Hybrid search returns unrelated articles, or misses obvious ones, after changing `OLLAMA_EMBED_MODEL`
**Cause:** the similarity floors (`KB_MIN_SIMILARITY` 0.6, `KB_KEYWORD_MIN_SIMILARITY` 0.5) were set for `nomic-embed-text`, and each model has its own scale. **Fix:** `npm run eval:retrieval -- --min-similarity 0 --keyword-min-similarity 0` prints the similarity of right answers and of unrelated text; set the floors between them.

### `npm run eval` fails with exit code 1
**Cause:** at least one request the labels say needs a human was auto-suggested (listed as `MISSED ESCALATION`). This is the one result that must never regress. Fix the gate or prompt; do not relabel the ticket to make it pass.

### A Dependabot PR is not merged
**Cause:** a check failed (test, smoke, eval, or audit), or the PR was not opened by Dependabot. The merge job runs only after all checks pass. **Fix:** open the failed run, fix on the Dependabot branch or close the PR. `@dependabot rebase` refreshes a stale PR.

### `npm audit` fails in CI
**Cause:** a high or critical advisory in a dependency. **Fix:** `npm audit fix`, or wait for the Dependabot security PR, which CI tests and merges like any other.
