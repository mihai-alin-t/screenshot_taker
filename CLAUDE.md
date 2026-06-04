# CLAUDE.md

Project context and conventions for Claude Code sessions.

## What This Project Is

A local WhatsApp bot that researches URLs using a Claude API agent loop and Playwright. Two entry points share the same tool functions:
- `npm run bot` — WhatsApp bot (main workflow)
- `npm run mcp` — Standalone MCP server (for Claude Desktop / MCP Inspector)

## Running the Project

```bash
npm run bot          # Start WhatsApp bot
npm run mcp          # Start MCP server (stdio)
npm run test:screenshot https://example.com   # Test screenshot tool
npm run test:crawl https://example.com        # Test crawl tool
```

No build step — `tsx` runs TypeScript directly.

## Environment Variables

Required in `.env` (see `.env.example`):
- `ANTHROPIC_API_KEY` — Anthropic API key
- `ALLOWED_SENDER` — Optional. Restrict bot to a specific WhatsApp number (format: `"1234567890@c.us"`)

## Stack Conventions

- **ESM modules** — `"type": "module"` in `package.json`. All imports use `.js` extensions even for `.ts` files (Node ESM requirement).
- **No build step** — use `tsx` to run TypeScript directly in dev. Do not add a compile step.
- **TypeScript strict** — `strict: true` in `tsconfig.json`. No `any` unless wrapping a CJS package import.
- **CJS package imports** — `whatsapp-web.js` is CommonJS. Import as `import pkg from "whatsapp-web.js"; const { Client, ... } = pkg as any;`

## Architecture

```
whatsapp-bot.ts  →  agent.ts  →  Anthropic API
                              →  tools/screenshot.ts  →  browser.ts
                              →  tools/crawl.ts       →  browser.ts

mcp-server.ts  →  tools/screenshot.ts  →  browser.ts
               →  tools/crawl.ts       →  browser.ts
```

`agent.ts` and `mcp-server.ts` are independent entry points that both import the same tool functions. The bot does NOT call the MCP server.

## Known Gotchas

### WhatsApp session gets stuck on `authenticated` and never reaches `ready`
The `.wwebjs_auth` session folder is corrupted — usually happens after an unclean shutdown. Fix:
1. Stop the bot
2. Delete `.wwebjs_auth` and `.wwebjs_cache` folders
3. Restart — a fresh QR code will appear

The bot has a 30s auto-detect timer: if `ready` doesn't fire within 30s of `authenticated`, it exits with a message telling you to do this.

### Use `message_create` not `message` for WhatsApp events
The `message` event only fires for messages received *from others*. Self-messages (user messaging their own number) only fire `message_create`. The bot uses `message_create`.

### `status@broadcast` messages cause crashes if not filtered
WhatsApp status updates come through as `message_create` events from `status@broadcast`. Always filter these out before processing.

### `networkidle` times out on polling-heavy sites (Twitter/X, dashboards)
The page load strategy is: `waitUntil: "load"` (fast), then `waitForLoadState("networkidle", { timeout: 1500 })` with a silent catch. Never use `networkidle` as the primary `waitUntil` — it can hang for 30s on SPAs.

### playwright-extra needs `playwright` as a direct dependency
`playwright-extra` lists `playwright` as a peer dependency but does not install it automatically. Both must be in `dependencies`.

### MCP SDK requires ESM and `.js` import extensions
`@modelcontextprotocol/sdk` is ESM-only. Import paths must use `.js` even for TypeScript source files:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
```

## File Structure

```
src/
├── browser.ts          — Chromium singleton (playwright-extra + stealth)
├── agent.ts            — Claude API tool use loop
├── mcp-server.ts       — MCP server entry point (stdio)
├── whatsapp-bot.ts     — WhatsApp bot entry point
└── tools/
    ├── screenshot.ts   — captureScreenshot(url, fullPage?) → base64
    └── crawl.ts        — crawlUrl(url) → markdown text
```

## Key Implementation Details

- **Browser singleton**: one Chromium process shared across all requests; fresh `BrowserContext` per request. Pre-warmed on WhatsApp `ready` event.
- **Screenshot size**: defaults to viewport (not full-page). Falls back to JPEG at 75% quality if PNG exceeds 10MB (WhatsApp's 16MB media limit).
- **Crawl text cap**: 20,000 characters max to stay within Claude's context window.
- **Agent model**: `claude-sonnet-4-6`
- **WhatsApp auth**: `LocalAuth` persists session to `.wwebjs_auth/`. QR scan required only on first run or after session corruption.
