// Relay between the session tracker and the Anthropic API.
// The API key lives in the ANTHROPIC_API_KEY secret and never reaches the browser.
//
// This file and the Worker in the Cloudflare dashboard drifted apart: the
// dashboard had the upstream-refusal reporting below and no rate limiting at
// all, while this file had the rate limiting and passed refusals through
// blind. Both halves are here now. Paste this whole file into the dashboard
// after changing it, or the two will part company again.

const ALLOWED_ORIGINS = new Set([
  "https://lewisros1.github.io",
]);

const ALLOWED_MODELS = new Set(["claude-sonnet-5"]);

// ── Translation ─────────────────────────────────────────────
// A second upstream, on /translate, for turning a finished report into
// Chinese. OpenAI rather than Anthropic because Lewis judged its Chinese
// better, having read both. Its key lives in OPENAI_API_KEY and, like the
// other one, never reaches the browser.
//
// Models as OpenAI's own documentation names them. Sol is the default: near
// flagship quality at a lower price, and translation leans on language
// rather than on reasoning.
const ALLOWED_OPENAI_MODELS = new Set(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]);
const MAX_TOKENS_CAP = 32000;
const MAX_BODY_BYTES = 300000;   // a real half-year prompt is far below this

// How many times to ask again when the API never saw the request.
//
// A half-year report failed with 403 twice over two days and then worked,
// unchanged, on the same student and the same months. Not the key -- a
// monthly report worked throughout; not the content -- the same report went
// through later; and not Anthropic's own 403, whose documented type is
// permission_error, where this said "forbidden" / "Request not allowed".
// Something in front of the API was turning the relay away for a while.
//
// Nothing was generated, so nothing was billed, so asking again is free. A
// person who would have seen a dead report now sees it arrive a few seconds
// later.
const RETRY_STATUSES = new Set([403, 500, 502, 503, 504, 529]);
// Anthropic refuses the odd request with a 403 that means nothing: eight
// identical streaming requests, seven through and one refused. A failed
// attempt produces no tokens, so retrying costs nothing but time, and a
// report that has to be started again costs real money. Five attempts
// over half a minute rather than three over six seconds.
const RETRY_DELAYS_MS = [1500, 4000, 10000, 20000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.has(origin);

    // Echo the caller's origin only when it is one of ours. "null" tells the
    // browser to block the response for everyone else.
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return fail("Method not allowed", 405, cors);
    if (!allowed) return fail("Origin not allowed", 403, cors);

    // ── Rate limiting ────────────────────────────────────────
    // The Origin check above only stops a BROWSER on another site. Anything
    // that can set a header, curl included, walks straight past it, and every
    // request that reaches Anthropic costs real money. These caps are what
    // actually bound the damage.
    //
    // The app already refuses to run two reports at once, so a real user
    // cannot exceed roughly one request a minute. Three is generous.
    //
    // Both limiters are optional at runtime: if the binding has not been added
    // in the dashboard yet, the Worker carries on rather than failing shut.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.RATE_LIMIT_IP) {
      const { success } = await env.RATE_LIMIT_IP.limit({ key: ip });
      if (!success) return fail("Too many requests. Wait a minute and try again.", 429, cors, 60);
    }
    // A second, coarser cap. One address at a time is not the only way to run
    // up a bill, and this bounds the whole Worker rather than one caller.
    if (env.RATE_LIMIT_GLOBAL) {
      const { success } = await env.RATE_LIMIT_GLOBAL.limit({ key: "all" });
      if (!success) return fail("The report service is busy. Try again shortly.", 429, cors, 60);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail("Request too large", 413, cors);

    let req;
    try { req = JSON.parse(raw); } catch (_) { return fail("Invalid JSON", 400, cors); }

    // Which upstream, decided by the path rather than by a field in the body,
    // so the two request shapes never have to be told apart by guesswork.
    if (new URL(request.url).pathname === "/translate") {
      return translate(req, env, cors);
    }

    if (!ALLOWED_MODELS.has(req.model)) return fail("Model not allowed", 400, cors);

    // Rebuild the upstream body from known fields only. Whatever the caller
    // sends, nothing unexpected reaches Anthropic, and max_tokens is capped so
    // this cannot be used to generate an unbounded (and unbounded-cost) reply.
    const body = JSON.stringify({
      model: req.model,
      max_tokens: Math.min(Number(req.max_tokens) || 4096, MAX_TOKENS_CAP),
      stream: req.stream === true,
      ...(typeof req.system === "string" ? { system: req.system } : {}),
      messages: Array.isArray(req.messages) ? req.messages : [],
    });

    const hasKey = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;

    let resp, upstream = "", attempts = 0;
    for (let attempt = 0; ; attempt++) {
      attempts = attempt + 1;
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body,
      });

      if (resp.ok) break;

      // Read it before deciding: the body is the only thing that says who
      // refused, and a failed response is small.
      upstream = await resp.text();

      const canRetry = RETRY_STATUSES.has(resp.status) && attempt < RETRY_DELAYS_MS.length;
      console.log("UPSTREAM FAIL", resp.status, "attempt=" + attempts,
        "keyPresent=" + hasKey, "willRetry=" + canRetry, upstream.slice(0, 600));
      if (!canRetry) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }

    // An upstream refusal is read and reported rather than passed through
    // blind. Passed through, a 403 from Anthropic reaches the browser looking
    // exactly like a 403 from this relay, and the two need different fixes.
    if (!resp.ok) {
      return fail(
        `Anthropic refused this (HTTP ${resp.status}, key ${hasKey ? "present" : "MISSING"}, `
        + `${attempts} attempt${attempts === 1 ? "" : "s"}): ${upstream.slice(0, 300)}`,
        resp.status, cors, undefined, resp.status);
    }

    // Pass the body straight through instead of awaiting resp.text(). Each
    // event is forwarded the moment it arrives, so the connection is never
    // idle and Cloudflare cannot time it out at 100s (the old HTTP 524).
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        ...cors,
        "Content-Type": resp.headers.get("content-type") || "application/json",
        "Cache-Control": "no-cache",
      },
    });
  }
};

/**
 * Report text to Chinese, through OpenAI's Responses API.
 *
 * No cap on the output. A translation is bounded by what it is translating,
 * so it cannot run away the way an open-ended report can, and the body limit
 * above already bounds the input. A cap would need a parameter name I could
 * not confirm in OpenAI's reference, and a wrong one is a 400 on every call.
 *
 * Reasoning effort is low on purpose: this is a language job, not a thinking
 * one, and the reports are long enough that the difference is real money.
 */
async function translate(req, env, cors) {
  const model = ALLOWED_OPENAI_MODELS.has(req.model) ? req.model : "gpt-6.1-sol";
  const instructions = typeof req.instructions === "string" ? req.instructions : "";
  const input = typeof req.input === "string" ? req.input : "";
  if (!input) return fail("Nothing to translate", 400, cors);

  const hasKey = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0;
  if (!hasKey) return fail("The translator is not set up: OPENAI_API_KEY is missing.", 500, cors);

  const body = JSON.stringify({
    model,
    instructions,
    input: [{ role: "user", content: input }],
    reasoning: { effort: "low" },
  });

  let resp, upstream = "", attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1;
    resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (resp.ok) break;
    upstream = await resp.text();
    const canRetry = RETRY_STATUSES.has(resp.status) && attempt < RETRY_DELAYS_MS.length;
    console.log("OPENAI FAIL", resp.status, "attempt=" + attempts,
      "willRetry=" + canRetry, upstream.slice(0, 600));
    if (!canRetry) break;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }

  if (!resp.ok) {
    return fail(
      `OpenAI refused this (HTTP ${resp.status}, ${attempts} attempt${attempts === 1 ? "" : "s"}): `
      + upstream.slice(0, 300), resp.status, cors, undefined, resp.status);
  }

  // The reply carries reasoning items as well as the message, so the text is
  // gathered by type rather than taken from output[0], which OpenAI's own
  // guide warns against.
  let data;
  try { data = await resp.json(); } catch (_) { return fail("OpenAI sent something unreadable", 502, cors); }
  const text = (data.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => (item.content || []).filter(c => c.type === "output_text").map(c => c.text || ""))
    .join("");

  if (!text) return fail("OpenAI returned no text", 502, cors);
  return new Response(JSON.stringify({ text }), {
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-cache" },
  });
}

/**
 * An error the browser can act on.
 *
 * `upstream` says the refusal came from the service behind this relay,
 * not from the relay or from Cloudflare in front of it. Without it the
 * app read a relayed 403 as "blocked before it reached us" and told Lewis
 * to try another network, while the body said Anthropic had answered.
 */
function fail(message, status, cors, retryAfter, upstream) {
  return new Response(JSON.stringify({ error: { message, ...(upstream ? { upstream } : {}) } }), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
    },
  });
}
