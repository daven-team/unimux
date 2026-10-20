// GitHub's REST API and OAuth device flow, as far as "Publish to GitHub" needs them. Every request goes through an injected
// fetch (Electron's net.fetch in the app, a fake in the tests); the token only ever travels in a request header.
import type { GithubResult } from '../../shared/github';

export interface FetchResponse { status: number; ok: boolean; headers: { get(name: string): string | null }; json(): Promise<unknown> }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

export const API = 'https://api.github.com';
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const REQUEST_TIMEOUT_MS = 20_000;

export const ERR = {
  network: 'Brak połączenia z GitHubem. Sprawdź internet i spróbuj ponownie.',
  auth: 'Logowanie do GitHuba wygasło lub zostało cofnięte. Zaloguj się ponownie.',
  exists: 'Repozytorium o tej nazwie już istnieje na Twoim koncie GitHub.',
  forbidden: 'GitHub odmówił utworzenia repozytorium.',
  rateLimit: 'Przekroczono limit zapytań do GitHuba. Spróbuj za kilka minut.',
  failed: 'GitHub nie odpowiedział poprawnie. Spróbuj za chwilę.',
  invalidName: 'GitHub nie przyjął tej nazwy repozytorium.',
  expired: 'Kod logowania wygasł. Zacznij logowanie od nowa.',
  denied: 'Logowanie do GitHuba zostało odrzucone.',
  cancelled: 'Logowanie zostało anulowane.',
  noClient: 'Logowanie przez przeglądarkę nie jest dostępne w tej wersji.',
  deviceFailed: 'Nie udało się rozpocząć logowania do GitHuba.',
} as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max = 500): string | undefined => (typeof value === 'string' && value.length <= max ? value : undefined);
/** GitHub's own explanation, short and on one line (it is shown untranslated after our message). */
const githubMessage = (body: unknown): string | undefined => {
  const text = isObject(body) ? str(body.message, 2000) : undefined;
  return text ? text.replace(/\s+/g, ' ').trim().slice(0, 300) || undefined : undefined;
};

const apiHeaders = (token: string): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'unimux',
});

async function call(fetch: FetchLike, url: string, init: Parameters<FetchLike>[1]): Promise<{ status: number; headers: FetchResponse['headers']; body: unknown } | null> {
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, headers: response.headers, body };
  } catch { return null; }
}

export interface CreatedRepo { fullName: string; htmlUrl: string; cloneUrl: string }

/**
 * What a failed POST /user/repos means for the user: 401 the sign-in is no longer valid, 422 with "already exists" the name
 * is taken, 403 a missing permission or the rate limit, anything else GitHub's own message.
 */
export function mapCreateRepoError(status: number, body: unknown, headers?: { get(name: string): string | null }): Exclude<GithubResult<never>, { ok: true }> {
  const detail = githubMessage(body);
  const errors = isObject(body) && Array.isArray(body.errors) ? body.errors.filter(isObject) : [];
  const errorTexts = errors.map((e) => `${str(e.message) ?? ''} ${str(e.code) ?? ''} ${str(e.field) ?? ''}`).join(' ');
  if (status === 401) return { ok: false, code: 'auth', error: ERR.auth };
  if (status === 422) {
    if (/already exists/i.test(errorTexts) || /already exists/i.test(detail ?? '')) return { ok: false, code: 'exists', error: ERR.exists };
    const reason = errors.map((e) => str(e.message)).filter(Boolean).join('; ') || detail;
    return { ok: false, code: 'invalid', error: ERR.invalidName, ...(reason ? { detail: reason.slice(0, 300) } : {}) };
  }
  if (status === 403 || status === 429) {
    if (status === 429 || headers?.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail ?? '')) return { ok: false, code: 'rate-limit', error: ERR.rateLimit };
    return { ok: false, code: 'forbidden', error: ERR.forbidden, ...(detail ? { detail } : {}) };
  }
  return { ok: false, code: 'failed', error: ERR.failed, detail: detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}` };
}

/** Only a plain https://github.com/<owner>/<name>(.git) address is ever added as a remote or opened. */
const GITHUB_REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}(?:\.git)?$/;

/** POST /user/repos: a new repository of the signed-in user, without any file (the push brings the history). */
export async function createRepo(fetch: FetchLike, token: string, req: { name: string; private: boolean }): Promise<GithubResult<CreatedRepo>> {
  const res = await call(fetch, `${API}/user/repos`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: req.name, private: req.private, auto_init: false }),
  });
  if (!res) return { ok: false, code: 'network', error: ERR.network };
  if (res.status !== 201) return mapCreateRepoError(res.status, res.body, res.headers);
  const body = isObject(res.body) ? res.body : {};
  const fullName = str(body.full_name, 200);
  const htmlUrl = str(body.html_url, 300);
  const cloneUrl = str(body.clone_url, 300);
  if (!fullName || !htmlUrl || !cloneUrl || !GITHUB_REPO_URL.test(cloneUrl) || !GITHUB_REPO_URL.test(htmlUrl)) {
    return { ok: false, code: 'failed', error: ERR.failed, detail: 'unexpected answer' };
  }
  return { ok: true, data: { fullName, htmlUrl, cloneUrl } };
}

/** GET /user: the login of the token's owner; `auth` when GitHub no longer accepts the token. */
export async function fetchLogin(fetch: FetchLike, token: string): Promise<GithubResult<string>> {
  const res = await call(fetch, `${API}/user`, { method: 'GET', headers: apiHeaders(token) });
  if (!res) return { ok: false, code: 'network', error: ERR.network };
  if (res.status === 401) return { ok: false, code: 'auth', error: ERR.auth };
  const login = isObject(res.body) ? str(res.body.login, 100) : undefined;
  return res.status === 200 && login && /^[A-Za-z0-9-]+$/.test(login) ? { ok: true, data: login } : { ok: false, code: 'failed', error: ERR.failed, detail: `HTTP ${res.status}` };
}

// ---------- OAuth device flow (RFC 8628, GitHub's flavour) ----------

export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const formHeaders = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'unimux' };

export async function requestDeviceCode(fetch: FetchLike, clientId: string, scope: string): Promise<GithubResult<DeviceCode>> {
  if (!clientId) return { ok: false, code: 'no-client', error: ERR.noClient };
  const res = await call(fetch, DEVICE_CODE_URL, { method: 'POST', headers: formHeaders, body: form({ client_id: clientId, scope }) });
  if (!res) return { ok: false, code: 'network', error: ERR.network };
  const body = isObject(res.body) ? res.body : {};
  const deviceCode = str(body.device_code, 200);
  const userCode = str(body.user_code, 40);
  const verificationUri = str(body.verification_uri, 300);
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? Math.min(body.expires_in, 3600) : 900;
  const interval = typeof body.interval === 'number' && body.interval > 0 ? Math.min(body.interval, 60) : 5;
  if (res.status !== 200 || !deviceCode || !userCode || !verificationUri) {
    const reason = str(body.error_description) ?? str(body.error) ?? `HTTP ${res.status}`;
    return { ok: false, code: 'failed', error: ERR.deviceFailed, detail: reason.slice(0, 300) };
  }
  return { ok: true, data: { deviceCode, userCode, verificationUri, expiresIn, interval } };
}

/** One answer of the token endpoint: keep waiting (with the interval to use), the token, or the end of the flow. */
export type DevicePoll =
  | { kind: 'wait'; interval: number }
  | { kind: 'token'; token: string }
  | { kind: 'fail'; code: 'expired' | 'denied' | 'failed'; error: string; detail?: string };

/**
 * The poll state machine: authorization_pending keeps the interval, slow_down raises it (GitHub sends the new one; else +5 s per
 * the RFC), expired_token and access_denied end the flow, so does any other error. Pure: the tests drive it directly.
 */
export function devicePollStep(interval: number, status: number, body: unknown): DevicePoll {
  const value = isObject(body) ? body : {};
  const token = str(value.access_token, 1024);
  if (token && /^[\x21-\x7e]{10,1024}$/.test(token)) return { kind: 'token', token };
  const error = str(value.error, 100);
  if (error === 'authorization_pending') return { kind: 'wait', interval };
  if (error === 'slow_down') {
    const next = typeof value.interval === 'number' && value.interval > interval ? value.interval : interval + 5;
    return { kind: 'wait', interval: Math.min(next, 120) };
  }
  if (error === 'expired_token') return { kind: 'fail', code: 'expired', error: ERR.expired };
  if (error === 'access_denied') return { kind: 'fail', code: 'denied', error: ERR.denied };
  const reason = str(value.error_description) ?? error ?? `HTTP ${status}`;
  return { kind: 'fail', code: 'failed', error: ERR.deviceFailed, detail: reason.slice(0, 300) };
}

export interface PollOptions {
  fetch: FetchLike;
  clientId: string;
  code: DeviceCode;
  signal: AbortSignal;
  now?: () => number;
  /** Waits `ms`; resolves early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Network failures in a row after which the flow gives up (a short outage is waited out). */
  maxNetworkFailures?: number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = (): void => { clearTimeout(timer); resolve(); };
  signal.addEventListener('abort', stop, { once: true });
});

/** Polls the token endpoint every `interval` seconds until the user confirmed the code, refused it, or the code expired. */
export async function pollDeviceToken(options: PollOptions): Promise<GithubResult<{ token: string }>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxFailures = options.maxNetworkFailures ?? 4;
  const expiresAt = now() + options.code.expiresIn * 1000;
  let interval = Math.max(1, options.code.interval);
  let failures = 0;
  for (;;) {
    await sleep(interval * 1000, options.signal);
    if (options.signal.aborted) return { ok: false, code: 'cancelled', error: ERR.cancelled };
    if (now() >= expiresAt) return { ok: false, code: 'expired', error: ERR.expired };
    const res = await call(options.fetch, TOKEN_URL, {
      method: 'POST', headers: formHeaders, signal: options.signal,
      body: form({ client_id: options.clientId, device_code: options.code.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    if (options.signal.aborted) return { ok: false, code: 'cancelled', error: ERR.cancelled };
    if (!res) {
      if (++failures >= maxFailures) return { ok: false, code: 'network', error: ERR.network };
      continue;
    }
    failures = 0;
    const step = devicePollStep(interval, res.status, res.body);
    if (step.kind === 'wait') { interval = step.interval; continue; }
    if (step.kind === 'token') return { ok: true, data: { token: step.token } };
    return { ok: false, code: step.code, error: step.error, ...(step.detail ? { detail: step.detail } : {}) };
  }
}
