/**
 * One-click store connection through WooCommerce's authentication endpoint.
 *
 * The flow WooCommerce implements (plugins/woocommerce/includes/class-wc-auth.php):
 *
 *   1. We send the shop owner to `{store}/wc-auth/v1/authorize` with `app_name`,
 *      `scope`, `user_id`, `return_url` and `callback_url`, all URL-encoded.
 *   2. They approve inside their own WordPress admin.
 *   3. WooCommerce generates an API key and POSTs it as JSON to `callback_url`
 *      using `wp_safe_remote_post`. If that POST fails, it DELETES the key it
 *      just created — so the callback has to answer quickly and with a 2xx.
 *   4. Only then is the browser redirected to `return_url?success=1&user_id=…`.
 *
 * Two constraints from that file shape everything here, and neither is
 * negotiable from our side:
 *
 *   - `callback_url` must be HTTPS. WooCommerce throws outright otherwise
 *     ("The callback_url needs to be over SSL").
 *   - `wp_safe_remote_post` refuses private/loopback destinations, so the
 *     callback must be a genuinely public address, not just an HTTPS one.
 *
 * A localhost install therefore cannot use this flow at all. That is why
 * {@link resolvePublicOrigin} returns null rather than guessing: the caller
 * falls back to the manual key flow instead of sending someone to a page that
 * can only fail.
 */

import { createHash, randomBytes } from 'node:crypto';
import { assertSafeRemoteUrl, readTextLimited, safeFetch, UnsafeRemoteUrlError } from '../net/safe-fetch';
import { config } from '../config';
import { logger } from '../logger';

/** How long a minted authorization request stays redeemable. Long enough for a
 * WordPress login plus the approval screen, short enough that a leaked return
 * URL is worthless by the time anyone finds it. */
export const WOO_AUTH_TTL_MS = 10 * 60_000;

/** Scope requested from WooCommerce. Read-only is not enough: confirming a
 * payment moves the order to the next status (see skills/payments.ts). */
export const WOO_AUTH_SCOPE = 'read_write';

const PROBE_TIMEOUT_MS = 12_000;
const PROBE_MAX_BYTES = 512 * 1024;

export class StoreUrlError extends Error {
  constructor(readonly code: 'invalid_store_url' | 'unsafe_store_url') {
    super(code);
    this.name = 'StoreUrlError';
  }
}

/**
 * Turn whatever the shop owner typed into the base URL the REST client expects.
 *
 * Handles the things people actually paste: a bare domain, a `www.` prefix, a
 * trailing slash, the wp-admin page they were just looking at, or the REST root
 * itself. A sub-directory install (`example.com/tienda`) keeps its path,
 * because that path is part of the REST base.
 */
export function normalizeStoreUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2_048) throw new StoreUrlError('invalid_store_url');

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new StoreUrlError('invalid_store_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new StoreUrlError('invalid_store_url');
  if (url.username || url.password) throw new StoreUrlError('invalid_store_url');
  if (!url.hostname) throw new StoreUrlError('invalid_store_url');

  // Cut anything that is clearly a page rather than the site root. Someone who
  // copies their browser's address bar from the WooCommerce settings screen
  // should still end up with a usable base.
  let path = url.pathname;
  for (const marker of ['/wp-admin', '/wp-json', '/wp-login.php', '/wc-auth']) {
    const at = path.toLowerCase().indexOf(marker);
    if (at >= 0) path = path.slice(0, at);
  }
  path = path.replace(/\/+$/, '');

  return `${url.origin}${path}`;
}

/** Build `{store}/wc-auth/v1/authorize` without losing a sub-directory path. */
function authorizeEndpoint(storeBase: string): URL {
  return new URL(`${storeBase}/wc-auth/v1/authorize`);
}

export interface PublicOriginHeaders {
  forwardedProto?: string | undefined;
  forwardedHost?: string | undefined;
}

/**
 * The origin a third party can reach this deployment at.
 *
 * `PUBLIC_URL` wins because it is the only source that is reliable behind every
 * proxy topology: a TLS-terminating reverse proxy in front of Next.js does not
 * always surface the external scheme, so inferring it from forwarded headers
 * alone would happily produce an `http://` origin for a site that is actually
 * served over HTTPS. The header path stays as a convenience for setups that do
 * forward them correctly.
 *
 * Returns null when the result is anything WooCommerce would reject, so callers
 * can degrade to the manual flow instead of building a doomed URL.
 */
export function resolvePublicOrigin(
  headers: PublicOriginHeaders,
  /** Injected so both branches are reachable in tests: `config` is parsed once
   * at import time, so stubbing `process.env.PUBLIC_URL` afterwards would have
   * no effect. Pass `null` for "explicitly unset"; production callers omit it
   * and get the configured value. */
  configuredUrl: string | null | undefined = config.PUBLIC_URL,
): URL | null {
  const candidate = configuredUrl ?? forwardedOrigin(headers);
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return url;
}

function forwardedOrigin({ forwardedProto, forwardedHost }: PublicOriginHeaders): string | null {
  const proto = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  const host = forwardedHost?.split(',')[0]?.trim();
  if (!proto || !host) return null;
  if (!/^[A-Za-z0-9.:_[\]-]{1,255}$/.test(host)) return null;
  return `${proto}://${host}`;
}

/**
 * True when WooCommerce's `wp_safe_remote_post` would actually be allowed to
 * reach this origin. An HTTPS URL pointing at a LAN address passes WooCommerce's
 * scheme check and then silently fails the request, which would strand the
 * owner on a spinner — better to detect it up front and offer the manual path.
 */
export async function isReachablePublicOrigin(origin: URL): Promise<boolean> {
  if (origin.protocol !== 'https:') return false;
  try {
    // Reuses the resolver-and-denylist pass safeFetch performs before every
    // hop, so "public" means exactly what it means everywhere else in Arix.
    await assertSafeRemoteUrl(origin);
    return true;
  } catch (err) {
    if (err instanceof UnsafeRemoteUrlError) return false;
    throw err;
  }
}

export interface WooAuthorizeUrlInput {
  storeBase: string;
  publicOrigin: URL;
  /** The `setup_auth_requests` row id. Comes back to us in the callback body. */
  requestId: string;
  /** Raw one-time nonce; only its hash is ever persisted. */
  state: string;
}

export function buildWooAuthorizeUrl({
  storeBase,
  publicOrigin,
  requestId,
  state,
}: WooAuthorizeUrlInput): string {
  const url = authorizeEndpoint(storeBase);
  // URL.searchParams encodes every value, which the endpoint requires.
  url.searchParams.set('app_name', 'Arix');
  url.searchParams.set('scope', WOO_AUTH_SCOPE);
  url.searchParams.set('user_id', requestId);
  url.searchParams.set('return_url', new URL(`/setup?woo=${encodeURIComponent(requestId)}`, publicOrigin).toString());
  url.searchParams.set(
    'callback_url',
    new URL(`/api/integrations/woocommerce/callback/${encodeURIComponent(state)}`, publicOrigin).toString(),
  );
  return url.toString();
}

/** 32 bytes of entropy, plus the digest that is all we store. */
export function mintAuthState(): { state: string; stateHash: string } {
  const state = randomBytes(32).toString('hex');
  return { state, stateHash: hashAuthState(state) };
}

export function hashAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

export interface WooCallbackCredentials {
  consumerKey: string;
  consumerSecret: string;
}

// WooCommerce derives both halves from a hash, so the shape is stable even
// though the exact length has changed across releases. Bounded on both ends so
// a hostile POST can neither smuggle control characters nor blow the 8 KiB
// ceiling the settings writer enforces for secrets.
const CONSUMER_KEY_RE = /^ck_[A-Za-z0-9]{20,128}$/;
const CONSUMER_SECRET_RE = /^cs_[A-Za-z0-9]{20,128}$/;

/**
 * Validate the JSON WooCommerce posts back. Everything here is attacker-shaped
 * input: the endpoint is unauthenticated by necessity, so the only things we
 * accept from the body are the two credentials and the request id we minted —
 * the store URL is read from our own row, never from this payload.
 */
export function parseWooCallbackBody(body: unknown, expectedRequestId: string): WooCallbackCredentials | null {
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as Record<string, unknown>;

  const userId = payload.user_id;
  const userIdText = typeof userId === 'string' ? userId : typeof userId === 'number' ? String(userId) : null;
  if (userIdText !== expectedRequestId) return null;

  const consumerKey = payload.consumer_key;
  const consumerSecret = payload.consumer_secret;
  if (typeof consumerKey !== 'string' || !CONSUMER_KEY_RE.test(consumerKey)) return null;
  if (typeof consumerSecret !== 'string' || !CONSUMER_SECRET_RE.test(consumerSecret)) return null;

  // A read-only key would let the agent quote the catalog but never confirm a
  // payment, failing much later and much more confusingly than right here.
  const permissions = payload.key_permissions;
  if (typeof permissions === 'string' && permissions !== WOO_AUTH_SCOPE) return null;

  return { consumerKey, consumerSecret };
}

export interface WooStoreProbe {
  /** The site answered at all. */
  reachable: boolean;
  /** A WordPress REST root was found. */
  wordpress: boolean;
  /** The `wc/v3` namespace is advertised. */
  woocommerce: boolean;
  /**
   * False when the site only answers on `?rest_route=`. WooCommerce registers
   * the auth endpoint as a rewrite rule (`^wc-auth/v([1]{1})/(.*)?`), so with
   * plain permalinks the one-click URL 404s and only the manual flow works.
   */
  prettyPermalinks: boolean;
  /** Site title from the REST root, purely to confirm to the owner that we
   * found the right store. */
  name: string | null;
}

/**
 * Look at a store before sending anyone anywhere. Failure is never fatal: an
 * unreachable probe just means we present the manual flow with a hint.
 */
export async function probeWooStore(storeBase: string, signal?: AbortSignal): Promise<WooStoreProbe> {
  const probe: WooStoreProbe = {
    reachable: false,
    wordpress: false,
    woocommerce: false,
    prettyPermalinks: false,
    name: null,
  };

  const pretty = await fetchRestRoot(`${storeBase}/wp-json/`, signal);
  if (pretty) {
    probe.reachable = true;
    probe.wordpress = true;
    probe.prettyPermalinks = true;
    probe.woocommerce = pretty.woocommerce;
    probe.name = pretty.name;
    return probe;
  }

  const plain = await fetchRestRoot(`${storeBase}/?rest_route=/`, signal);
  if (plain) {
    probe.reachable = true;
    probe.wordpress = true;
    probe.prettyPermalinks = false;
    probe.woocommerce = plain.woocommerce;
    probe.name = plain.name;
    return probe;
  }

  probe.reachable = await siteAnswers(storeBase, signal);
  return probe;
}

async function fetchRestRoot(
  url: string,
  signal?: AbortSignal,
): Promise<{ woocommerce: boolean; name: string | null } | null> {
  try {
    const res = await safeFetch(url, { headers: { Accept: 'application/json' }, signal }, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxResponseBytes: PROBE_MAX_BYTES,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const parsed: unknown = JSON.parse(await readTextLimited(res, PROBE_MAX_BYTES));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const root = parsed as { namespaces?: unknown; name?: unknown };
    const namespaces = Array.isArray(root.namespaces) ? root.namespaces : [];
    return {
      woocommerce: namespaces.some((ns) => typeof ns === 'string' && ns.toLowerCase() === 'wc/v3'),
      name: typeof root.name === 'string' ? root.name.slice(0, 120) : null,
    };
  } catch (err) {
    logger.debug({ errorType: err instanceof Error ? err.name : typeof err }, 'woo probe: REST root unavailable');
    return null;
  }
}

async function siteAnswers(storeBase: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await safeFetch(storeBase, { method: 'HEAD', signal }, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxResponseBytes: 1_024,
    });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Deep link to the "Add key" screen, so the manual path is one click too. */
export function wooCreateKeyUrl(storeBase: string): string {
  return `${storeBase}/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys&create-key=1`;
}

// ---- Delivered-but-unclaimed credentials -----------------------------------
//
// The callback does NOT persist what it receives. The nonce that authorizes it
// travels inside the authorization URL, which means it passes through — and is
// very likely logged by — the shop's own web server. Single-use and a ten-minute
// window keep that from being worth much, but requiring the administrator's
// authenticated browser to come back and claim the result adds a second,
// session-bound authorization before anything is written, and gives us somewhere
// to verify the credentials actually work before saving them.
//
// Held in memory on purpose: this is a short-lived handshake with no external
// side effects. A restart mid-flow costs one click, and nothing credential-
// bearing is ever written to disk.

interface DeliveredCredentials extends WooCallbackCredentials {
  storeBase: string;
  deliveredAt: number;
}

const MAX_PENDING_DELIVERIES = 8;
const delivered = new Map<string, DeliveredCredentials>();

function evictStaleDeliveries(now: number): void {
  for (const [id, entry] of delivered) {
    if (now - entry.deliveredAt > WOO_AUTH_TTL_MS) delivered.delete(id);
  }
  while (delivered.size >= MAX_PENDING_DELIVERIES) {
    const oldest = delivered.keys().next().value;
    if (oldest === undefined) break;
    delivered.delete(oldest);
  }
}

export function storeDeliveredCredentials(
  requestId: string,
  storeBase: string,
  credentials: WooCallbackCredentials,
): void {
  const now = Date.now();
  evictStaleDeliveries(now);
  delivered.set(requestId, { ...credentials, storeBase, deliveredAt: now });
}

export function hasDeliveredCredentials(requestId: string): boolean {
  const entry = delivered.get(requestId);
  if (!entry) return false;
  if (Date.now() - entry.deliveredAt > WOO_AUTH_TTL_MS) {
    delivered.delete(requestId);
    return false;
  }
  return true;
}

/** Read and remove in one step — a claim either succeeds once or not at all. */
export function takeDeliveredCredentials(requestId: string): DeliveredCredentials | null {
  const entry = delivered.get(requestId);
  delivered.delete(requestId);
  if (!entry) return null;
  return Date.now() - entry.deliveredAt > WOO_AUTH_TTL_MS ? null : entry;
}

/** Test seam only — production code never needs to clear this. */
export function resetDeliveredCredentials(): void {
  delivered.clear();
}

// ---- Shared credential probe ------------------------------------------------

export interface WooCredentialProbe {
  ok: boolean;
  sampleProductName?: string | null;
  /** Already-safe English sentence; never the store's own error text. */
  error?: string;
}

/** Maps a probe HTTP status to a message that is safe to show an end user. */
export function safeWooCredentialError(status: number): string {
  if (status === 401 || status === 403) return 'Invalid consumer key/secret, or REST API access is disabled.';
  if (status === 404) return 'WooCommerce REST API not found at this URL — check the store URL.';
  if (status >= 500) return 'The store is currently unavailable.';
  return `The store rejected the request (HTTP ${status}).`;
}

/**
 * One live read against the store's catalog — the same check the "test
 * connection" button performs. Shared so the manual flow, the one-click claim
 * and the settings screen can never drift apart in what "connected" means.
 */
export async function probeWooCredentials(
  storeBase: string,
  consumerKey: string,
  consumerSecret: string,
  signal?: AbortSignal,
): Promise<WooCredentialProbe> {
  let target: URL;
  try {
    target = new URL(`${storeBase.replace(/\/$/, '')}/wp-json/wc/v3/products`);
  } catch {
    return { ok: false, error: 'Invalid store URL' };
  }
  target.searchParams.set('per_page', '1');
  const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;

  try {
    const res = await safeFetch(target, { headers: { Authorization: auth, Accept: 'application/json' }, signal }, {
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: safeWooCredentialError(res.status) };
    }
    const parsed: unknown = JSON.parse(await readTextLimited(res, 1_000_000));
    const products = Array.isArray(parsed) ? (parsed as Array<{ name?: unknown }>) : [];
    return { ok: true, sampleProductName: typeof products[0]?.name === 'string' ? products[0].name : null };
  } catch (err) {
    if (err instanceof UnsafeRemoteUrlError) {
      return { ok: false, error: 'This URL is not allowed by the server network policy.' };
    }
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, error: 'Request timed out.' };
    return { ok: false, error: 'Could not connect to the WooCommerce store with these credentials.' };
  }
}
