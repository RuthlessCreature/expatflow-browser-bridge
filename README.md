# ExpatFlow Browser Bridge

Cloudflare Browser Run + Playwright MCP experiment for remote browser control and human-in-the-loop login.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RuthlessCreature/ExpatFlow)

## Goal

This repository validates one concrete workflow first:

1. Start a Cloudflare Browser Run session.
2. Navigate the remote browser to a login page.
3. Generate a Cloudflare Live View URL.
4. Open the Live View URL locally and complete login / MFA manually.
5. Reconnect to the same Browser Run session by `sessionId`.
6. Continue browser automation through Playwright.
7. Expose the browser through MCP for later ChatGPT integration.

## Architecture

```text
ChatGPT / MCP client
        |
        v
Cloudflare Worker
  |             |
  |             +--> /mcp  (Playwright MCP)
  |
  +--> /api/live/start
  +--> /api/live/inspect
  +--> /api/live/goto
  +--> /api/live/ping
        |
        v
Cloudflare Browser Run
        |
        v
Live View <--> Human login
```

## Fastest test

### Option A — Deploy to Cloudflare button

Click the button above, authorize Cloudflare, and deploy the Worker. Cloudflare will provision the Worker-side resources described by `wrangler.jsonc`.

After deployment, configure one Worker secret:

```text
BRIDGE_TOKEN=<a long random value>
```

Then open the Worker root URL in your browser. The built-in control panel lets you:

- enter `BRIDGE_TOKEN`;
- choose the target URL (Facebook is prefilled);
- start a Browser Run session;
- open Cloudflare Live View;
- manually log in / complete MFA;
- reconnect to the same session and inspect or navigate it;
- ping the session to keep it active.

### Option B — Wrangler

Prerequisites:

- Cloudflare account with Browser Run enabled.
- Node.js 20+.
- Wrangler authenticated with your Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler secret put BRIDGE_TOKEN
npm run deploy
```

## API

All `/api/*`, `/mcp`, and `/sse` requests require:

```text
Authorization: Bearer <BRIDGE_TOKEN>
```

Start a remote login session:

```bash
curl -X POST "https://<worker>.workers.dev/api/live/start" \
  -H "authorization: Bearer <BRIDGE_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"url":"https://www.facebook.com/"}'
```

The response contains:

- `sessionId` — Browser Run session to reconnect to.
- `liveViewUrl` — open this URL in your normal browser and interact with the remote Cloudflare browser.
- `url` / `title` — current remote page state.

After manual login, inspect the same session:

```bash
curl "https://<worker>.workers.dev/api/live/inspect?sessionId=<SESSION_ID>" \
  -H "authorization: Bearer <BRIDGE_TOKEN>"
```

Navigate the same logged-in session:

```bash
curl -X POST "https://<worker>.workers.dev/api/live/goto" \
  -H "authorization: Bearer <BRIDGE_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"sessionId":"<SESSION_ID>","url":"https://www.facebook.com/"}'
```

Keep it active:

```bash
curl -X POST "https://<worker>.workers.dev/api/live/ping" \
  -H "authorization: Bearer <BRIDGE_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"sessionId":"<SESSION_ID>"}'
```

Browser Run's configured keep-alive here is 10 minutes of inactivity. The session can remain alive longer while commands or Live View interactions continue.

## MCP

The Worker also exposes:

- `/mcp` — Streamable HTTP MCP endpoint.
- `/sse` — compatibility endpoint.

This is backed by `@cloudflare/playwright-mcp` and Browser Run. It is intentionally protected by the same bearer token because publishing an unauthenticated browser-control MCP endpoint would be a serious security mistake.

## What this experiment proves

The first gate is not whether Playwright can click buttons. It can. The real gates are:

1. Can you reliably log in through Cloudflare Live View?
2. Does the target site accept the Cloudflare Browser Run network / browser environment?
3. Does the login remain valid while reconnecting to the same Browser Run session?
4. How often does the site demand MFA / CAPTCHA / device verification again?

If those gates pass, the next step is persistent auth-state handling and ChatGPT MCP integration. If they fail badly, the browser executor should move to a stable local/VPS Chrome profile instead of forcing Browser Run to do a job it is bad at.

## Security

Do not commit credentials, cookies, API tokens, or storage-state files to this repository. `BRIDGE_TOKEN` belongs in Cloudflare Worker secrets, not source control.
