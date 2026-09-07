import puppeteer from "@cloudflare/puppeteer";
import legacyWorker from "./index";
export { PlaywrightMCP } from "./index";

declare global {
  interface Env {
    BROWSER: Fetcher;
    MCP_OBJECT: DurableObjectNamespace;
    BRIDGE_TOKEN?: string;
  }
}

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

function requireAuth(request: Request, env: Env): Response | null {
  if (!env.BRIDGE_TOKEN) {
    return json(
      {
        error: "BRIDGE_TOKEN is not configured",
        fix: "Set BRIDGE_TOKEN in Worker Settings > Variables and Secrets.",
      },
      503,
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${env.BRIDGE_TOKEN}`) {
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

async function getPage(browser: Awaited<ReturnType<typeof puppeteer.launch>>) {
  const pages = await browser.pages();
  return pages[0] ?? (await browser.newPage());
}

async function createLiveView(page: Awaited<ReturnType<typeof getPage>>): Promise<string> {
  const cdp = await page.createCDPSession();
  const result = (await cdp.send("Cloudflare.getLiveView" as never, {
    mode: "tab",
    expiresInMs: LIVE_VIEW_EXPIRES_MS,
  } as never)) as unknown as { devtoolsFrontendUrl: string };
  return result.devtoolsFrontendUrl;
}

async function startLiveSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ url?: string }>(request);
  const targetUrl = normalizeTargetUrl(body.url);

  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
  try {
    const page = await getPage(browser);
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    const liveViewUrl = await createLiveView(page);
    const sessionId = browser.sessionId();

    browser.disconnect();

    return json({
      ok: true,
      sessionId,
      liveViewUrl,
      url: page.url(),
      title: await page.title(),
      keepAliveMs: KEEP_ALIVE_MS,
      liveViewExpiresMs: LIVE_VIEW_EXPIRES_MS,
      sessionMode: "puppeteer-disconnect",
      next: "Open liveViewUrl. The remote Browser Run session remains alive after the Worker disconnects.",
    });
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function connectSession(env: Env, sessionId: string) {
  const browser = await puppeteer.connect(env.BROWSER, sessionId);
  const page = await getPage(browser);
  return { browser, page };
}

async function inspectLiveSession(request: Request, env: Env): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  if (!sessionId) return json({ error: "sessionId is required" }, 400);

  const { browser, page } = await connectSession(env, sessionId);
  try {
    const cookies = await page.cookies();
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
      sessionMode: "puppeteer-reconnect",
    });
  } finally {
    browser.disconnect();
  }
}

async function gotoInSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ sessionId?: string; url?: string }>(request);
  const sessionId = body.sessionId?.trim();
  if (!sessionId) return json({ error: "sessionId is required" }, 400);
  const targetUrl = normalizeTargetUrl(body.url);

  const { browser, page } = await connectSession(env, sessionId);
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
      sessionMode: "puppeteer-reconnect",
    });
  } finally {
    browser.disconnect();
  }
}

async function pingSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ sessionId?: string }>(request);
  const sessionId = body.sessionId?.trim();
  if (!sessionId) return json({ error: "sessionId is required" }, 400);

  const { browser, page } = await connectSession(env, sessionId);
  try {
    const readyState = await page.evaluate(() => document.readyState);
    const href = await page.evaluate(() => location.href);
    return json({
      ok: true,
      sessionId,
      readyState,
      href,
      ts: Date.now(),
      sessionMode: "puppeteer-reconnect",
    });
  } finally {
    browser.disconnect();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    const isLiveRoute = pathname.startsWith("/api/live/");
    if (!isLiveRoute) {
      return legacyWorker.fetch(request, env, ctx);
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
      return json({ error: "Not Found" }, 404);
    } catch (error) {
      return json(
        {
          error: errorMessage(error),
          hint: "If the browser was closed or idle beyond keep_alive, start a new session.",
        },
        500,
      );
    }
  },
};
