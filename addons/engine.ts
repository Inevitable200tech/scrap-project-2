import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { SiteConfig, API_ENDPOINT } from './config';
import { StateManager } from './state';

playwrightExtra.chromium.use(StealthPlugin());

export async function crawlSite(site: SiteConfig, state: StateManager) {
  const browser = await playwrightExtra.chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', 
      '--disable-accelerated-2d-canvas',
      '--no-zygote',
      '--single-process'
    ]
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // RAM SAVER: Block unnecessary resources
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        return route.abort();
      }
      route.continue();
    });

    console.log(`[INDEX] Scanning index: ${site.url}`);
    
    // Increased timeout slightly for the index page
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(site.topicSelector, { timeout: 20000 }).catch(() => { });

    const topicUrls: string[] = await page.$$eval(site.topicSelector, (elements) =>
      elements.map(el => (el as HTMLAnchorElement).href)
    );

    const uniqueTopics = [...new Set(topicUrls)].filter(url => 
        url.includes('/topic/') && !url.includes('/tags/')
    );

    console.log(`[INDEX] Found ${uniqueTopics.length} valid topics. Deep-scanning...`);

    for (const topicUrl of uniqueTopics) {
      try {
        // Navigation with Referer to bypass simple bot checks
        await page.goto(topicUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000,
            referer: site.url 
        });

        // Log the Topic Title
        const pageTitle = await page.title();
        console.log(`  [TOPIC] Title: "${pageTitle}"`);
        console.log(`          URL: ${topicUrl}`);

        const $ = cheerio.load(await page.content());
        const videoLinks = await site.parse($);

        if (videoLinks.length === 0) {
            console.log(`    [INFO] No valid video links found after parsing.`);
        }

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
                  parentTopic: topicUrl,
                  topicTitle: pageTitle // Sending title to your API can be useful too
                });

                if (response.status === 200 || response.status === 201) {
                  console.log(`    [SUCCESS] Delivered: ${videoLink}`);
                  sent = true;
                }
              } catch (e: any) {
                attempts++;
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
        // Log title even on failure if possible to see where it got stuck
        const failTitle = await page.title().catch(() => 'Unknown/Timed Out');
        console.error(`  [SKIP] Error on "${failTitle}": ${topicErr.message}`);
      }
      
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