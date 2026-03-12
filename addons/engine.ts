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
 * This ensures the browser process is killed immediately after the task.
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
    // 1. Get the Topic List from the index
    const indexData = await getPageData(site.url);
    const $index = cheerio.load(indexData.content);
    
    const rawUrls: string[] = [];
    $index(site.topicSelector).each((_, el) => {
      const href = $index(el).attr('href');
      if (href) rawUrls.push(href);
    });

    uniqueTopics = [...new Set(rawUrls)].filter(url => 
        url.includes('/topic/') && !url.includes('/tags/')
    );

    console.log(`[INDEX] Found ${uniqueTopics.length} topics. Processing with process isolation...`);

  } catch (err: any) {
    console.error(`[CRITICAL] Failed to scan index: ${err.message}`);
    return;
  }

  // 2. Iterate through each Topic with a FRESH browser instance per topic
  for (const topicUrl of uniqueTopics) {
    if (!state.isNew(topicUrl, "topic_visited")) continue;

    try {
      // Launch, Scrape, and Kill browser for this specific topic
      const { content, title } = await getPageData(topicUrl, site.url);
      console.log(`  [TOPIC] Title: "${title}"`);

      const $ = cheerio.load(content);
      const videoLinks = await site.parse($);

      if (videoLinks.length === 0) {
        console.log(`    [INFO] No valid links found.`);
      }

      for (const videoLink of videoLinks) {
        if (state.isNew(videoLink, "video_host_link")) {
          console.log(`    [SENDING] → ${videoLink}`);
          await sendToApiWithRetry(videoLink, site.name, topicUrl, title);
          // Small gap to prevent API rate limits
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    } catch (topicErr: any) {
      console.error(`  [SKIP] Timeout or Error on topic ${topicUrl}: ${topicErr.message}`);
    }
  }
}

/**
 * Robust API delivery with built-in retry for 429/202 responses
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
}