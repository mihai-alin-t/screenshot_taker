import { getBrowser } from "../browser.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// WhatsApp's 16MB media limit — fall back to compressed JPEG if PNG is too large
const MAX_BASE64_BYTES = 10_000_000;

export async function captureScreenshot(
  url: string,
  fullPage = false
): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: USER_AGENT,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    // Give JS-heavy SPAs a moment to render after load
    await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => {});

    const pngBuffer = await page.screenshot({
      fullPage,
      type: "png",
      animations: "disabled",
    });

    const pngBase64 = pngBuffer.toString("base64");

    if (pngBase64.length <= MAX_BASE64_BYTES) {
      return { data: pngBase64, mimeType: "image/png" };
    }

    // PNG too large — compress as JPEG
    const jpegBuffer = await page.screenshot({
      fullPage,
      type: "jpeg",
      quality: 75,
      animations: "disabled",
    });

    return { data: jpegBuffer.toString("base64"), mimeType: "image/jpeg" };
  } finally {
    await context.close();
  }
}

// Quick test when run directly
if (process.argv[1].endsWith("screenshot.ts")) {
  const url = process.argv[2] ?? "https://example.com";
  console.log(`Taking screenshot of ${url}...`);
  captureScreenshot(url)
    .then(({ data, mimeType }) => {
      console.log(`Done. mimeType=${mimeType} base64Length=${data.length}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
