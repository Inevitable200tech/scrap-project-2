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

async function submitJob(videoLink: string, title: string): Promise<string> {
  const response = await axios.post<JobResponse>(API_ENDPOINT, {
    url: videoLink,
    title,
  });
  return response.data.jobId;
}

async function waitForJob(
  jobId: string,
  pollUrlBase: string,
  videoLink: string
): Promise<JobResponse> {
  const FAST_INTERVAL_MS = 5_000;
  const SLOW_INTERVAL_MS = 15_000;
  const FAST_PHASE_MS    = 2 * 60 * 1000;
  const HARD_TIMEOUT_MS  = 10 * 60 * 1000;

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
      continue;
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
      if (job.error?.toLowerCase().includes('removed by the uploader') ||
          job.error?.toLowerCase().includes('dead video') ||
          job.error?.toLowerCase().includes('video has been removed') ||
          job.error?.toLowerCase().includes('http 404') ||
          job.error?.toLowerCase().includes('http 410')) {
        throw new DeadVideoError(`Dead video: ${job.error}`);
      }
      throw new Error(`Job ${jobId} failed: ${job.error}`);
    }
  }
}

async function submitAndWait(
  videoLink: string,
  title: string,
  pollUrlBase: string,
  maxAttempts = 3
): Promise<'success' | 'dead' | 'failed'> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;

    try {
      const jobId = await submitJob(videoLink, title);
      log(`    [JOB:${jobId}] Queued — polling for result...`);
      await waitForJob(jobId, pollUrlBase, videoLink);
      return 'success';

    } catch (e: any) {
      if (e instanceof DeadVideoError) {
        log(`    [DEAD] ${e.message} — skipping without retry`, 'warn');
        return 'dead';
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
        return 'failed';
      }
    }
  }

  return 'failed';
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

      // Split into new vs already-seen before processing
      const newLinks: string[] = [];
      let skippedLinksCount = 0;

      for (const videoLink of videoLinks) {
        const isNew = await state.isNew(videoLink, 'video_host_link');
        if (isNew) {
          newLinks.push(videoLink);
        } else {
          skippedLinksCount++;
        }
      }

      const total = newLinks.length;

      if (total === 0) {
        if (skippedLinksCount > 0) {
          log(`    [STATE] All ${skippedLinksCount} link(s) already seen — skipping topic`);
        } else {
          log(`    [EMPTY] No video links found in topic`);
        }
        continue;
      }

      log(`    [QUEUE] ${total} new link(s) to process (${skippedLinksCount} already seen)`);

      // Counters
      let submitted = 0;
      let succeeded = 0;
      let dead      = 0;
      let failed    = 0;

      for (const videoLink of newLinks) {
        submitted++;
        log(`    [PROGRESS] ${submitted}/${total} — submitting: ${videoLink}`);

        const outcome = await submitAndWait(videoLink, title, pollUrlBase);

        if (outcome === 'success') succeeded++;
        else if (outcome === 'dead') dead++;
        else failed++;

        log(`    [PROGRESS] ${submitted}/${total} done — ✓ ${succeeded} stored | ✗ ${failed} failed | ⊘ ${dead} dead`);

        await new Promise(r => setTimeout(r, 5_000));
      }

      // Topic summary
      log(`  [TOPIC DONE] ${topicUrl}`);
      log(`  [SUMMARY] Total: ${total} | Stored: ${succeeded} | Dead: ${dead} | Failed: ${failed} | Skipped: ${skippedLinksCount}`);

    } catch (topicErr: any) {
      log(`  [SKIP] Error on topic ${topicUrl}: ${topicErr.message}`, 'error');
    }
  }

  if (skippedTopics > 0) {
    log(`[STATE] Ignored ${skippedTopics} topics (already in database).`);
  }
  log(`[FINISHED] Cycle complete for ${site.name}.`);
}