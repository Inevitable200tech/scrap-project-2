import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { SiteConfig, API_ENDPOINT } from './config';
import { StateManager } from './state';

playwrightExtra.chromium.use(StealthPlugin());

/**
 * Helper to prefix every log with a high-precision timestamp
 */
function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
  const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = `[${timestamp}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-zygote',
  '--single-process',
  '--disable-gpu'
];

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
  log(`[INDEX] Scanning: ${site.url}`);
  
  let uniqueTopics: string[] = [];
  let skippedTopics = 0;

  try {
    const indexData = await getPageData(site.url);
    const $index = cheerio.load(indexData.content);
    
    const rawUrls: string[] = [];
    $index(site.topicSelector).each((_, el) => {
      const href = $index(el).attr('href');
      if (href) rawUrls.push(href);
    });

    uniqueTopics = [...new Set(rawUrls)]
      .filter(url => url.includes('/topic/') && !url.includes('/tags/'))
      .slice(0, 25); 

    log(`[INDEX] Found ${uniqueTopics.length} potential topics.`);

  } catch (err: any) {
    log(`[CRITICAL] Failed to scan index: ${err.message}`, 'error');
    return;
  }

  for (const topicUrl of uniqueTopics) {
    const isNewTopic = await state.isNew(topicUrl, "topic_visited");
    
    if (!isNewTopic) {
      skippedTopics++;
      continue;
    }

    try {
      log(`  [NEW TOPIC] ${topicUrl}`);
      const { content, title } = await getPageData(topicUrl, site.url);
      
      const $ = cheerio.load(content);
      const videoLinks = await site.parse($);
      let newLinksCount = 0;
      let skippedLinksCount = 0;

      for (const videoLink of videoLinks) {
        const isNewVideo = await state.isNew(videoLink, "video_host_link");
        if (isNewVideo) {
          newLinksCount++;
          log(`    [SENDING] → ${videoLink}`);
          await sendToApiWithRetry(videoLink, site.name, topicUrl, title);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          skippedLinksCount++;
        }
      }

      if (skippedLinksCount > 0) {
        log(`    [STATE] Ignored ${skippedLinksCount} duplicate video links.`);
      }
      
    } catch (topicErr: any) {
      log(`  [SKIP] Error on topic ${topicUrl}: ${topicErr.message}`, 'error');
    }
  }

  if (skippedTopics > 0) {
    log(`[STATE] Ignored ${skippedTopics} topics (already in database).`);
  }
  log(`[FINISHED] Cycle complete for ${site.name}.`);
}

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
        log(`    [SUCCESS] Delivered: ${videoLink}`);
        sent = true;
      }
    } catch (e: any) {
      attempts++;
      const isRateLimit = e.response?.status === 202 || e.response?.status === 429;

      if (isRateLimit && attempts < maxAttempts) {
        log(`    [RATE LIMIT] Waiting 10s (Attempt ${attempts})...`, 'warn');
        await new Promise(r => setTimeout(r, 10000));
      } else {
        log(`    [API ERR] Failed ${videoLink}: ${e.message}`, 'error');
        break; 
      }
    }
  }
}