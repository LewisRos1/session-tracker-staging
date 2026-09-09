// ============================================================
// CLOUDFLARE WORKER — Anthropic API relay
//
// Deployed by hand at dash.cloudflare.com -> Workers & Pages ->
// session-tracker-ai -> Edit code. This copy is here so the source can be
// reviewed and restored; editing this file does NOT deploy anything.
//
// The API key lives in the ANTHROPIC_API_KEY secret and never reaches the
// browser.
// ============================================================

// Both the live and staging sites are GitHub Pages projects under the same
// origin. Add a line here if the site ever moves to a custom domain, or it
// will start returning 403.
const ALLOWED_ORIGINS = new Set([
  "https://lewisros1.github.io",
]);

const ALLOWED_MODELS = new Set(["claude-sonnet-5"]);
const MAX_TOKENS_CAP = 32000;
const MAX_BODY_BYTES = 300000;   // a real half-year prompt is far below this

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

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body,
    });

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

function fail(message, status, cors, retryAfterSeconds) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
    },
  });
}
