// main.ts (monitor)
import express from 'express';
import { SITES, CHECK_INTERVAL_MS, API_ENDPOINT } from './addons/config';
import { StateManager } from './addons/state';
import { crawlSite, tickJobTracker, activeJobs } from './addons/engine';
import dotenv from 'dotenv';

dotenv.config({ path: 'cert.env' });

const app = express();
const PORT = 823;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://...';
const state = new StateManager(MONGO_URI);

const POLL_URL_BASE = (() => {
  try {
    const u = new URL(API_ENDPOINT);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'http://localhost:3500';
  }
})();

function logMemory() {
  const used = process.memoryUsage();
  const rss = Math.round(used.rss / 1024 / 1024);
  const heap = Math.round(used.heapUsed / 1024 / 1024);
  console.log(`[MEMORY] RSS: ${rss}MB | Heap Used: ${heap}MB`);
  if (rss > 425) {
    console.warn(`[!] CRITICAL: Memory usage is dangerously high (${rss}MB/425MB)`);
  }
  if (rss >= 450) {
    console.error(`[!] FATAL: Memory usage reached 450MB or above (${rss}MB). Exiting process to enforce limit.`);
    process.exit(1);
  }
}

async function runMonitor() {
  console.log(`\n--- Starting Cycle ${new Date().toLocaleTimeString()} ---`);
  logMemory();

  for (const site of SITES) {
    try {
      await crawlSite(site, state, POLL_URL_BASE);
    } catch (err) {
      console.error(`[CRITICAL] Cycle failed for ${site.name}:`, err);
    }
  }

  try {
    const stats = await state.getStats();
    console.log(`[DB STATUS] Known Topics: ${stats.topics} | Stored Links: ${stats.links}`);
  } catch (e) {
    console.warn(`[DB STATUS] Could not fetch stats: ${e}`);
  }

  console.log(`--- Cycle Finished ${new Date().toLocaleTimeString()} ---`);
  logMemory();

  if (global.gc) {
    global.gc();
    console.log(`[MEMORY] Forced Garbage Collection.`);
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const stats = await state.getStats();
  res.json({
    sites: SITES.map(s => s.name),
    interval: CHECK_INTERVAL_MS,
    database: stats,
    pollUrlBase: POLL_URL_BASE,
    activeJobs: activeJobs.size,
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    },
  });
});

// Show all currently tracked jobs
app.get('/api/jobs', (req, res) => {
  res.json(Array.from(activeJobs.values()).map(j => ({
    jobId: j.jobId,
    videoLink: j.videoLink,
    attempts: j.attempts,
    status: j.status,
    runningFor: `${Math.round((Date.now() - j.submittedAt) / 1000)}s`,
  })));
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, async () => {
  console.log(`Monitor API listening on http://localhost:${PORT}`);

  try {
    await state.connect();
    await runMonitor();

    // ── Crawl cycle — runs every CHECK_INTERVAL_MS ─────────────────────
    setInterval(runMonitor, CHECK_INTERVAL_MS);

    // ── Job tracker — runs every 30s independently of crawl cycle ──────
    // Checks status of all submitted jobs and retries failed ones.
    setInterval(async () => {
      try {
        await tickJobTracker();
      } catch (err) {
        console.error('[TRACKER ERROR]', err);
      }
    }, 30_000);

  } catch (err) {
    console.error('FATAL: Could not initialize database. Process exiting.');
    process.exit(1);
  }
});