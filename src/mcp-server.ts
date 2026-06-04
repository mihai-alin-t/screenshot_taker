import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { captureScreenshot } from "./tools/screenshot.js";
import { crawlUrl } from "./tools/crawl.js";
import { closeBrowser } from "./browser.js";

const server = new McpServer({
  name: "url-research-agent",
  version: "1.0.0",
});

server.tool(
  "screenshot_url",
  "Takes a screenshot of a URL and returns it as an image. Use when the user wants to see a page visually or when visual layout matters.",
  {
    url: z.string().url().describe("The URL to screenshot"),
    fullPage: z
      .boolean()
      .optional()
      .default(false)
      .describe("Capture the full scrollable page (default: viewport only)"),
  },
  async ({ url, fullPage }) => {
    const { data, mimeType } = await captureScreenshot(url, fullPage);
    return {
      content: [{ type: "image", data, mimeType }],
    };
  }
);

server.tool(
  "crawl_url",
  "Fetches and extracts the text content of a URL. Use when the user wants information, data, or a summary from a page.",
  {
    url: z.string().url().describe("The URL to crawl and extract text from"),
  },
  async ({ url }) => {
    const text = await crawlUrl(url);
    return {
      content: [{ type: "text", text }],
    };
  }
);

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
