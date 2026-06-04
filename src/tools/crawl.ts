import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { getBrowser } from "../browser.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Cap text at 20k chars to stay well within Claude's context
const MAX_CHARS = 20_000;

export async function crawlUrl(url: string): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: USER_AGENT,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 30_000,
    }).catch(async () => {
      await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      await page.waitForTimeout(1500);
    });

    const html = await page.content();
    const pageUrl = page.url(); // resolved URL after redirects

    // Try Readability first (best for articles, blog posts, docs)
    const dom = new JSDOM(html, { url: pageUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article?.textContent?.trim()) {
      const text = article.textContent.trim().slice(0, MAX_CHARS);
      const title = article.title ? `# ${article.title}\n\n` : "";
      return `${title}${text}`;
    }

    // Fallback: raw visible text from the page
    const bodyText = await page.evaluate(
      () => (document.body as HTMLElement).innerText
    );
    return bodyText.trim().slice(0, MAX_CHARS);
  } finally {
    await context.close();
  }
}

// Quick test when run directly
if (process.argv[1].endsWith("crawl.ts")) {
  const url = process.argv[2] ?? "https://example.com";
  console.log(`Crawling ${url}...`);
  crawlUrl(url)
    .then((text) => {
      console.log(`Done. chars=${text.length}\n---\n${text.slice(0, 500)}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
