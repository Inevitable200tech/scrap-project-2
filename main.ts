// scrap-home.ts
// Run with: npx tsx scrap-home.ts

import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import express from 'express';
const app = express();
const PORT = 823;
playwrightExtra.chromium.use(StealthPlugin());

// ── Configuration ────────────────────────────────────────────────────────────
const BASE_URL = 'https://dropmms.com/forum/2-desi-new-videoz-hd-sd/page/1/';
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STORAGE_FILE = path.join(process.cwd(), 'previous-topics.json'); // optional persistent storage

// Your API endpoint (replace this!)
const API_ENDPOINT = 'https://scrap-project-1.onrender.com/api/scrape/'; // ← FILL THIS IN

// ── Global state ─────────────────────────────────────────────────────────────
let previousTopics: Set<string> = new Set(); // link + title hash

// Load previous state from file (if exists)
async function loadPreviousState() {
    try {
        const data = await fs.readFile(STORAGE_FILE, 'utf-8');
        const topics = JSON.parse(data);
        previousTopics = new Set(topics);
        console.log(`Loaded ${previousTopics.size} previous topics from file`);
    } catch (err) {
        console.log('No previous state found. Starting fresh.');
    }
}

// Save current state to file
async function saveState() {
    const topicsArray = Array.from(previousTopics);
    await fs.writeFile(STORAGE_FILE, JSON.stringify(topicsArray, null, 2));
    console.log(`Saved ${topicsArray.length} topics to storage`);
}

// Generate unique key for comparison (link + title)
function getTopicKey(link: string, title: string): string {
    return `${link}|${title.trim()}`;
}

// ── Scrape function ──────────────────────────────────────────────────────────
async function scrapeAndCompare() {
    console.log(`\n[${new Date().toISOString()}] Starting scrape...`);

    let browser;
    try {
        browser = await playwrightExtra.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        });

        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });

        // Wait for grid to load
        await page.waitForSelector('.tthumbGridview', { timeout: 30000 }).catch(() => { });

        const html = await page.content();
        const $ = cheerio.load(html);

        const currentTopics: { link: string; title: string }[] = [];

        $('.tthumb_grid_item').each((_, item) => {
            const $item = $(item);
            const $a = $item.find('.tthumb_gal_title a');
            const link = $a.attr('href') || '';
            const title = $a.text().trim();

            if (link && title && link.includes('/topic/')) {
                currentTopics.push({ link, title });
            }
        });

        console.log(`Found ${currentTopics.length} topics on page 1`);

        // Compare with previous
        const newTopics: { link: string; title: string }[] = [];

        for (const topic of currentTopics) {
            const key = getTopicKey(topic.link, topic.title);
            if (!previousTopics.has(key)) {
                newTopics.push(topic);
                previousTopics.add(key);
            }
        }

        // Report & send new ones
        if (newTopics.length > 0) {
            console.log(`\nFound ${newTopics.length} NEW topics:`);

            for (const t of newTopics) {
                console.log(`  - ${t.title}`);
                console.log(`    ${t.link}`);

                try {
                    const response = await axios.post(API_ENDPOINT, {
                        url: t.link,
                        title: t.title,
                        source: 'dropmms-home',
                        timestamp: new Date().toISOString(),
                    });

                    console.log(`  → Sent successfully (status ${response.status})`);

                    // Enforce minimum delay between requests
                    await new Promise(resolve => setTimeout(resolve, 4000)); // 4 seconds

                } catch (apiErr: any) {
                    const status = apiErr.response?.status || 'unknown';
                    console.error(`  → API error: ${apiErr.message} (status: ${status})`);

                    if (status === 429) {
                        console.warn('  → Rate limit hit. Waiting longer before next attempt...');
                        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds extra on 429
                    }
                }
            }

            await saveState();
        } else {
            console.log('No new topics detected.');
        }

    } catch (err) {
        console.error('Scrape error:', (err as Error).message);
    } finally {
        if (browser) await browser.close();
    }
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
    console.log('Starting home page monitor...');
    console.log(`URL: ${BASE_URL}`);
    console.log(`Interval: every 5 minutes`);
    console.log(`API endpoint: ${API_ENDPOINT}`);

    await loadPreviousState();

    // Run once immediately
    await scrapeAndCompare();

    // Then every 5 minutes
    setInterval(scrapeAndCompare, CHECK_INTERVAL_MS);
}

main().catch(console.error);
// Health check with debug
app.get('/health', (req, res) => {
  console.log('[HEALTH] Check requested');
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`\nServer running on http://localhost:${PORT}`);
 
});