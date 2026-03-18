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

// Tracks a submitted job and its retry state
interface TrackedJob {
  jobId: string;
  videoLink: string;
  title: string;
  pollUrlBase: string;
  attempts: number;
  maxAttempts: number;
  submittedAt: number;
  status: 'running' | 'done' | 'dead' | 'failed';
}

const DEAD_VIDEO_ERRORS = [
  'removed by the uploader',
  'dead video',
  'video has been removed',
  'http 404',
  'http 410',
  'This video has been removed due to term violence.'
];

function isDeadVideoError(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return DEAD_VIDEO_ERRORS.some(e => lower.includes(e));
}

async function submitJob(videoLink: string, title: string): Promise<string> {
  const response = await axios.post<JobResponse>(API_ENDPOINT, {
    url: videoLink,
    title,
  });
  return response.data.jobId;
}

async function checkJobStatus(jobId: string, pollUrlBase: string): Promise<JobResponse> {
  const res = await axios.get<JobResponse>(`${pollUrlBase}/api/scrape/status/${jobId}`);
  return res.data;
}

// ── Global job tracker ─────────────────────────────────────────────────────
// Jobs are added here when submitted and removed when terminal.
// The background checker in main.ts polls these periodically.
export const activeJobs = new Map<string, TrackedJob>();

/**
 * Submit a video link to the job queue and track it.
 * Returns immediately — does NOT wait for the job to finish.
 */
export async function submitAndTrack(
  videoLink: string,
  title: string,
  pollUrlBase: string,
  maxAttempts = 3
): Promise<void> {
  try {
    const jobId = await submitJob(videoLink, title);
    log(`    [SUBMITTED] ${jobId} → ${videoLink}`);

    activeJobs.set(jobId, {
      jobId,
      videoLink,
      title,
      pollUrlBase,
      attempts: 1,
      maxAttempts,
      submittedAt: Date.now(),
      status: 'running',
    });
  } catch (e: any) {
    log(`    [SUBMIT ERR] ${videoLink}: ${e.message}`, 'error');
  }
}

/**
 * Check all active jobs once and update their status.
 * Called periodically by the monitor in main.ts.
 * Re-submits failed jobs up to maxAttempts.
 */
export async function tickJobTracker(): Promise<void> {
  if (activeJobs.size === 0) return;

  log(`[TRACKER] Checking ${activeJobs.size} active job(s)...`);

  for (const [jobId, tracked] of activeJobs.entries()) {
    // Hard timeout — 1 Hrs  per job
    const elapsed = Date.now() - tracked.submittedAt;
    if (elapsed >  60 * 60 * 1000) {
      log(`[TRACKER] Job ${jobId} timed out (1hr) — giving up`, 'warn');
      activeJobs.delete(jobId);
      continue;
    }

    let job: JobResponse;
    try {
      job = await checkJobStatus(jobId, tracked.pollUrlBase);
    } catch (e: any) {
      log(`[TRACKER] Poll error for ${jobId}: ${e.message}`, 'warn');
      continue; // retry next tick
    }

    log(`[TRACKER] ${jobId} → ${job.status}`);

    if (job.status === 'done') {
      if (job.result?.isDuplicate) {
        log(`[TRACKER] ${jobId} ✓ Duplicate — already stored`);
      } else {
        log(`[TRACKER] ${jobId} ✓ Stored → R2: ${job.result?.r2Key}`);
      }
      activeJobs.delete(jobId);
      continue;
    }

    if (job.status === 'failed') {
      if (isDeadVideoError(job.error)) {
        log(`[TRACKER] ${jobId} ⊘ Dead video — ${job.error}`, 'warn');
        activeJobs.delete(jobId);
        continue;
      }

      // Transient failure — retry if attempts remaining
      if (tracked.attempts < tracked.maxAttempts) {
        log(`[TRACKER] ${jobId} ✗ Failed (attempt ${tracked.attempts}/${tracked.maxAttempts}) — resubmitting: ${tracked.videoLink}`, 'warn');
        try {
          const newJobId = await submitJob(tracked.videoLink, tracked.title);
          log(`[TRACKER] Resubmitted as ${newJobId}`);

          // Replace old job entry with new one
          activeJobs.delete(jobId);
          activeJobs.set(newJobId, {
            ...tracked,
            jobId: newJobId,
            attempts: tracked.attempts + 1,
            submittedAt: Date.now(),
            status: 'running',
          });
        } catch (e: any) {
          log(`[TRACKER] Resubmit failed for ${tracked.videoLink}: ${e.message}`, 'error');
          activeJobs.delete(jobId);
        }
      } else {
        log(`[TRACKER] ${jobId} ✗ Giving up after ${tracked.attempts} attempts: ${tracked.videoLink}`, 'error');
        activeJobs.delete(jobId);
      }
    }
    // pending / scraping / storing — still running, check next tick
  }

  if (activeJobs.size > 0) {
    log(`[TRACKER] ${activeJobs.size} job(s) still running`);
  }
}


// Add to top of engine.ts
function buildPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) return baseUrl;
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return `${base}page/${page}/`;
}

// ── Main crawler ───────────────────────────────────────────────────────────

// Replace just the crawlSite function in engine.ts

export async function crawlSite(
  site: SiteConfig,
  state: StateManager,
  pollUrlBase: string
) {
  log(`[INDEX] Scanning: ${site.name} (${site.pagesToCrawl} page(s))`);

  const uniqueTopics = new Set<string>();
  let skippedTopics = 0;

  // ── Crawl index pages ────────────────────────────────────────────────────
  for (let page = 1; page <= site.pagesToCrawl; page++) {
    const pageUrl = buildPageUrl(site.url, page);
    log(`[INDEX] Page ${page}/${site.pagesToCrawl}: ${pageUrl}`);

    try {
      const { content } = await getPageData(pageUrl);
      const $index = cheerio.load(content);

      $index(site.topicSelector).each((_, el) => {
        const href = $index(el).attr('href') || '';
        // Only keep clean topic URLs — skip tags, profiles, etc.
        if (href.includes('/topic/') && !href.includes('/tags/')) {
          uniqueTopics.add(href);
        }
      });

      log(`[INDEX] Page ${page}: ${uniqueTopics.size} unique topic(s) so far`);

      // Polite delay between index page fetches
      if (page < site.pagesToCrawl) {
        await new Promise(r => setTimeout(r, 2_000));
      }

    } catch (err: any) {
      log(`[INDEX] Failed to load page ${page}: ${err.message}`, 'error');
      // Continue to next page rather than aborting the whole crawl
    }
  }

  log(`[INDEX] Total unique topics found: ${uniqueTopics.size}`);

  // ── Process topics ───────────────────────────────────────────────────────
  let totalSubmitted = 0;

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

      log(`    [QUEUE] Submitting ${total} new link(s) (${skippedLinksCount} already seen)`);

      for (let i = 0; i < newLinks.length; i++) {
        const videoLink = newLinks[i];
        log(`    [SUBMIT] ${i + 1}/${total} → ${videoLink}`);
        await submitAndTrack(videoLink, title, pollUrlBase);
        await new Promise(r => setTimeout(r, 1_000));
      }

      totalSubmitted += total;
      log(`    [TOPIC DONE] Submitted ${total} job(s)`);

    } catch (topicErr: any) {
      log(`  [SKIP] Error on topic ${topicUrl}: ${topicErr.message}`, 'error');
    }
  }

  if (skippedTopics > 0) {
    log(`[STATE] Ignored ${skippedTopics} already-seen topics`);
  }
  log(`[FINISHED] ${site.name} — ${totalSubmitted} job(s) submitted | ${activeJobs.size} total active`);
}