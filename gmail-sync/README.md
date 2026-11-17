# gmail-sync

Watches a Gmail inbox, stores every new email in SQLite, and uses Qwen3 8B (via Ollama) to track online orders and parcel deliveries. A plain-text dashboard shows the orders and whether the service is healthy.

How it works:

1. Gmail `watch` publishes a notification to a Pub/Sub topic when new mail arrives.
2. The app pulls that notification (pull subscription, so no public endpoint is needed) and fetches the new messages via `history.list`.
3. Each email is sent to Ollama. Order and shipping emails are merged into the `orders` table.
4. Every 10 minutes it also syncs without a notification, in case one was lost. After downtime it catches up from the last saved position.

## One-time Google Cloud setup

1. Create a project at https://console.cloud.google.com and enable the Gmail API and Cloud Pub/Sub API.
2. Pub/Sub: create topic `gmail`, then a pull subscription `gmail-sync` on it (expiry: never).
3. On the topic, grant `gmail-api-push@system.gserviceaccount.com` the role "Pub/Sub Publisher".
4. Google Auth Platform: audience External, add the scopes `gmail.readonly` and `pubsub`, then click "Publish app" so the refresh token does not expire after 7 days.
5. Clients: create an OAuth client of type "Desktop app". Copy the client ID and secret.

## Configuration

Copy `.env-example` to `.env` and fill it in.

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | required | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | required | OAuth client secret |
| `PUBSUB_TOPIC` | required | `projects/<project-id>/topics/gmail` |
| `PUBSUB_SUBSCRIPTION` | required | `projects/<project-id>/subscriptions/gmail-sync` |
| `DASHBOARD_TOKEN` | required | Bearer token for the dashboard, generate with `openssl rand -hex 32` |
| `DASHBOARD_PORT` | `8086` | Dashboard port |
| `DATA_DIR` | `./data` | Where the SQLite database lives |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `qwen3:8b` | Model used for order extraction |
| `OLLAMA_KEEP_ALIVE` | `1m` | How long the model stays in RAM after the last request |
| `OAUTH_PORT` | `8085` | Local port for the first Google login |

## Run locally

Requires Bun and a running Ollama.

```sh
bun install
bun run dev         # restarts on file changes
```

The first run prints a Google login URL. Open it on the same machine and approve (click through the "unverified app" warning). The refresh token is saved in the database, so this happens once.

The model is downloaded automatically on startup if it is missing (~5 GB). Only mail arriving after the first run is stored; existing mail is not backfilled.

## Status dashboard

```sh
curl -s -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  "https://joppekoers.nl/proxy/gmail-sync/dashboard/terminal?width=$(tput cols)"
```

Locally, reading the token from `.env`:

```sh
curl -s -H "Authorization: Bearer $(grep '^DASHBOARD_TOKEN=' .env | cut -d= -f2-)" \
  "http://localhost:8086/dashboard/terminal?width=$(tput cols)"
```

Example output:

```
OK · synced 2m ago
SHOP      ORDER        PRODUCTS                                  STATUS     ETA         UPDATED
Boohoo    EU121967757  2x Oversized Cotton T-Shirt - Black, M…   shipped    2026-11-19  5h ago
Bol.com   A1B2         Sony WH-1000XM5                           delivered  -           2d ago
```

The first line is the health of the service:

| Verdict | When |
|---|---|
| `DOWN` | Never synced, last sync more than 60 minutes ago, or the Gmail watch has expired |
| `WARN` | Last sync more than 20 minutes ago, errors in the last hour, or the Gmail watch expires within a day |
| `OK` | Otherwise, followed by the time of the last sync |

The table lists all open orders plus orders finished (delivered, cancelled, returned) in the last 14 days, newest first.

- `width` sets the maximum line width: 30 to 300, default 120. When the table does not fit, the products column shrinks first, then columns are dropped (products, order, ETA, updated, shop). Status always stays.
- The token goes in the `Authorization` header, not the URL, so it does not end up in access logs. A wrong or missing token returns 401.
- Responses are sent with `Cache-Control: no-store` and without an ETag.

## Order tracking

Every new email goes to the model with a JSON schema. The model returns whether it is an order email, plus shop, order number, status, products (name, SKU, quantity), carrier, tracking number, tracking URL and expected delivery date.

- `isOrderEmail` is the first field generated. When it is `false`, the response stream is closed straight away so the model stops generating.
- Emails about the same order are merged on order number or tracking number, so a shop's confirmation and the carrier's tracking email become one order.
- An older email, for example during a catch-up, only fills in missing fields and never overwrites the status of a newer one.
- Statuses: `ordered`, `shipped`, `out_for_delivery`, `delivered`, `delayed`, `cancelled`, `returned`.
- If Ollama fails, the email is not stored and is retried 30 seconds later, so no order is missed.

## Data

Everything lives in `data/gmail-sync.db` (SQLite):

| Table | Contents |
|---|---|
| `emails` | Every stored email, including text and HTML bodies |
| `orders` | One row per order with its latest status and products |
| `order_events` | One row per email that changed an order |
| `logs` | All log output (also printed to stdout) |
| `kv` | OAuth refresh token, sync position, last sync time, watch expiry |

```sh
sqlite3 data/gmail-sync.db "SELECT merchant, order_number, status, tracking_url FROM orders ORDER BY updated_at DESC"
sqlite3 data/gmail-sync.db "SELECT at, level, message FROM logs ORDER BY id DESC LIMIT 20"
```

Queries use Drizzle; the schema is in `src/schema.ts`. After changing it, run `bun run db:generate` to create a migration in `drizzle/`. Migrations are applied automatically on startup. Check types with `bun run typecheck`.

Data from older versions (JSON files and `app.log` in `data/`) is imported into SQLite on startup and the old files are moved to `data/legacy-json/`.

## Docker

`make up` from the repo root starts the `gmail-sync` and `ollama` services. Data lives in `runtimeGenerated/gmail-sync`, the model in `runtimeGenerated/ollama`. nginx forwards `joppekoers.nl/proxy/gmail-sync/*` to the dashboard.

Ollama runs on CPU, so classifying one email takes roughly 30 to 120 seconds and uses about 6 GB of RAM while the model is loaded.

The first login needs a browser that can reach port 8085 in the container. That port is only bound to the server's localhost, so tunnel it:

```sh
ssh -L 8085:localhost:8085 <server>
docker logs gmail-sync   # open the printed URL on your laptop
```

Alternatively, log in locally, stop the local app, and copy `data/gmail-sync.db` to `runtimeGenerated/gmail-sync/gmail-sync.db` on the server.

## Known limitations

- If the app is offline for more than about a week, Gmail's history for the saved position expires. The app then resumes from the current mailbox state, and mail from that gap is not stored.
- During a long catch-up the dashboard can show `WARN` or `DOWN`, because the last sync time is only updated after a full sync round.
