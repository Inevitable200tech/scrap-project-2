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
    await page.waitForSelector(site.topicSelector, { timeout: 15000 }).catch(() => {});

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
        const videoLinks = site.parse($);

        // 5. Send discovered Video Host links to the Scraper API
        for (const videoLink of videoLinks) {
          // Check if we've already scraped THIS specific video link
          if (state.isNew(videoLink, "video_host_link")) {
            console.log(`    [SENDING] → ${videoLink}`);
            
            await axios.post(API_ENDPOINT, { 
              url: videoLink, 
              source: site.name,
              parentTopic: topicUrl // Useful for debugging/tracking
            }).catch(e => {
              console.error(`    [API ERR] ${e.message}`);
            });

            // Rate limit protection for your Render API
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
    await browser.close().catch(() => {});
  }
}