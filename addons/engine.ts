import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { SiteConfig, API_ENDPOINT } from './config';
import { StateManager } from './state';

playwrightExtra.chromium.use(StealthPlugin());

export async function crawlSite(site: SiteConfig, state: StateManager) {
  // 1. Launch Browser
  const browser = await playwrightExtra.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    console.log(`[INDEX] Scanning index: ${site.url}`);

    // 2. Load the Forum Index
    await page.goto(site.url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector(site.topicSelector, { timeout: 15000 }).catch(() => { });

    // 3. Collect Topic URLs from the grid
    const topicUrls: string[] = await page.$$eval(site.topicSelector, (elements) =>
      elements.map(el => (el as HTMLAnchorElement).href)
    );

    const uniqueTopics = [...new Set(topicUrls)];
    console.log(`[INDEX] Found ${uniqueTopics.length} topics. Entering deep-scan...`);

    // 4. Iterate through each Topic
    for (const topicUrl of uniqueTopics) {
      try {
        console.log(`  [TOPIC] Visiting: ${topicUrl}`);

        // Navigate to the specific post
        await page.goto(topicUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Load content into Cheerio for fast link extraction
        const content = await page.content();
        const $ = cheerio.load(content);

        // Use the site-specific parser to get video host links (Streamtape, Vidara, etc.)
        const videoLinks = await site.parse($);

        // 5. Send discovered Video Host links to the Scraper API
        for (const videoLink of videoLinks) {
          if (state.isNew(videoLink, "video_host_link")) {
            console.log(`    [SENDING] → ${videoLink}`);

            let sent = false;
            let attempts = 0;
            const maxAttempts = 3;

            while (!sent && attempts < maxAttempts) {
              try {
                const response = await axios.post(API_ENDPOINT, {
                  url: videoLink,
                  source: site.name,
                  parentTopic: topicUrl
                });

                if (response.status === 200) {
                  console.log(`    [SUCCESS] Delivered: ${videoLink}`);
                  sent = true;
                }
              } catch (e: any) {
                attempts++;
                const isRateLimit = e.response?.status === 202 || e.message.includes('try again');

                if (isRateLimit && attempts < maxAttempts) {
                  console.warn(`    [RATE LIMIT] Hit limit on attempt ${attempts}. Waiting 10s...`);
                  await new Promise(r => setTimeout(r, 10000)); // 10 second wait
                } else {
                  console.error(`    [API ERR] Failed to send ${videoLink}: ${e.message}`);
                  break; // Stop retrying for non-rate-limit errors or max attempts reached
                }
              }
            }

            // Standard gap between different links to prevent hitting the limit again immediately
            await new Promise(r => setTimeout(r, 4000));
          }
        }
      } catch (topicErr: any) {
        console.error(`  [SKIP] Error processing topic ${topicUrl}: ${topicErr.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[CRITICAL] Engine failure: ${err.message}`);
  } finally {
    // Ensure browser is closed to prevent RAM bloat in Docker
    await browser.close().catch(() => { });
  }
}