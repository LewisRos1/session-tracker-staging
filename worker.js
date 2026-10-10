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
const RETRY_DELAYS_MS = [1500, 4000];

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
        resp.status, cors);
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

function fail(message, status, cors, retryAfter) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
    },
  });
}
