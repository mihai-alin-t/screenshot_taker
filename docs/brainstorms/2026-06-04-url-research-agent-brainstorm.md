---
date: 2026-06-04
topic: url-research-agent
---

# URL Research Agent

## What We're Building

A personal learning project — a WhatsApp-connected AI agent that researches any URL you send it. You message the agent a URL (optionally with a question), and it crawls the page, screenshots it if needed, analyzes the content with Claude, and returns a useful digest back to your WhatsApp chat.

The goal is to learn about MCP server development, Claude API agent loops, WhatsApp integration, and Playwright — not to build a commercial product.

## Why This Approach

Considered building a SaaS screenshot API (competitor to ScreenshotOne/Urlbox) and a hosted MCP screenshot server, but both are crowded markets. A personal learning project removes the "why would anyone pay for this?" pressure and lets the focus stay on the learning objectives. The WhatsApp interface makes it genuinely useful day-to-day — send a URL while on your phone and get back a summary without opening a browser.

Screenshots alone were deprioritized because you can paste an image into Claude.ai directly. The "research a URL" framing — crawl + screenshot + summarize + extract — is more valuable and more interesting to build.

## Key Decisions

- **Local-first**: Everything runs on your machine. No hosted services.
- **Claude API**: Used for the agent brain. Small cost accepted for personal use; quality matters more than zero cost here.
- **whatsapp-web.js**: Unofficial library connecting to your own WhatsApp account via QR code. Fine for personal use, no business account needed.
- **Two MCP tools**: `crawl_url` (fast, text) and `screenshot_url` (visual, Playwright). Claude decides which to use based on the request.
- **Playwright + stealth**: Handles JS-heavy SPAs and common anti-bot measures. No proxy rotation needed for personal use.

## Stack

| Layer | Tool |
|-------|------|
| Screenshot engine | Playwright + puppeteer-extra-plugin-stealth |
| Web crawling | Playwright or cheerio (text extraction) |
| MCP server | Node.js MCP SDK (`@modelcontextprotocol/sdk`) |
| AI agent | Claude API (claude-sonnet-4-6), tool use loop |
| WhatsApp | whatsapp-web.js (unofficial, QR-based) |
| Runtime | Node.js / TypeScript |

## Agent Flow

```
User sends WhatsApp message: "https://example.com — what's the main product?"
        ↓
whatsapp-web.js webhook receives message
        ↓
Claude agent receives message + available MCP tools
        ↓
Agent decides: crawl_url() or screenshot_url() (or both)
        ↓
MCP tool executes via Playwright
        ↓
Claude analyzes result and composes reply
        ↓
whatsapp-web.js sends text (+ image if screenshot) back to chat
```

## MCP Tools

- `screenshot_url(url, fullPage?)` → returns base64 image
- `crawl_url(url)` → returns cleaned markdown text of page content

## Open Questions

- Should the agent proactively choose crawl vs screenshot, or should the user be able to specify? (Start with agent deciding autonomously)
- Cookie banner dismissal — use a pre-built filter list or skip for MVP?
- Message format for WhatsApp reply — plain text summary, or structured with sections?

## Learning Objectives

- Build and register an MCP server with custom tools
- Use Claude API tool use (agent loop) in a real async context
- Handle WhatsApp webhooks and send media (images) back
- Wire Playwright into a server context (not just scripts)
- Connect heterogeneous systems end-to-end

## Next Steps

→ `/workflows:plan` for implementation details
