# gmail-sync

Stores every new INBOX email in the SQLite database `data/gmail-sync.db`. Uses Gmail `watch` + a Pub/Sub pull subscription, so no public endpoint is needed.

## One-time Google Cloud setup

1. Create a project at https://console.cloud.google.com and enable the Gmail API and Cloud Pub/Sub API.
2. Pub/Sub: create topic `gmail`, then a pull subscription `gmail-sync` on it.
3. On the topic, grant `gmail-api-push@system.gserviceaccount.com` the role "Pub/Sub Publisher".
4. OAuth consent screen: type External, add yourself as test user, then click "Publish app" so the refresh token does not expire after 7 days.
5. Credentials: create an OAuth client ID of type "Desktop app". Copy the client ID and secret.

## Run

```sh
cp .env-example .env   # fill in values
bun sync.ts
```

First run prints a URL. Open it on the same machine, approve (click through the "unverified app" warning), and the refresh token is saved in the database.

Only mail arriving after the first run is stored; existing mail is not backfilled.

## Order tracking

Every new email is sent to Qwen3 8B via Ollama. Order and shipping emails are merged into the `orders` table, one row per order, matched on order number or tracking number. Each entry keeps its latest status (`ordered`, `shipped`, `out_for_delivery`, `delivered`, `delayed`, `cancelled`, `returned`) plus a history of the emails behind it.

```sh
ollama pull qwen3:8b
```

If Ollama is down, the email is not marked as processed and is retried every 30 seconds.

## Development

```sh
bun install
bun run dev         # restarts on file changes
bun run typecheck
```

Queries use Drizzle; the schema is in `schema.ts`. After changing it, run `bun run db:generate` to create a migration in `drizzle/`. Migrations are applied automatically on startup.

## Files in `data/`

- `gmail-sync.db`: SQLite database with tables `emails`, `orders` (items with product name, SKU and quantity), `order_events` (one row per email that touched an order), `logs` (all log output) and `kv` (OAuth refresh token and sync position)
- `legacy-json/`: the old JSON files, moved here after they were imported into SQLite on first start

```sh
sqlite3 data/gmail-sync.db "SELECT merchant, order_number, status, tracking_url FROM orders ORDER BY updated_at DESC"
```

## Docker

`make up` (from the repo root) starts `gmail-sync` and `ollama`. Data lives in `runtimeGenerated/gmail-sync`, the model in `runtimeGenerated/ollama`. The model is downloaded on first start (~5 GB).

The first login needs a browser on your laptop to reach port 8085 in the container. Port 8085 is only bound to the server's localhost, so tunnel it:

```sh
ssh -L 8085:localhost:8085 <server>
docker logs gmail-sync   # open the printed URL on your laptop
```

Alternatively run `bun sync.ts` once locally and copy `data/gmail-sync.db` to `runtimeGenerated/gmail-sync/gmail-sync.db` on the server (stop the local run first so the database is fully written).

Ollama runs on CPU, so classifying an email takes roughly 30 to 120 seconds. The model is unloaded from RAM after `OLLAMA_KEEP_ALIVE` (default `1m`) without requests.
