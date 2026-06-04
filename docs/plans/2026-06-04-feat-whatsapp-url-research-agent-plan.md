---
title: "feat: Build WhatsApp URL Research Agent with MCP"
type: feat
status: completed
date: 2026-06-04
origin: docs/brainstorms/2026-06-04-url-research-agent-brainstorm.md
---

# feat: Build WhatsApp URL Research Agent with MCP

## Overview

A personal learning project that wires together four technologies: Playwright (headless browser), MCP SDK (tool protocol), Claude API (agent loop), and whatsapp-web.js (messaging interface). You send a URL to a WhatsApp number — optionally with a question — and the agent researches the page, decides whether to crawl it for text or screenshot it visually (or both), and returns a digest to your chat.

The goal is to learn, not to ship. Every phase teaches something distinct. The end result is also genuinely useful as a personal research tool.

## Problem Statement

You want a single WhatsApp message to trigger a full research cycle on a URL: render the page through a real browser (bypassing JS-only sites), extract content and/or capture a visual, send it through Claude for analysis, and return a useful answer — all without opening a browser manually or uploading screenshots.

Secondary goal: understand how MCP servers work, how Claude's tool use agent loop works, and how to connect heterogeneous systems end-to-end in TypeScript.

## Proposed Solution

Build a Node.js/TypeScript application with two entry points that share the same tool functions:

1. **`src/mcp-server.ts`** — Standalone MCP server exposing `screenshot_url` and `crawl_url` as tools. Can be registered with Claude Desktop independently for learning.
2. **`src/whatsapp-bot.ts`** — WhatsApp bot that runs a Claude agent loop inline. Incoming messages trigger the agent; tool calls dispatch directly to the same Playwright functions the MCP server uses.

This avoids MCP inter-process complexity (no client connecting to a separate server process) while still building a real MCP server as a learning artifact.

## Technical Approach

### Architecture

```
User (WhatsApp message)
  ↓
whatsapp-bot.ts
  ↓  message.body → agent(message)
agent.ts  (Claude API tool use loop)
  ↓  stop_reason === "tool_use"
tools/screenshot.ts | tools/crawl.ts  (Playwright)
  ↓  base64 PNG | markdown text
agent.ts  (tool result → Claude)
  ↓  stop_reason === "end_turn"
whatsapp-bot.ts  → reply text + optional MessageMedia
  ↓
User (WhatsApp reply)

Separately:
mcp-server.ts  (stdio, same tool functions)
  ↓  can connect to Claude Desktop or MCP Inspector
```

### File Structure

```
screenshot_taker/
├── src/
│   ├── tools/
│   │   ├── screenshot.ts       # captureScreenshot(url, fullPage?) → base64 PNG
│   │   └── crawl.ts            # crawlUrl(url) → cleaned markdown text
│   ├── browser.ts              # singleton Playwright browser + stealth setup
│   ├── agent.ts                # Claude API agent loop with tool dispatch
│   ├── mcp-server.ts           # MCP server entry point (stdio transport)
│   └── whatsapp-bot.ts         # WhatsApp bot entry point
├── .env                        # gitignored
├── .env.example
├── .gitignore
├── package.json                # ESM, type: "module"
├── tsconfig.json
└── docs/
    ├── brainstorms/
    └── plans/
```

### Key Implementation Details

**`browser.ts` — singleton browser**

Keep one Chromium instance alive across all requests. Create a fresh `BrowserContext` per request (cheap, isolated). Close context after each capture. This avoids the 2–3s browser startup cost on every message.

```ts
// browser.ts
import { chromium, Browser } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return _browser;
}
```

**`tools/screenshot.ts`**

```ts
export async function captureScreenshot(url: string, fullPage = false): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const buffer = await page.screenshot({ fullPage, type: "png", animations: "disabled" });
    const b64 = buffer.toString("base64");
    // WhatsApp 16MB media limit — fall back to JPEG if PNG is too large
    if (b64.length > 10_000_000) {
      const jpeg = await page.screenshot({ fullPage, type: "jpeg", quality: 75, animations: "disabled" });
      return jpeg.toString("base64");
    }
    return b64;
  } finally {
    await context.close();
  }
}
```

**`tools/crawl.ts`**

Use Mozilla's `@mozilla/readability` to extract article-style content, falling back to `document.body.innerText` for non-article pages.

```ts
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

export async function crawlUrl(url: string): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const html = await page.content();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article?.textContent) return article.textContent.trim().slice(0, 20_000);
    // Fallback: raw innerText
    return (await page.evaluate(() => document.body.innerText)).slice(0, 20_000);
  } finally {
    await context.close();
  }
}
```

Text is capped at 20,000 chars to stay within Claude's context comfortably.

**`agent.ts` — Claude tool use loop**

```ts
const TOOLS: Anthropic.Tool[] = [
  {
    name: "screenshot_url",
    description: "Takes a screenshot of a URL. Use when the user asks to see a page visually, or when visual layout matters.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to screenshot" },
        fullPage: { type: "boolean", description: "Capture full scrollable page (default: false)" },
      },
      required: ["url"],
    },
  },
  {
    name: "crawl_url",
    description: "Fetches and extracts the text content of a URL. Use when the user wants information, data, or a summary from a page.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to crawl" },
      },
      required: ["url"],
    },
  },
];

const SYSTEM_PROMPT = `You are a helpful research assistant operating via WhatsApp.
When a user sends a URL, research it using your available tools and return a useful digest.
- Use crawl_url for text/data extraction (articles, prices, contact info, documentation)
- Use screenshot_url when the user explicitly wants to see a page or when visual context matters
- Use both when a full picture is needed
Format responses for WhatsApp: short paragraphs, *bold* for key points, no markdown headers. Be concise.
If a site blocks access or times out, say so clearly.`;
```

**`mcp-server.ts` — MCP server**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "url-research-agent", version: "1.0.0" });

server.tool("screenshot_url",
  { url: z.string().url(), fullPage: z.boolean().optional() },
  async ({ url, fullPage }) => ({
    content: [{ type: "image", data: await captureScreenshot(url, fullPage), mimeType: "image/png" }],
  })
);

server.tool("crawl_url",
  { url: z.string().url() },
  async ({ url }) => ({
    content: [{ type: "text", text: await crawlUrl(url) }],
  })
);

await server.connect(new StdioServerTransport());
```

**`whatsapp-bot.ts` — WhatsApp entry point**

```ts
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
  webVersionCache: { type: "remote", remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.x.json" },
  puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

client.on("message", async (message) => {
  if (message.fromMe) return; // ignore own messages
  const chat = await message.getChat();
  await chat.sendStateTyping();

  try {
    const { text, imageBase64 } = await runAgent(message.body);
    if (imageBase64) {
      const media = new MessageMedia("image/png", imageBase64, "screenshot.png");
      await message.reply(media, undefined, { caption: text });
    } else {
      await message.reply(text);
    }
  } catch (err) {
    await message.reply("Something went wrong. Please try again.");
  }
});
```

### `.env.example`

```env
ANTHROPIC_API_KEY=sk-ant-...
# Optional: restrict bot to your own number only (e.g. "1234567890@c.us")
ALLOWED_SENDER=
```

## System-Wide Impact

### Interaction Graph

WhatsApp message event → `message` handler → `runAgent()` → Anthropic `messages.create()` → tool use block → `captureScreenshot()` or `crawlUrl()` → `getBrowser()` (singleton) → Playwright context → page navigation → screenshot/extract → base64 result → `tool_result` message → second `messages.create()` → text response → `message.reply()` with optional `MessageMedia`.

### Error Propagation

Playwright navigation errors (`TimeoutError`, `net::ERR_NAME_NOT_RESOLVED`) are caught in tool functions and returned as `{ type: "text", text: "Error: ..." }` tool results — Claude receives the error as context and can explain it to the user naturally. WhatsApp send failures bubble up to the top-level try/catch and trigger a generic error reply.

### State Lifecycle Risks

- **Browser singleton**: If Chromium crashes, `getBrowser()` detects `!browser.isConnected()` and relaunches. Contexts are closed in `finally` blocks — no context leaks.
- **WhatsApp session**: `LocalAuth` persists to `.wwebjs_auth/`. If session expires, `auth_failure` event fires and logs; QR re-scan required.
- **Concurrent messages**: No request queue — if two WhatsApp messages arrive simultaneously, two Playwright contexts run in parallel. Chromium handles this fine; Claude API handles concurrent calls. No shared mutable state between requests.

### API Surface Parity

The MCP server and WhatsApp bot both call the same `captureScreenshot()` and `crawlUrl()` functions from `src/tools/`. If a tool is updated, both entry points benefit automatically.

### Integration Test Scenarios

1. Send a Wikipedia article URL → expect crawl_url called, text summary returned
2. Send "Screenshot https://example.com" → expect screenshot_url called, image + caption returned
3. Send a Cloudflare-protected URL → expect screenshot of challenge page + error message from Claude
4. Send an invalid URL (no protocol) → expect Claude to respond asking for a valid URL
5. Send a JS-heavy SPA URL (e.g. a React app) → expect networkidle wait to let JS render, then crawl succeeds

## Implementation Phases

### Phase 1: Project Foundation

**Goal:** Working TypeScript ESM project with all dependencies installed.

Tasks:
- [x] Create `package.json` with `"type": "module"`, all dependencies listed below
- [x] Create `tsconfig.json` for ESM + Node 20 target
- [x] Create `.env.example` and `.gitignore`
- [x] Run `npm install`
- [x] Run `npx playwright install chromium`

Dependencies:
```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "@modelcontextprotocol/sdk": "latest",
    "@mozilla/readability": "latest",
    "jsdom": "latest",
    "playwright-extra": "latest",
    "puppeteer-extra-plugin-stealth": "latest",
    "whatsapp-web.js": "latest",
    "qrcode-terminal": "latest",
    "dotenv": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "typescript": "latest",
    "@types/node": "latest",
    "@types/jsdom": "latest",
    "tsx": "latest"
  },
  "scripts": {
    "mcp": "tsx src/mcp-server.ts",
    "bot": "tsx src/whatsapp-bot.ts",
    "test:screenshot": "tsx src/tools/screenshot.ts",
    "test:crawl": "tsx src/tools/crawl.ts"
  }
}
```

Success criteria: `npm run test:screenshot https://example.com` outputs a base64 PNG to stdout.

### Phase 2: Screenshot Engine

**Goal:** `captureScreenshot()` and `crawlUrl()` work reliably on real URLs.

Files to create:
- [x] `src/browser.ts` — singleton browser with stealth plugin
- [x] `src/tools/screenshot.ts` — `captureScreenshot(url, fullPage?)` → base64
- [x] `src/tools/crawl.ts` — `crawlUrl(url)` → markdown text (Readability + fallback)

Test manually:
- [ ] Screenshot a static site (e.g. `https://example.com`)
- [ ] Screenshot a JS-heavy SPA (e.g. a React app)
- [ ] Crawl an article URL — verify readable text extracted
- [ ] Crawl a product page — verify price/title visible in output

Success criteria: Both tools return usable content on at least 4/5 test URLs.

### Phase 3: MCP Server

**Goal:** Standalone MCP server that can be registered with Claude Desktop.

Files to create:
- [x] `src/mcp-server.ts` — `McpServer` with `screenshot_url` and `crawl_url` tools, stdio transport

Test with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector npm run mcp
```

Optional: Register in Claude Desktop config:
```json
{
  "mcpServers": {
    "url-research": {
      "command": "tsx",
      "args": ["d:/projects/screenshot_taker/src/mcp-server.ts"]
    }
  }
}
```

Success criteria: MCP Inspector shows both tools; calling `screenshot_url` returns an image.

### Phase 4: Claude Agent Loop

**Goal:** A function `runAgent(message: string)` that accepts a natural language message, calls the right tools, and returns `{ text: string, imageBase64?: string }`.

Files to create:
- [x] `src/agent.ts` — tool definitions, system prompt, multi-turn loop, tool dispatch

Test from CLI:
```bash
npx tsx -e "import { runAgent } from './src/agent.ts'; console.log(await runAgent('What is on https://example.com?'))"
```

Test cases:
- [ ] URL + question → text response with crawl
- [ ] "Screenshot https://example.com" → imageBase64 + caption
- [ ] Dead URL → graceful error text
- [ ] Non-URL message → conversational response

Success criteria: Agent correctly routes to crawl vs screenshot on at least 4/5 test prompts.

### Phase 5: WhatsApp Integration

**Goal:** Bot running locally, responding to your WhatsApp messages.

Files to create:
- [x] `src/whatsapp-bot.ts` — Client init, QR flow, message handler, reply with text and/or image

Steps:
- [ ] Run `npm run bot`
- [ ] Scan QR code with WhatsApp on a phone (dedicated number recommended)
- [ ] Send a URL from another device
- [ ] Verify reply arrives with correct content

Edge cases to test:
- [ ] URL with no question → summary reply
- [ ] "Screenshot https://..." → image reply with caption
- [ ] Cloudflare-protected URL → error message
- [ ] Non-URL text → conversational response from Claude

Success criteria: End-to-end flow works on 5 consecutive test messages without crashes.

### Phase 6: Polish

- [ ] Add `ALLOWED_SENDER` env check (only respond to specific number)
- [ ] Add `chat.sendStateTyping()` while processing
- [ ] Add graceful shutdown: close browser + WhatsApp client on `SIGINT`
- [ ] Add `console.log` structured logging (timestamp, event, URL, duration)
- [ ] Write a `README.md` with setup instructions and QR scan flow

## Alternative Approaches Considered

| Approach | Why Rejected |
|---|---|
| Ollama (local LLM) | Quality noticeably below Claude for analysis tasks. Claude API cost is negligible for personal use. (see brainstorm) |
| Twilio WhatsApp API | Costs money per message. `whatsapp-web.js` is free for personal use. (see brainstorm) |
| Separate MCP client process | Adds inter-process complexity (stdio pipes, process management) without learning benefit. Inline dispatch is simpler and teaches the same MCP concepts. |
| Full-page screenshots by default | Can produce 10MB+ images that hit WhatsApp's 16MB limit. Viewport-only default is safer; `fullPage` available as opt-in. |
| `puppeteer` instead of `playwright` | Playwright has better auto-wait, is more actively maintained, and `playwright-extra` supports the stealth plugin. |

## Acceptance Criteria

### Functional

- [ ] Sending a URL to WhatsApp returns a text summary within 30 seconds
- [ ] "Screenshot [url]" returns an image with a caption
- [ ] JS-heavy SPAs render correctly (not blank/partial)
- [ ] Session persists across bot restarts (no QR re-scan)
- [ ] Sites blocked by anti-bot return an informative error message, not a crash
- [ ] Media over WhatsApp size limit falls back gracefully (JPEG compression)

### Non-Functional

- [ ] Bot stays running for 24h without memory leak
- [ ] No credentials committed to git (`.env` in `.gitignore`)
- [ ] Browser relaunches automatically if Chromium crashes

### Learning Objectives Verified

- [ ] Can explain how MCP tool definitions map to handler functions
- [ ] Can explain the Claude API `tool_use` → `tool_result` message cycle
- [ ] Can explain `LocalAuth` and WhatsApp session persistence
- [ ] Can explain Playwright browser vs context vs page lifecycle

## Dependencies & Prerequisites

- Node.js 20+
- A WhatsApp account (dedicated number strongly recommended — unofficial library, ban risk)
- Anthropic API key (`ANTHROPIC_API_KEY`)
- Chromium will be downloaded by `npx playwright install chromium` (~130MB)

## Risk Analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| WhatsApp bans the account | Medium | Use a dedicated/burner number, not your primary account |
| `whatsapp-web.js` breaks on WA Web version update | High (historical) | Pin `webVersionCache` to a known-good version; monitor the project's GitHub issues |
| `playwright-extra` lags behind Playwright version | Medium | Pin both to compatible versions; fallback to manual `addInitScript` stealth if needed |
| Claude API costs spiral | Low (personal use) | `claude-haiku-4-5` for crawl-only requests, `claude-sonnet-4-6` for analysis |
| `networkidle` timeout on polling sites | Medium | Fall back to `"load"` + 1500ms wait if `networkidle` times out after 15s |

## Future Extensions (Post-MVP)

These are out of scope for now but natural next steps:

- **Telegram or Slack** as alternative interfaces (same agent core, different adapter)
- **Scheduled captures**: "Every Monday screenshot this page"
- **Vision analysis**: "Is this landing page well-designed?" after screenshot
- **PDF export**: Playwright's `page.pdf()` for print-friendly captures
- **Expose as public API**: Add HTTP transport to MCP server, rate limiting, API keys

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-06-04-url-research-agent-brainstorm.md](docs/brainstorms/2026-06-04-url-research-agent-brainstorm.md)
  Key decisions carried forward: local-first stack, Claude API for quality, `whatsapp-web.js` unofficial approach, two complementary tools (crawl + screenshot), agent picks tool autonomously.

### External References

- [MCP SDK — McpServer API](https://github.com/modelcontextprotocol/typescript-sdk)
- [whatsapp-web.js documentation](https://docs.wwebjs.dev/)
- [Anthropic SDK — Tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)
- [playwright-extra + stealth](https://github.com/berstend/puppeteer-extra/tree/master/packages/playwright-extra)
- [Mozilla Readability](https://github.com/mozilla/readability)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
