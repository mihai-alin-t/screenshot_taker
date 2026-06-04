# URL Research Agent

A personal learning project that connects WhatsApp to an AI agent capable of researching any URL you send it. Send a link from your phone, get back a useful digest — crawled text, a screenshot, or both — analyzed by Claude.

Built to learn: **MCP servers**, **Claude API agent loops**, **WhatsApp automation**, and **Playwright headless browsing**.

---

## Architecture

```
User (WhatsApp)
      │ message
      ▼
whatsapp-bot.ts          mcp-server.ts  ◄── Claude Desktop (optional)
      │                       │
      │ runAgent()            │ MCP protocol (stdio)
      ▼                       │
  agent.ts ◄──────────────────┘ (shares same tool functions)
      │
      │ Claude API tool use loop
      ▼
Anthropic API (claude-sonnet-4-6)
      │ tool_use / tool_result
      ▼
  screenshot.ts  │  crawl.ts     ◄── Tools Layer
                 │
              browser.ts  (Chromium singleton + Stealth)
                 │
          Target Website (HTTP)
```

---

## Components

### `src/whatsapp-bot.ts` — The Interface

Connects to WhatsApp using your personal account via QR code scan (no official API needed). Listens for incoming messages, passes them to the agent, and sends back the result as text or an image with a caption.

Uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) — an unofficial library that automates WhatsApp Web in a headless Chromium browser.

**Run:** `npm run bot`

---

### `src/agent.ts` — The Brain

Implements a Claude API **agent loop**: a multi-turn conversation where Claude can call tools before giving a final answer.

1. Receives your WhatsApp message
2. Sends it to `claude-sonnet-4-6` with two tool definitions
3. Claude decides whether to crawl, screenshot, or both
4. The tool result (text or image) is sent back to Claude as a `tool_result` message
5. Claude writes the final reply
6. The loop repeats until `stop_reason === "end_turn"`

The **system prompt** tells Claude it is a WhatsApp research assistant, when to prefer crawling vs screenshotting, and how to format replies for WhatsApp (short paragraphs, `*bold*`, no headers).

---

### `src/mcp-server.ts` — The MCP Server

Exposes the same two tools (`screenshot_url`, `crawl_url`) as a standalone **MCP (Model Context Protocol) server** over stdio transport.

**MCP** is Anthropic's open protocol for giving AI assistants access to external tools and data sources. Any MCP-compatible client (Claude Desktop, MCP Inspector, Cursor, etc.) can connect to this server and call the tools directly — independent of the WhatsApp bot.

**Run:** `npm run mcp`

**Register in Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "url-research": {
      "command": "npx",
      "args": ["tsx", "d:/projects/screenshot_taker/src/mcp-server.ts"]
    }
  }
}
```

> The WhatsApp bot does **not** go through the MCP server. Both entry points call the same tool functions directly. The MCP server is a standalone learning artifact.

---

### `src/tools/screenshot.ts` — Screenshot Tool

Takes a Playwright screenshot of a URL and returns it as a base64-encoded PNG (or JPEG if the PNG exceeds WhatsApp's 16MB media limit).

- Loads the page with `waitUntil: "load"`, then waits up to 1.5s for `networkidle` to reduce flicker on JS-heavy SPAs
- Supports `fullPage` mode (defaults to viewport only)
- Stealth plugin reduces bot detection

---

### `src/tools/crawl.ts` — Crawl Tool

Renders a URL in a full browser (so JS executes) and extracts readable text.

- Uses [Mozilla Readability](https://github.com/mozilla/readability) to extract article-style content (title + clean body text)
- Falls back to `document.body.innerText` for non-article pages
- Output capped at 20,000 characters to stay within Claude's context

---

### `src/browser.ts` — Browser Singleton

Manages a single shared Chromium instance across all tool calls using [playwright-extra](https://github.com/berstend/puppeteer-extra/tree/master/packages/playwright-extra) with the [stealth plugin](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth).

- Created once on startup, reused for all requests (avoids 2-3s launch cost per call)
- Creates a fresh isolated `BrowserContext` per request
- Automatically relaunches if Chromium crashes

---

## Setup

### Prerequisites

- Node.js 20+
- An Anthropic API key

### Install

```bash
npm install
npx playwright install chromium
```

### Configure

```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### Run the WhatsApp bot

```bash
npm run bot
```

Scan the QR code with WhatsApp → **Settings → Linked Devices → Link a Device**.

Once connected, send any URL (optionally with a question) to yourself and the bot will reply with a research digest.

### Run the MCP server (standalone)

```bash
npm run mcp
```

Connect using [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
```bash
npx @modelcontextprotocol/inspector npm run mcp
```

---

## Example Usage

**Via WhatsApp:**
```
You:  https://openai.com/pricing
Bot:  Researching... please wait.
Bot:  OpenAI offers several pricing tiers...
      *GPT-4o* starts at $2.50 per 1M input tokens...
```

```
You:  Screenshot https://github.com/trending
Bot:  [image of GitHub trending page]
      The trending page shows repositories in...
```

---

## What I Learned

| Technology | Concepts |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server setup, tool schemas (Zod), stdio transport, image content blocks |
| `@anthropic-ai/sdk` | Tool use agent loop, `tool_use` / `tool_result` message cycle, image in tool results |
| `whatsapp-web.js` | QR auth, `LocalAuth` session persistence, `MessageMedia` for images, `message_create` event |
| `playwright-extra` | Browser singleton, context isolation, stealth plugin, `waitUntil` strategies |

---

## TODO — What to Improve Next

- [ ] **Conversation memory (RAG-lite)** — Store past crawl results and let Claude reference them across messages. Even a simple `Map<url, summary>` in memory would introduce retrieval patterns.
- [ ] **Max-iterations guard on the agent loop** — Claude could theoretically call tools indefinitely. Cap iterations at ~5 and return a graceful message if exceeded.
- [ ] **Prompt caching** — The system prompt is re-sent on every request. Add `cache_control: { type: "ephemeral" }` to cut input token costs by ~90% at scale.
- [ ] **Streaming responses** — Use `client.messages.stream()` instead of `create()` and forward chunks back to WhatsApp progressively. Standard in production and teaches a different async pattern.
- [ ] **Evals** — Write 10 test cases with expected tool choices (e.g. "given this URL, Claude should call `crawl_url` not `screenshot_url`"). The most underrated skill in GenAI engineering.

---

## Stack

| Layer | Package |
|---|---|
| AI Agent | `@anthropic-ai/sdk` — claude-sonnet-4-6 |
| MCP Server | `@modelcontextprotocol/sdk` |
| WhatsApp | `whatsapp-web.js` |
| Browser | `playwright-extra` + `puppeteer-extra-plugin-stealth` |
| Text extraction | `@mozilla/readability` + `jsdom` |
| Runtime | Node.js 20 + TypeScript (ESM) |
