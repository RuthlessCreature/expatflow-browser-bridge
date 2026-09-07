import { env as globalEnv } from "cloudflare:workers";
import {
  connect,
  launch,
  type GetLiveViewResponse,
} from "@cloudflare/playwright";
import { createMcpAgent } from "@cloudflare/playwright-mcp";

declare global {
  interface Env {
    BROWSER: Fetcher;
    MCP_OBJECT: DurableObjectNamespace;
    BRIDGE_TOKEN?: string;
  }
}

const typedGlobalEnv = globalEnv as unknown as { BROWSER: Fetcher };
export const PlaywrightMCP = createMcpAgent(typedGlobalEnv.BROWSER);

const KEEP_ALIVE_MS = 600_000;
const LIVE_VIEW_EXPIRES_MS = 3_600_000;
const DEFAULT_URL = "https://www.facebook.com/";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.BRIDGE_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.BRIDGE_TOKEN}`;
}

function requireAuth(request: Request, env: Env): Response | null {
  if (!env.BRIDGE_TOKEN) {
    return json(
      {
        error: "BRIDGE_TOKEN is not configured",
        fix: "Run: npx wrangler secret put BRIDGE_TOKEN",
      },
      503,
    );
  }
  if (!isAuthorized(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

function normalizeTargetUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http:// and https:// URLs are allowed");
  }
  return url.toString();
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function getSessionPage(env: Env, sessionId: string) {
  const browser = await connect(env.BROWSER, sessionId);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, context, page };
}

async function createLiveView(page: Awaited<ReturnType<typeof getSessionPage>>["page"]): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  const result = (await cdp.send("Cloudflare.getLiveView", {
    mode: "tab",
    expiresInMs: LIVE_VIEW_EXPIRES_MS,
  })) as GetLiveViewResponse;
  return result.devtoolsFrontendUrl;
}

async function startLiveSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ url?: string }>(request);
  const targetUrl = normalizeTargetUrl(body.url);

  const browser = await launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    const liveViewUrl = await createLiveView(page);
    const sessionId = browser.sessionId();

    return json({
      ok: true,
      sessionId,
      liveViewUrl,
      url: page.url(),
      title: await page.title(),
      keepAliveMs: KEEP_ALIVE_MS,
      liveViewExpiresMs: LIVE_VIEW_EXPIRES_MS,
      next: "Open liveViewUrl, log in manually, then call /api/live/inspect with the same sessionId.",
    });
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function inspectLiveSession(request: Request, env: Env): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  if (!sessionId) return json({ error: "sessionId is required" }, 400);

  const { browser, context, page } = await getSessionPage(env, sessionId);
  try {
    const cookies = await context.cookies();
    const liveViewUrl = await createLiveView(page);
    return json({
      ok: true,
      sessionId,
      url: page.url(),
      title: await page.title(),
      readyState: await page.evaluate(() => document.readyState),
      cookieCount: cookies.length,
      cookieDomains: [...new Set(cookies.map((cookie) => cookie.domain))].sort(),
      liveViewUrl,
      liveViewExpiresMs: LIVE_VIEW_EXPIRES_MS,
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function gotoInSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ sessionId?: string; url?: string }>(request);
  const sessionId = body.sessionId?.trim();
  if (!sessionId) return json({ error: "sessionId is required" }, 400);
  const targetUrl = normalizeTargetUrl(body.url);

  const { browser, page } = await getSessionPage(env, sessionId);
  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    return json({
      ok: true,
      sessionId,
      url: page.url(),
      title: await page.title(),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function pingSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ sessionId?: string }>(request);
  const sessionId = body.sessionId?.trim();
  if (!sessionId) return json({ error: "sessionId is required" }, 400);

  const { browser, page } = await getSessionPage(env, sessionId);
  try {
    const state = await page.evaluate(() => ({
      readyState: document.readyState,
      href: location.href,
      ts: Date.now(),
    }));
    return json({ ok: true, sessionId, ...state });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const CONTROL_PANEL = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ExpatFlow Browser Bridge</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color-scheme: light dark; }
    body { max-width: 920px; margin: 40px auto; padding: 0 20px; line-height: 1.5; }
    h1 { margin-bottom: 4px; }
    .muted { opacity: .72; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin: 24px 0; }
    label { font-weight: 650; }
    input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #8886; }
    input { width: 100%; box-sizing: border-box; }
    button { cursor: pointer; font-weight: 650; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 14px; border-radius: 8px; background: #8881; min-height: 120px; }
    #live { display: none; margin: 14px 0; font-weight: 700; }
  </style>
</head>
<body>
  <h1>ExpatFlow Browser Bridge</h1>
  <div class="muted">Cloudflare Browser Run + Live View login experiment</div>

  <div class="grid">
    <div>
      <label for="token">Bridge token</label>
      <input id="token" type="password" autocomplete="off" placeholder="BRIDGE_TOKEN" />
    </div>
    <div>
      <label for="target">Target URL</label>
      <input id="target" value="https://www.facebook.com/" />
    </div>
  </div>

  <div class="actions">
    <button id="start">Start remote browser</button>
    <button id="inspect" disabled>Inspect same session</button>
    <button id="goto" disabled>Navigate same session</button>
    <button id="ping" disabled>Ping / keep alive</button>
  </div>

  <p><a id="live" target="_blank" rel="noopener noreferrer">Open Cloudflare Live View</a></p>
  <pre id="out">No active session.</pre>

  <script>
    const token = document.getElementById('token');
    const target = document.getElementById('target');
    const out = document.getElementById('out');
    const live = document.getElementById('live');
    const inspectBtn = document.getElementById('inspect');
    const gotoBtn = document.getElementById('goto');
    const pingBtn = document.getElementById('ping');
    let sessionId = '';

    function headers() {
      return {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + token.value
      };
    }

    async function showResponse(response) {
      const data = await response.json();
      out.textContent = JSON.stringify(data, null, 2);
      if (!response.ok) throw new Error(data.error || 'Request failed');
      if (data.sessionId) sessionId = data.sessionId;
      if (data.liveViewUrl) {
        live.href = data.liveViewUrl;
        live.style.display = 'inline-block';
      }
      inspectBtn.disabled = !sessionId;
      gotoBtn.disabled = !sessionId;
      pingBtn.disabled = !sessionId;
      return data;
    }

    document.getElementById('start').onclick = async () => {
      try {
        const response = await fetch('/api/live/start', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ url: target.value })
        });
        await showResponse(response);
      } catch (error) {
        out.textContent += '\n\nERROR: ' + error.message;
      }
    };

    inspectBtn.onclick = async () => {
      try {
        const response = await fetch('/api/live/inspect?sessionId=' + encodeURIComponent(sessionId), {
          headers: headers()
        });
        await showResponse(response);
      } catch (error) {
        out.textContent += '\n\nERROR: ' + error.message;
      }
    };

    gotoBtn.onclick = async () => {
      try {
        const response = await fetch('/api/live/goto', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ sessionId: sessionId, url: target.value })
        });
        await showResponse(response);
      } catch (error) {
        out.textContent += '\n\nERROR: ' + error.message;
      }
    };

    pingBtn.onclick = async () => {
      try {
        const response = await fetch('/api/live/ping', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ sessionId: sessionId })
        });
        await showResponse(response);
      } catch (error) {
        out.textContent += '\n\nERROR: ' + error.message;
      }
    };
  </script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/") {
      return new Response(CONTROL_PANEL, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (pathname === "/health") {
      return json({
        ok: true,
        service: "expatflow-browser-bridge",
        tokenConfigured: Boolean(env.BRIDGE_TOKEN),
      });
    }

    const authError = requireAuth(request, env);
    if (authError) return authError;

    try {
      if (pathname === "/api/live/start" && request.method === "POST") {
        return await startLiveSession(request, env);
      }
      if (pathname === "/api/live/inspect" && request.method === "GET") {
        return await inspectLiveSession(request, env);
      }
      if (pathname === "/api/live/goto" && request.method === "POST") {
        return await gotoInSession(request, env);
      }
      if (pathname === "/api/live/ping" && request.method === "POST") {
        return await pingSession(request, env);
      }
      if (pathname === "/sse" || pathname === "/sse/message") {
        return PlaywrightMCP.serveSSE("/sse").fetch(request, env, ctx);
      }
      if (pathname === "/mcp") {
        return PlaywrightMCP.serve("/mcp").fetch(request, env, ctx);
      }
      return json({ error: "Not Found" }, 404);
    } catch (error) {
      return json(
        {
          error: errorMessage(error),
          hint: "If this session was idle for too long, start a new Browser Run session.",
        },
        500,
      );
    }
  },
};
