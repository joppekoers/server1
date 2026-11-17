import "./log";
import { startDashboard } from "./dashboard";
import { emailExists, getEmail, getKv, insertEmail, setKv, type StoredEmail } from "./db";
import { attempt, exitOnError, HttpError, readJson } from "./errors";
import { migrateLegacyJson } from "./migrate";
import { enqueueStaleEmails, ensureModel, processQueuedEmail, rebuildOrders } from "./orders";
import { countQueued, dequeue, enqueue, hasPendingRebuild, nextQueued } from "./queue";

const CLIENT_ID = exitOnError(requireEnv("GOOGLE_CLIENT_ID"));
const CLIENT_SECRET = exitOnError(requireEnv("GOOGLE_CLIENT_SECRET"));
const TOPIC = exitOnError(requireEnv("PUBSUB_TOPIC"));
const SUBSCRIPTION = exitOnError(requireEnv("PUBSUB_SUBSCRIPTION"));
const OAUTH_PORT = Number(process.env.OAUTH_PORT ?? 8085);

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB = "https://pubsub.googleapis.com/v1";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/pubsub"];
const BACKSTOP_SYNC_MS = 10 * 60_000;
const WATCH_RENEW_MARGIN_MS = 24 * 60 * 60_000;
const RETRY_DELAY_MS = 30_000;
const QUEUE_IDLE_MS = 2_000;

interface State {
  historyId?: string;
  watchExpiration?: number;
}

interface MessagePart {
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size: number };
  parts?: MessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  internalDate: string;
  payload: MessagePart;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

function requireEnv(name: string) {
  return process.env[name] || new Error(`Missing env var ${name}`);
}

function saveState(state: State) {
  if (state.historyId) setKv("historyId", state.historyId);
  if (state.watchExpiration) setKv("watchExpiration", String(state.watchExpiration));
}

async function exchangeToken(params: Record<string, string>) {
  const res = await attempt(
    fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
    }),
  );
  if (res instanceof Error) return res;
  if (!res.ok) return new HttpError(`Token request failed: ${res.status} ${await attempt(res.text())}`, res.status);
  return readJson<TokenResponse>(res);
}

async function authorizeInteractively() {
  const redirectUri = `http://localhost:${OAUTH_PORT}`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  }).toString();

  console.log(`Open this URL to authorize:\n${authUrl}`);

  const { promise, resolve } = Promise.withResolvers<string>();
  const server = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const code = new URL(req.url).searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });
      resolve(code);
      return new Response("Authorized, you can close this tab.");
    },
  });
  const code = await promise;
  server.stop();

  const token = await exchangeToken({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (token instanceof Error) return token;
  if (!token.refresh_token) return new Error("No refresh token returned");
  setKv("refreshToken", token.refresh_token);
  return token.refresh_token;
}

exitOnError(await migrateLegacyJson());
startDashboard(exitOnError(requireEnv("DASHBOARD_TOKEN")), { start: startBackfill, progress: backfillProgress });
const refreshToken = getKv("refreshToken") ?? exitOnError(await authorizeInteractively());

let accessToken = "";
let accessTokenExpiresAt = 0;

async function getAccessToken() {
  if (Date.now() < accessTokenExpiresAt - 60_000) return accessToken;
  const token = await exchangeToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
  if (token instanceof Error) return token;
  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + token.expires_in * 1000;
  return accessToken;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T | Error> {
  const token = await getAccessToken();
  if (token instanceof Error) return token;
  const res = await attempt(
    fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }),
  );
  if (res instanceof Error) return res;
  if (!res.ok) return new HttpError(`${res.status} ${url}: ${await attempt(res.text())}`, res.status);
  return readJson<T>(res);
}

async function ensureWatch(state: State) {
  if (state.watchExpiration && state.watchExpiration - Date.now() > WATCH_RENEW_MARGIN_MS) return;
  const watch = await api<{ historyId: string; expiration: string }>(`${GMAIL}/watch`, {
    method: "POST",
    body: JSON.stringify({ topicName: TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "include" }),
  });
  if (watch instanceof Error) return watch;
  state.watchExpiration = Number(watch.expiration);
  state.historyId ??= watch.historyId;
  saveState(state);
  console.log(`Watch active until ${new Date(state.watchExpiration).toISOString()}`);
}

function decodeBodies(part: MessagePart, result: { text: string[]; html: string[]; attachments: string[] }) {
  if (part.filename) result.attachments.push(part.filename);
  else if (part.body?.data && part.mimeType === "text/plain")
    result.text.push(Buffer.from(part.body.data, "base64url").toString());
  else if (part.body?.data && part.mimeType === "text/html")
    result.html.push(Buffer.from(part.body.data, "base64url").toString());
  part.parts?.forEach((child) => decodeBodies(child, result));
  return result;
}

async function fetchEmail(id: string): Promise<StoredEmail | Error> {
  const message = await api<GmailMessage>(`${GMAIL}/messages/${id}?format=full`);
  if (message instanceof Error) return message;
  const header = (name: string) =>
    message.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  const bodies = decodeBodies(message.payload, { text: [], html: [], attachments: [] });
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds,
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    from: header("From"),
    to: header("To"),
    cc: header("Cc"),
    subject: header("Subject"),
    snippet: message.snippet,
    text: bodies.text.join("\n"),
    html: bodies.html.join("\n"),
    attachments: bodies.attachments,
    headers: message.payload.headers,
  };
}

// The email is stored before parsing so a retry or restart does not fetch it from Gmail again.
async function processNextQueued() {
  const item = nextQueued();
  if (!item) return false;

  let email = getEmail(item.messageId);
  if (!email) {
    const fetched = await fetchEmail(item.messageId);
    if (fetched instanceof HttpError && fetched.status === 404) {
      console.warn(`Queued email ${item.messageId} no longer exists in Gmail, skipping`);
      dequeue(item.messageId);
      return true;
    }
    if (fetched instanceof Error) return fetched;
    insertEmail(fetched);
    email = fetched;
  }

  const processed = await processQueuedEmail(email, item.source);
  if (processed instanceof Error) return new Error(`Parsing ${item.messageId} failed: ${processed.message}`, { cause: processed });
  console.log(`Parsed ${item.messageId} (${item.source}): ${email.subject}`);
  return true;
}

async function runQueue() {
  while (true) {
    const result = await processNextQueued();
    if (result instanceof Error) {
      console.error(result);
      await Bun.sleep(RETRY_DELAY_MS);
    } else if (!result) {
      await Bun.sleep(QUEUE_IDLE_MS);
    }
  }
}

async function listRecentInboxMessageIds(days: number) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `newer_than:${days}d`,
      labelIds: "INBOX",
      maxResults: "500",
      ...(pageToken && { pageToken }),
    });
    const page = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(`${GMAIL}/messages?${params}`);
    if (page instanceof Error) return page;
    ids.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

let backfillListing = false;

function backfillProgress() {
  const remaining = countQueued("backfill");
  const total = Number(getKv("backfillTotal") ?? 0);
  return { running: backfillListing || remaining > 0, done: Math.max(0, total - remaining), total };
}

async function startBackfill(days: number) {
  if (backfillProgress().running) return null;
  backfillListing = true;
  const listed = await listRecentInboxMessageIds(days);
  backfillListing = false;
  if (listed instanceof Error) return listed;
  // Gmail lists newest first; queueing oldest first lets each order end with its latest status.
  const queued = enqueue(listed.filter((id) => !emailExists(id)).reverse(), "backfill");
  setKv("backfillTotal", String(queued));
  console.log(`Backfill of the last ${days} days: ${queued} new emails queued`);
  return queued;
}

type HistoryPage = {
  history?: { messagesAdded?: { message: { id: string } }[] }[];
  historyId: string;
  nextPageToken?: string;
};

async function syncHistory(state: State) {
  let pageToken: string | undefined;
  let latestHistoryId = state.historyId;
  do {
    const params = new URLSearchParams({
      startHistoryId: state.historyId!,
      historyTypes: "messageAdded",
      labelId: "INBOX",
      ...(pageToken && { pageToken }),
    });
    const page = await api<HistoryPage>(`${GMAIL}/history?${params}`);

    // Gmail returns 404 once a startHistoryId is too old to replay; restart from the current mailbox state.
    if (page instanceof HttpError && page.status === 404) {
      const profile = await api<{ historyId: string }>(`${GMAIL}/profile`);
      if (profile instanceof Error) return profile;
      latestHistoryId = profile.historyId;
      console.warn("History expired, resuming from current mailbox state");
      break;
    }
    if (page instanceof Error) return page;

    const added = (page.history ?? []).flatMap((entry) => (entry.messagesAdded ?? []).map(({ message }) => message.id));
    enqueue(
      added.filter((id) => !emailExists(id)),
      "new",
    );
    latestHistoryId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);

  state.historyId = latestHistoryId;
  saveState(state);
  setKv("lastSyncAt", new Date().toISOString());
}

async function pullNotifications() {
  const pulled = await api<{ receivedMessages?: { ackId: string }[] }>(`${PUBSUB}/${SUBSCRIPTION}:pull`, {
    method: "POST",
    body: JSON.stringify({ maxMessages: 100 }),
  });
  if (pulled instanceof Error) return pulled;
  const { receivedMessages = [] } = pulled;
  if (receivedMessages.length === 0) return false;
  const acked = await api(`${PUBSUB}/${SUBSCRIPTION}:acknowledge`, {
    method: "POST",
    body: JSON.stringify({ ackIds: receivedMessages.map((m) => m.ackId) }),
  });
  return acked instanceof Error ? acked : true;
}

exitOnError(await ensureModel());
setKv("emailAddress", exitOnError(await api<{ emailAddress: string }>(`${GMAIL}/profile`)).emailAddress);
const state: State = {
  historyId: getKv("historyId"),
  watchExpiration: Number(getKv("watchExpiration") ?? 0) || undefined,
};
exitOnError(await ensureWatch(state));
exitOnError(await syncHistory(state));
enqueueStaleEmails();
if (!hasPendingRebuild()) rebuildOrders();
void runQueue();

let lastSync = Date.now();

async function tick() {
  const notified = await pullNotifications();
  if (notified instanceof Error) return notified;
  if (!notified && Date.now() - lastSync <= BACKSTOP_SYNC_MS) return;

  const watched = await ensureWatch(state);
  if (watched instanceof Error) return watched;
  const synced = await syncHistory(state);
  if (synced instanceof Error) return synced;
  lastSync = Date.now();
}

console.log("Waiting for messages");
while (true) {
  const result = await tick();
  if (result instanceof Error) {
    console.error(result);
    await Bun.sleep(RETRY_DELAY_MS);
  }
}
