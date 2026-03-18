// engine.ts
import playwrightExtra from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { SiteConfig, API_ENDPOINT } from './config';
import { StateManager } from './state';

playwrightExtra.chromium.use(StealthPlugin());

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
      return ['image', 'stylesheet', 'font', 'media'].includes(type)
        ? route.abort()
        : route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const content = await page.content();
    const title = await page.title();

    return { content, title };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Job queue client ───────────────────────────────────────────────────────

interface JobResponse {
  jobId: string;
  status: 'pending' | 'scraping' | 'storing' | 'done' | 'failed';
  pollUrl: string;
  result?: {
    title: string;
    r2Key?: string;
    hash?: string;
    isDuplicate?: boolean;
    playUrl?: string;
  };
  error?: string;
}

// Thrown when a job fails because the video is confirmed dead at the source.
// Caught in submitAndWait to skip retries entirely.
class DeadVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadVideoError';
  }
}

/**
 * Submit a video URL to the scraper API job queue.
 * Returns the jobId immediately without waiting for processing.
 */
async function submitJob(videoLink: string, title: string): Promise<string> {
  const response = await axios.post<JobResponse>(API_ENDPOINT, {
    url: videoLink,
    title,
  });
  return response.data.jobId;
}

/**
 * Poll a job until it reaches a terminal state (done / failed).
 * Returns the final job response.
 *
 * Strategy:
 *  - Poll every 5s for the first 2 minutes (fast feedback)
 *  - Then every 15s until timeout
 *  - Hard timeout at 10 minutes
 */
async function waitForJob(
  jobId: string,
  pollUrlBase: string,
  videoLink: string
): Promise<JobResponse> {
  const FAST_INTERVAL_MS = 5_000;
  const SLOW_INTERVAL_MS = 15_000;
  const FAST_PHASE_MS    = 2 * 60 * 1000;  // first 2 minutes
  const HARD_TIMEOUT_MS  = 10 * 60 * 1000; // 10 minutes total

  const started = Date.now();
  let lastStatus = '';

  while (true) {
    const elapsed = Date.now() - started;

    if (elapsed > HARD_TIMEOUT_MS) {
      throw new Error(`Job ${jobId} timed out after 10 minutes`);
    }

    const pollInterval = elapsed < FAST_PHASE_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
    await new Promise(r => setTimeout(r, pollInterval));

    let job: JobResponse;
    try {
      const res = await axios.get<JobResponse>(`${pollUrlBase}/api/scrape/status/${jobId}`);
      job = res.data;
    } catch (e: any) {
      log(`    [POLL ERR] ${jobId}: ${e.message}`, 'warn');
      continue; // retry on network hiccup
    }

    if (job.status !== lastStatus) {
      log(`    [JOB:${jobId}] Status → ${job.status}`);
      lastStatus = job.status;
    }

    if (job.status === 'done') {
      if (job.result?.isDuplicate) {
        log(`    [JOB:${jobId}] Duplicate — already stored`);
      } else {
        log(`    [JOB:${jobId}] ✓ Stored → R2: ${job.result?.r2Key}`);
      }
      return job;
    }

    if (job.status === 'failed') {
      // Dead video — no point retrying, throw a typed error so submitAndWait
      // can skip the retry loop entirely
      if (job.error?.toLowerCase().includes('removed by the uploader') ||
          job.error?.toLowerCase().includes('dead video') ||
          job.error?.toLowerCase().includes('video has been removed') ||
          job.error?.toLowerCase().includes('http 404') ||
          job.error?.toLowerCase().includes('http 410')) {
        throw new DeadVideoError(`Dead video: ${job.error}`);
      }

      // Any other failure — let submitAndWait decide whether to retry
      throw new Error(`Job ${jobId} failed: ${job.error}`);
    }
  }
}

/**
 * Submit a video link to the job queue and wait for the result.
 * Retries submission up to maxAttempts times on transient errors.
 * Dead videos are never retried.
 */
async function submitAndWait(
  videoLink: string,
  title: string,
  pollUrlBase: string,
  maxAttempts = 3
): Promise<void> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;

    try {
      log(`    [SUBMIT] Attempt ${attempts}: ${videoLink}`);
      const jobId = await submitJob(videoLink, title);
      log(`    [JOB:${jobId}] Queued — polling for result...`);
      await waitForJob(jobId, pollUrlBase, videoLink);
      return; // success

    } catch (e: any) {
      // Dead video — skip immediately, no retry
      if (e instanceof DeadVideoError) {
        log(`    [DEAD] ${e.message} — skipping without retry`, 'warn');
        return;
      }

      const isRateLimit = e.response?.status === 429;

      if (isRateLimit && attempts < maxAttempts) {
        log(`    [RATE LIMIT] Waiting 15s (attempt ${attempts})...`, 'warn');
        await new Promise(r => setTimeout(r, 15_000));
      } else if (attempts < maxAttempts) {
        log(`    [RETRY] ${e.message} — retrying in 10s (attempt ${attempts})`, 'warn');
        await new Promise(r => setTimeout(r, 10_000));
      } else {
        log(`    [FAILED] Giving up on ${videoLink}: ${e.message}`, 'error');
      }
    }
  }
}

// ── Main crawler ───────────────────────────────────────────────────────────

export async function crawlSite(
  site: SiteConfig,
  state: StateManager,
  pollUrlBase: string
) {
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
    const isNewTopic = await state.isNew(topicUrl, 'topic_visited');

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
      let deadLinksCount = 0;

      for (const videoLink of videoLinks) {
        const isNewVideo = await state.isNew(videoLink, 'video_host_link');

        if (!isNewVideo) {
          skippedLinksCount++;
          continue;
        }

        newLinksCount++;

        // Submit to job queue and wait for terminal status before moving on.
        // Dead videos return immediately without retrying.
        await submitAndWait(videoLink, title, pollUrlBase);

        // Brief pause between videos to avoid hammering the scraper API
        await new Promise(r => setTimeout(r, 5_000));
      }

      if (newLinksCount > 0) {
        log(`    [DONE] Submitted ${newLinksCount} new video(s) for ${topicUrl}`);
      }
      if (skippedLinksCount > 0) {
        log(`    [STATE] Ignored ${skippedLinksCount} duplicate video link(s).`);
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