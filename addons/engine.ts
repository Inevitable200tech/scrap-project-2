import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { SiteConfig, API_ENDPOINT } from './config';
import { StateManager } from './state';

playwrightExtra.chromium.use(StealthPlugin());

export async function crawlSite(site: SiteConfig, state: StateManager) {
  // 1. Launch Browser with low-RAM optimizations
  const browser = await playwrightExtra.chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Uses disk instead of RAM for temporary files
      '--disable-accelerated-2d-canvas',
      '--no-zygote',
      '--single-process' // Reduces overhead on restricted environments
    ]
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // 2. RAM SAVER: Block unnecessary resources
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        return route.abort();
      }
      route.continue();
    });

    console.log(`[INDEX] Scanning index: ${site.url}`);
    
    // Using 'domcontentloaded' is faster and lighter than 'networkidle'
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(site.topicSelector, { timeout: 15000 }).catch(() => { });

    // 3. Collect Topic URLs and filter out junk
    const topicUrls: string[] = await page.$$eval(site.topicSelector, (elements) =>
      elements.map(el => (el as HTMLAnchorElement).href)
    );

    // Filter out tags/profiles/etc to keep the bot on track
    const uniqueTopics = [...new Set(topicUrls)].filter(url => 
        url.includes('/topic/') && !url.includes('/tags/')
    );

    console.log(`[INDEX] Found ${uniqueTopics.length} valid topics. Deep-scanning...`);

    // 4. Iterate through each Topic
    for (const topicUrl of uniqueTopics) {
      try {
        console.log(`  [TOPIC] Visiting: ${topicUrl}`);

        await page.goto(topicUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const $ = cheerio.load(await page.content());

        const videoLinks = await site.parse($);

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

                if (response.status === 200 || response.status === 201) {
                  console.log(`    [SUCCESS] Delivered: ${videoLink}`);
                  sent = true;
                }
              } catch (e: any) {
                attempts++;
                // Handle 202 or 429 as "wait and retry"
                const isRateLimit = e.response?.status === 202 || e.response?.status === 429 || e.message.includes('try again');

                if (isRateLimit && attempts < maxAttempts) {
                  console.warn(`    [RATE LIMIT] Waiting 10s (Attempt ${attempts})...`);
                  await new Promise(r => setTimeout(r, 10000));
                } else {
                  console.error(`    [API ERR] Failed ${videoLink}: ${e.message}`);
                  break; 
                }
              }
            }
            await new Promise(r => setTimeout(r, 3000)); 
          }
        }
      } catch (topicErr: any) {
        console.error(`  [SKIP] Timeout or Error on topic: ${topicUrl}`);
      }
      
      // Periodically clear cookies/storage to prevent bloat
      if (uniqueTopics.indexOf(topicUrl) % 5 === 0) {
          await context.clearCookies();
      }
    }
  } catch (err: any) {
    console.error(`[CRITICAL] Engine failure: ${err.message}`);
  } finally {
    await browser.close().catch(() => { });
  }
}