// Readmo AI article summary — Edge Function.
//
// POST /functions/v1/summary { itemId }
// Returns a short AI summary of an article (mirrors newshacker's article
// summary). The reader asks for this when an ALLOWLISTED user PINS an article —
// the pin is the trigger (enforced client-side: the reader only calls this for a
// pinned item) and the allowlist is the boundary (enforced here). SPEC.md
// "AI article summaries".
//
// Trust + access:
//   - The caller's forwarded JWT scopes the item lookup through RLS (items_select,
//     0002): a user who can't see the item gets a 404. The service-role client
//     does the cached write (client item writes are revoked; 0002/0009).
//   - Summaries are a generation-cost surface (each cache miss is a Jina fetch +
//     a Gemini call), so — like reading mode and Google News — they're gated on
//     the DB `allowlist` table (the shared trusted-user list, managed from
//     /admin; see _shared/allowlist.ts). Empty table → open to all; once armed, a
//     non-listed caller gets a silent `empty` before any item lookup, Jina, or
//     Gemini call, so they never spend the budget.
//
// Article text — Jina, deliberately:
//   Like newshacker, the summary's article text comes from Jina Reader
//   (r.jina.ai), which returns clean MARKDOWN and handles bot-blocked / paywalled
//   / JS-rendered pages. This is the deliberate split from reading mode: the
//   `fulltext` path FETCHES + SERVES + extracts the article itself, so it must
//   be a polite first-party citizen (our User-Agent via safeFetch; honoring
//   robots is the intended posture there). The summary is a transient short
//   gist — never stored/served verbatim — so it routes through Jina, a third-party
//   reader, instead of our own fetcher. Tokenized/secret-bearing item URLs are
//   screened out before forwarding to Jina (guardrail #6, same guards as
//   fulltext): we never hand a subscriber token to a third party. When Jina is
//   unconfigured / blocked (tokenized URL) / fails, we fall back to summarizing
//   the body we already store (`full_content_html` ?? `content_html`), so the
//   feature still works without a new fetch.
//
// Outcomes are reported as a 200 { status, summary } envelope so the reader can
// stay silent on a soft failure (it just shows no summary card):
//   ok          — summary is the summary string (fresh or cache hit).
//   empty       — nothing to summarize: no article text at all; OR only a
//                 truncated feed stub is available (Jina down/screened + no full
//                 body) — flagged `retryable`, with NO Gemini call spent, so a
//                 later mount re-checks once Jina/full text lands; OR the
//                 allowlist denial (also `retryable`).
//   unavailable — the Gemini key isn't configured (`retryable:true`: re-checks
//                 once the operator sets GOOGLE_API_KEY).
//   unreachable — a transient failure (allowlist read, auth lookup, or the Gemini
//                 call failed); retryable.
// Hard errors keep their HTTP status: 400 (bad request), 401 (no JWT — platform),
// 404 (item not visible/found), 405 (wrong method).
//
// Thin entrypoint — prompt/parse/select logic is unit-tested in _shared/summary.ts.
// Deno resolves bare specifiers via ../import_map.json.

// @ts-nocheck — runs under Deno, not node/tsc.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { loadAllowlistFromDb, isAllowed } from '../_shared/allowlist.ts';
import { looksTokenized, redactUrl } from '../_shared/urlSafety.ts';
import { assertSafeUrl } from '../_shared/ssrf.ts';
import {
  buildSummaryPrompt,
  clampSummaryText,
  parseGeminiText,
  pickStoredContent,
} from '../_shared/summary.ts';

const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 20_000;
const JINA_TIMEOUT_MS = 15_000;
const JINA_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB, matching fulltext

Deno.serve(async (req: Request) => {
  // Top-level guard so an unexpected throw produces an Edge Function log line,
  // not a bare EDGE_FUNCTION_ERROR.
  try {
    return await handle(req);
  } catch (err) {
    console.error('summary: unhandled error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') {
    console.warn(`summary: rejected ${req.method} (POST only)`);
    return json({ error: 'POST only' }, 405);
  }

  let itemId: string | undefined;
  try {
    ({ itemId } = await req.json());
  } catch {
    console.warn('summary: rejected request with invalid JSON body');
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof itemId !== 'string' || !itemId) {
    console.warn('summary: rejected request with missing itemId');
    return json({ error: 'Missing itemId' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Allowlist gate (same list as reading mode / Google News). Checked BEFORE the
  // item lookup, the cache read, and any Jina/Gemini call, so a non-listed caller
  // never spends the generation budget. An EMPTY list leaves the feature open to
  // all. A blocked caller gets a silent `empty` flagged `retryable` so a later
  // allowlist change un-sticks them (additive field; old clients still see plain
  // `empty`). Fail CLOSED on a DB read error.
  let allowlist: Set<string>;
  try {
    allowlist = await loadAllowlistFromDb(service);
  } catch (err) {
    console.error('summary: allowlist read failed — retryable unreachable:', err);
    return json({ status: 'unreachable', summary: null });
  }
  if (allowlist.size > 0) {
    const { data: auth, error: authError } = await userClient.auth.getUser();
    if (authError || !auth?.user) {
      // A transient auth lookup failure must not be cached as the terminal
      // `empty`; report the retryable `unreachable` so an allowlisted caller
      // retries instead of being stuck with no summary.
      console.warn('summary: auth lookup failed — retryable unreachable:', authError);
      return json({ status: 'unreachable', summary: null });
    }
    if (!isAllowed({ id: auth.user.id, email: auth.user.email }, allowlist)) {
      console.log('summary: caller not on the allowlist — no summary');
      return json({ status: 'empty', summary: null, retryable: true });
    }
  }

  // RLS-scoped lookup: only resolves if the caller may see this item.
  const { data: item, error } = await userClient
    .from('items')
    .select('id, feed_id, url, title, content_html, full_content_html, ai_summary')
    .eq('id', itemId)
    .maybeSingle();
  if (error) {
    console.error(`summary: item lookup for ${itemId} failed:`, error);
    return json({ error: error.message }, 400);
  }
  if (!item) {
    console.warn(`summary: item ${itemId} not found or not visible to caller`);
    return json({ error: 'Item not found' }, 404);
  }

  // Cache hit — the summary lives on the shared item, so one caller's generation
  // serves every subscriber who later pins the same article.
  if (item.ai_summary) {
    console.log(`summary: item ${itemId} — cache hit`);
    return json({ status: 'ok', summary: item.ai_summary });
  }

  const apiKey = Deno.env.get('GOOGLE_API_KEY');
  if (!apiKey) {
    // Not configured. Retryable so the reader re-checks once the operator sets
    // the secret, rather than caching "no summary" forever.
    console.warn('summary: GOOGLE_API_KEY not set — unavailable');
    return json({ status: 'unavailable', summary: null, retryable: true });
  }

  // Article text: Jina markdown is the primary source (handles bot-blocked /
  // paywalled / JS-rendered pages, and keeps the summary off our polite
  // first-party fetcher). Fall back to the body we already store when Jina is
  // unconfigured, the URL looks secret-bearing, or the fetch fails.
  let content = await maybeFetchViaJinaMarkdown(service, item.feed_id, item.url);
  let source = 'jina';
  if (!content) {
    const stored = pickStoredContent({
      contentHtml: item.content_html,
      fullContentHtml: item.full_content_html,
    });
    if (!stored) {
      // No Jina text AND no stored body. If the item has a URL this is
      // TRANSIENT — Jina may be unconfigured / down / screened now (or a full
      // body could be extracted later), so flag `retryable` and the reader
      // re-checks on a later mount once it can yield text. Only a URL-less,
      // body-less item is truly terminal (nothing to ever summarize).
      console.log(`summary: item ${itemId} — no article text from Jina or storage`);
      return json({
        status: 'empty',
        summary: null,
        ...(item.url ? { retryable: true } : {}),
      });
    }
    if (!stored.cacheable) {
      // Only a truncated feed stub is available (Jina down/screened AND no full
      // body extracted yet). Don't spend a Gemini call summarizing a teaser that
      // can't improve until Jina or full-text extraction lands — a summary of the
      // stub would be both low-quality and uncacheable, so we'd re-pay Gemini on
      // every reader mount. Defer with a retryable `empty` instead (no card, no
      // spend); the next mount re-checks once better content exists.
      console.log(`summary: item ${itemId} — only a stub available, deferring (retryable empty)`);
      return json({ status: 'empty', summary: null, retryable: true });
    }
    content = stored.text;
    source = 'stored';
  }

  // Content here is always the full article (Jina markdown, the extraction, or a
  // non-truncated feed body), so the generated summary is always safe to cache.
  const summary = await generateSummary(apiKey, item.title, content);
  if (!summary) {
    console.warn(`summary: item ${itemId} — generation failed`);
    return json({ status: 'unreachable', summary: null });
  }
  console.log(`summary: item ${itemId} — generated ${summary.length} chars from ${source}, caching`);

  // Cache on the shared item (service role; client item writes are revoked).
  const { error: writeError } = await service
    .from('items')
    .update({
      ai_summary: summary,
      ai_summary_generated_at: new Date().toISOString(),
    })
    .eq('id', itemId);
  if (writeError) {
    // The summary still succeeded for this caller; surface it even if the cache
    // write failed (the next caller just regenerates).
    console.error(`summary: cache write for item ${itemId} failed:`, writeError);
  }
  return json({ status: 'ok', summary });
}

/** Fetch the article as Jina markdown, but only for URLs we're reasonably sure
 * carry no secret — the same two guards fulltext uses (guardrail #6):
 *   (a) skip feeds that carry a secret_url (definitely private; read with the
 *       service-role client), and
 *   (b) screen the item URL with looksTokenized() (query strings, long
 *       hex/base64url blobs, embedded credentials).
 * Either trips → return null (don't forward to the third party), and the caller
 * falls back to the stored body. Returns clamped markdown, or null. */
async function maybeFetchViaJinaMarkdown(
  service: any,
  feedId: string,
  url: string | null,
): Promise<string | null> {
  if (!url) return null;
  // Obey the same URL policy as our other server-side fetches before handing a
  // publisher-controlled URL to a third party (guardrail #6): http/https only,
  // no embedded credentials, and reject internal-address IP literals
  // (loopback / link-local incl. 169.254.169.254 / RFC1918). assertSafeUrl does
  // the scheme + IP-literal checks synchronously (no DNS — we don't connect to
  // the target ourselves; Jina does). Unsafe → don't forward; fall back to the
  // stored body. Note this is the URL screen the fulltext path gets for free via
  // safeFetch on its direct fetch; here Jina is the primary path, so we apply it
  // explicitly.
  try {
    assertSafeUrl(url);
  } catch {
    return null;
  }
  if (looksTokenized(url)) return null; // URL looks secret-bearing → never forward
  const { data: feed } = await service
    .from('feeds')
    .select('secret_url')
    .eq('id', feedId)
    .maybeSingle();
  if (!feed || feed.secret_url) return null; // private/tokenized feed → skip
  return fetchViaJinaMarkdown(url);
}

/** Fetch a page via Jina Reader (r.jina.ai) as markdown. The fetch target is
 * always the fixed host r.jina.ai (the article URL only appears in the path), so
 * there's no redirect-based SSRF here. Returns clamped markdown, or null if Jina
 * is unconfigured or the request fails / exceeds the size cap. The URL has
 * already been screened by maybeFetchViaJinaMarkdown. */
async function fetchViaJinaMarkdown(target: string): Promise<string | null> {
  const apiKey = Deno.env.get('JINA_API_KEY');
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://r.jina.ai/${target}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Return-Format': 'markdown',
        'Accept': 'text/markdown',
      },
      signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`summary: Jina responded HTTP ${res.status} for ${redactUrl(target)}`);
      return null;
    }
    const reader = res.body?.getReader();
    let text: string;
    if (!reader) {
      text = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        total += value.byteLength;
        if (total > JINA_MAX_BYTES) {
          reader.cancel();
          console.warn(`summary: Jina body exceeded ${JINA_MAX_BYTES} bytes for ${redactUrl(target)}`);
          return null;
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      text = new TextDecoder().decode(out);
    }
    return clampSummaryText(text);
  } catch (err) {
    console.warn(`summary: Jina fetch failed for ${redactUrl(target)}:`, err);
    return null;
  }
}

/** Call Gemini's `generateContent` REST endpoint for a short summary.
 * The target is the fixed Google host (the article is in the request body, never
 * a URL), so there's no SSRF surface. Returns the summary text, or null on
 * timeout / non-2xx / unparseable response so the handler reports a soft failure.
 * `thinkingBudget: 0` disables the hidden reasoning tokens that otherwise
 * dominate latency for a task this small (matches newshacker). */
async function generateSummary(
  apiKey: string,
  title: string | null,
  content: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildSummaryPrompt(title, content) }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`summary: Gemini responded HTTP ${res.status}`);
      return null;
    }
    return parseGeminiText(await res.json());
  } catch (err) {
    console.warn('summary: Gemini call failed:', err);
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
