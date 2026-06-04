import "dotenv/config";
import qrcode from "qrcode-terminal";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg as any;
import { runAgent } from "./agent.js";
import { closeBrowser } from "./browser.js";

const ALLOWED_SENDER = process.env.ALLOWED_SENDER ?? "";

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
  puppeteer: { headless: true },
});

client.on("qr", (qr) => {
  console.log("\nScan this QR code with WhatsApp:\n");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("WhatsApp authenticated ✓");
});

client.on("auth_failure", (msg) => {
  console.error("WhatsApp auth failed:", msg);
  console.error("Delete .wwebjs_auth/ and restart to re-scan QR.");
});

client.on("loading_screen", (percent, message) => {
  console.log(`Loading WhatsApp Web: ${percent}% — ${message}`);
});

client.on("change_state", (state) => {
  console.log("WhatsApp state:", state);
  // Fallback: some versions never fire "ready" when restoring from LocalAuth
  if (state === "CONNECTED") {
    console.log("WhatsApp bot ready (via state change). Send a URL to get started.");
  }
});

client.on("ready", () => {
  console.log("WhatsApp bot ready. Send a URL to get started.");
});

client.on("disconnected", (reason) => {
  console.log("WhatsApp disconnected:", reason);
});

client.on("message_create", async (message) => {
  // Skip bot's own quoted replies to avoid infinite loops.
  // Plain fromMe messages (user self-messaging) are allowed through.
  if (message.fromMe && message.hasQuotedMsg) return;

  // Ignore status broadcasts and system messages
  if (message.from.endsWith("@broadcast") || message.from === "status@broadcast") return;

  // Optionally restrict to a specific sender
  if (ALLOWED_SENDER && message.from !== ALLOWED_SENDER) return;

  // Ignore group messages (personal tool)
  const chat = await message.getChat();
  if (chat.isGroup) return;

  console.log(`[${new Date().toISOString()}] Message from ${message.from}: ${message.body.slice(0, 80)}`);

  await message.reply("Researching... please wait.");

  const start = Date.now();

  try {
    const { text, imageBase64, imageMimeType } = await runAgent(message.body);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`[${new Date().toISOString()}] Reply ready in ${elapsed}s`);

    clearInterval(typingInterval);
    await chat.clearState();

    if (imageBase64 && imageMimeType) {
      const media = new MessageMedia(imageMimeType, imageBase64, "screenshot.png");
      await message.reply(media, undefined, { caption: text });
    } else {
      await message.reply(text);
    }
  } catch (err) {
    console.error("Agent error:", err);
    await message.reply(
      "Something went wrong while researching that URL. Please try again."
    );
  }
});

// Graceful shutdown
async function shutdown() {
  console.log("\nShutting down...");
  await closeBrowser();
  await client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.initialize();
