import Anthropic from "@anthropic-ai/sdk";
import { captureScreenshot } from "./tools/screenshot.js";
import { crawlUrl } from "./tools/crawl.js";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a helpful research assistant operating via WhatsApp.

When a user sends you a URL, research it using your available tools and return a useful digest:
- Use crawl_url for text/data extraction (articles, prices, contact info, documentation, product details)
- Use screenshot_url when the user explicitly asks to see a page, or when visual context clearly matters
- Use both when a full picture is needed (e.g. "what does this page look like and what does it say?")

After gathering information, provide a concise, useful summary. Format responses for WhatsApp:
- Use *bold* for emphasis (WhatsApp markdown)
- Keep paragraphs short — 2-3 sentences max
- No markdown headers (# or ##) — they don't render in WhatsApp
- Be direct and useful, not verbose

If a site blocks access, shows a Cloudflare challenge, or times out, describe what happened clearly.
If the message is conversational (no URL), respond naturally.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "screenshot_url",
    description:
      "Takes a screenshot of a URL and returns it as an image. Use when the user wants to see a page visually, or when visual layout matters.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to screenshot" },
        fullPage: {
          type: "boolean",
          description: "Capture full scrollable page (default: false = viewport only)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "crawl_url",
    description:
      "Fetches and extracts the text content of a URL. Use when the user wants information, data, prices, or a summary from a page.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to crawl and extract text from" },
      },
      required: ["url"],
    },
  },
];

export interface AgentResult {
  text: string;
  imageBase64?: string;
  imageMimeType?: "image/png" | "image/jpeg";
}

async function dispatchTool(
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>
): Promise<{ result: Anthropic.ToolResultBlockParam; imageBase64?: string; imageMimeType?: "image/png" | "image/jpeg" }> {
  if (toolName === "screenshot_url") {
    const url = input.url as string;
    const fullPage = (input.fullPage as boolean | undefined) ?? false;

    const { data, mimeType } = await captureScreenshot(url, fullPage);

    return {
      imageBase64: data,
      imageMimeType: mimeType,
      result: {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data },
          },
          {
            type: "text",
            text: `Screenshot of ${url} captured successfully.`,
          },
        ],
      },
    };
  }

  if (toolName === "crawl_url") {
    const url = input.url as string;
    const text = await crawlUrl(url);

    return {
      result: {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: [{ type: "text", text }],
      },
    };
  }

  return {
    result: {
      type: "tool_result",
      tool_use_id: toolUseId,
      is_error: true,
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
    },
  };
}

export async function runAgent(userMessage: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let capturedImage: { base64: string; mimeType: "image/png" | "image/jpeg" } | undefined;

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      const text = textBlock?.type === "text" ? textBlock.text : "Done.";
      return {
        text,
        imageBase64: capturedImage?.base64,
        imageMimeType: capturedImage?.mimeType,
      };
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const { result, imageBase64, imageMimeType } = await dispatchTool(
          block.name,
          block.id,
          block.input as Record<string, unknown>
        );

        toolResults.push(result);

        // Keep the last screenshot for sending back via WhatsApp
        if (imageBase64 && imageMimeType) {
          capturedImage = { base64: imageBase64, mimeType: imageMimeType };
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop reason
    break;
  }

  return { text: "I encountered an unexpected issue. Please try again." };
}
