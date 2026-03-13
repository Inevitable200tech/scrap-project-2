import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { SiteConfig, API_ENDPOINT } from './config';
import { StateManager } from './state';

playwrightExtra.chromium.use(StealthPlugin());

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-zygote',
  '--single-process',
  '--disable-gpu'
];

/**
 * Helper to perform a single scoped navigation and return data.
 * Process isolation: Browser is killed immediately after data is fetched.
 */
async function getPageData(url: string, referer?: string) {
  const browser = await playwrightExtra.chromium.launch({ 
    headless: true, 
    args: BROWSER_ARGS 
  });
  
  try {
    const context = await browser.newContext({
      extraHTTPHeaders: referer ? { 'Referer': referer } : {}
    });
    const page = await context.newPage();
    
    // RAM SAVER: Block heavy assets
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      return ['image', 'stylesheet', 'font', 'media'].includes(type) ? route.abort() : route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const content = await page.content();
    const title = await page.title();
    
    return { content, title };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function crawlSite(site: SiteConfig, state: StateManager) {
  console.log(`[INDEX] Scanning index: ${site.url}`);
  
  let uniqueTopics: string[] = [];

  try {
    const indexData = await getPageData(site.url);
    const $index = cheerio.load(indexData.content);
    
    const rawUrls: string[] = [];
    $index(site.topicSelector).each((_, el) => {
      const href = $index(el).attr('href');
      if (href) rawUrls.push(href);
    });

    // Filter for actual topics and limit to the 15 newest to stay within Render time limits
    uniqueTopics = [...new Set(rawUrls)]
      .filter(url => url.includes('/topic/') && !url.includes('/tags/'))
      .slice(0, 15); 

    console.log(`[INDEX] Found ${uniqueTopics.length} topics to check.`);

  } catch (err: any) {
    console.error(`[CRITICAL] Failed to scan index: ${err.message}`);
    return;
  }

  // 2. Iterate through each Topic
  for (const topicUrl of uniqueTopics) {
    // CRITICAL: isNew is now ASYNC because of MongoDB
    const isNewTopic = await state.isNew(topicUrl, "topic_visited");
    if (!isNewTopic) continue;

    try {
      console.log(`  [NEW TOPIC] Processing: ${topicUrl}`);
      const { content, title } = await getPageData(topicUrl, site.url);
      
      const $ = cheerio.load(content);
      const videoLinks = await site.parse($);

      if (videoLinks.length === 0) {
        console.log(`    [INFO] No valid links found.`);
      }

      for (const videoLink of videoLinks) {
        // CRITICAL: isNew is now ASYNC
        const isNewVideo = await state.isNew(videoLink, "video_host_link");
        if (isNewVideo) {
          console.log(`    [SENDING] → ${videoLink}`);
          await sendToApiWithRetry(videoLink, site.name, topicUrl, title);
          
          // Throttling to be nice to your API
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    } catch (topicErr: any) {
      console.error(`  [SKIP] Error on topic ${topicUrl}: ${topicErr.message}`);
    }
  }
  console.log(`[FINISHED] Cycle complete. Waiting for next interval...`);
}

/**
 * Robust API delivery with built-in retry
 */
async function sendToApiWithRetry(videoLink: string, siteName: string, topicUrl: string, title: string) {
  let sent = false;
  let attempts = 0;
  const maxAttempts = 3;

  while (!sent && attempts < maxAttempts) {
    try {
      const response = await axios.post(API_ENDPOINT, {
        url: videoLink,
        source: siteName,
        parentTopic: topicUrl,
        topicTitle: title
      });

      if (response.status === 200 || response.status === 201) {
        console.log(`    [SUCCESS] Delivered: ${videoLink}`);
        sent = true;
      }
    } catch (e: any) {
      attempts++;
      const isRateLimit = e.response?.status === 202 || e.response?.status === 429;

      if (isRateLimit && attempts < maxAttempts) {
        console.warn(`    [RATE LIMIT] Waiting 10s (Attempt ${attempts})...`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        console.error(`    [API ERR] Failed ${videoLink}: ${e.message}`);
        break; 
      }
    }
  }
}