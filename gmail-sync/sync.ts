import "./log";
import { emailExists, getKv, setKv } from "./db";
import { migrateLegacyJson } from "./migrate";
import { ensureModel, processEmail } from "./orders";

const CLIENT_ID = requireEnv("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = requireEnv("GOOGLE_CLIENT_SECRET");
const TOPIC = requireEnv("PUBSUB_TOPIC");
const SUBSCRIPTION = requireEnv("PUBSUB_SUBSCRIPTION");
const OAUTH_PORT = Number(process.env.OAUTH_PORT ?? 8085);

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB = "https://pubsub.googleapis.com/v1";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/pubsub"];
const BACKSTOP_SYNC_MS = 10 * 60_000;
const WATCH_RENEW_MARGIN_MS = 24 * 60 * 60_000;

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

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function saveState(state: State) {
  if (state.historyId) setKv("historyId", state.historyId);
  if (state.watchExpiration) setKv("watchExpiration", String(state.watchExpiration));
}

async function exchangeToken(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; expires_in: number; refresh_token?: string }>;
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
  if (!token.refresh_token) throw new Error("No refresh token returned");
  setKv("refreshToken", token.refresh_token);
  return token.refresh_token;
}

await migrateLegacyJson();
const refreshToken = getKv("refreshToken") ?? (await authorizeInteractively());

let accessToken = "";
let accessTokenExpiresAt = 0;

async function getAccessToken() {
  if (Date.now() < accessTokenExpiresAt - 60_000) return accessToken;
  const token = await exchangeToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + token.expires_in * 1000;
  return accessToken;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}: ${await res.text()}`), { status: res.status });
  return res.json() as Promise<T>;
}

async function ensureWatch(state: State) {
  if (state.watchExpiration && state.watchExpiration - Date.now() > WATCH_RENEW_MARGIN_MS) return;
  const watch = await api<{ historyId: string; expiration: string }>(`${GMAIL}/watch`, {
    method: "POST",
    body: JSON.stringify({ topicName: TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "include" }),
  });
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

async function saveMessage(id: string) {
  if (emailExists(id)) return;

  const message = await api<GmailMessage>(`${GMAIL}/messages/${id}?format=full`);
  const header = (name: string) =>
    message.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  const bodies = decodeBodies(message.payload, { text: [], html: [], attachments: [] });
  const email = {
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

  await processEmail(email);
  console.log(`Saved ${id}: ${email.subject}`);
}

async function syncHistory(state: State) {
  let pageToken: string | undefined;
  let latestHistoryId = state.historyId;
  try {
    do {
      const params = new URLSearchParams({
        startHistoryId: state.historyId!,
        historyTypes: "messageAdded",
        labelId: "INBOX",
        ...(pageToken && { pageToken }),
      });
      const page = await api<{
        history?: { messagesAdded?: { message: { id: string } }[] }[];
        historyId: string;
        nextPageToken?: string;
      }>(`${GMAIL}/history?${params}`);

      for (const entry of page.history ?? []) {
        for (const { message } of entry.messagesAdded ?? []) await saveMessage(message.id);
      }
      latestHistoryId = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (error) {
    // Gmail returns 404 once a startHistoryId is too old to replay; restart from the current mailbox state.
    if ((error as { status?: number }).status !== 404) throw error;
    latestHistoryId = (await api<{ historyId: string }>(`${GMAIL}/profile`)).historyId;
    console.warn("History expired, resuming from current mailbox state");
  }
  state.historyId = latestHistoryId;
  saveState(state);
}

async function pullNotifications() {
  const { receivedMessages = [] } = await api<{ receivedMessages?: { ackId: string }[] }>(
    `${PUBSUB}/${SUBSCRIPTION}:pull`,
    { method: "POST", body: JSON.stringify({ maxMessages: 100 }) },
  );
  if (receivedMessages.length === 0) return false;
  await api(`${PUBSUB}/${SUBSCRIPTION}:acknowledge`, {
    method: "POST",
    body: JSON.stringify({ ackIds: receivedMessages.map((m) => m.ackId) }),
  });
  return true;
}

await ensureModel();
const state: State = {
  historyId: getKv("historyId"),
  watchExpiration: Number(getKv("watchExpiration") ?? 0) || undefined,
};
await ensureWatch(state);
await syncHistory(state);

console.log("Waiting for messages");
let lastSync = Date.now();
while (true) {
  try {
    const notified = await pullNotifications();
    if (notified || Date.now() - lastSync > BACKSTOP_SYNC_MS) {
      await ensureWatch(state);
      await syncHistory(state);
      lastSync = Date.now();
    }
  } catch (error) {
    console.error(error);
    await Bun.sleep(30_000);
  }
}
