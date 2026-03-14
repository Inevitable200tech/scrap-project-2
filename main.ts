import express from 'express';
import { SITES, CHECK_INTERVAL_MS } from './addons/config';
import { StateManager } from './addons/state';
import { crawlSite } from './addons/engine';
import dotenv from 'dotenv';

dotenv.config({ path: 'cert.env' });

const app = express();
const PORT = 823;

// Add your URI to Render Environment Variables
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://...";
const state = new StateManager(MONGO_URI);

/**
 * Logs current memory usage to console in MB
 */
function logMemory() {
  const used = process.memoryUsage();
  const rss = Math.round(used.rss / 1024 / 1024);
  const heap = Math.round(used.heapUsed / 1024 / 1024);
  
  console.log(`[MEMORY] RSS: ${rss}MB | Heap Used: ${heap}MB`);
  
  if (rss > 450) {
    console.warn(`[!] CRITICAL: Memory usage is dangerously high (${rss}MB/512MB)`);
  }
}

async function runMonitor() {
  console.log(`\n--- Starting Cycle ${new Date().toLocaleTimeString()} ---`);
  logMemory();

  for (const site of SITES) {
    try {
      await crawlSite(site, state);
    } catch (err) {
      console.error(`[CRITICAL] Cycle failed for ${site.name}:`, err);
    }
  }

  // Verbose Database Stats: This explains why logs might be quiet
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

// Routes
app.get('/api/status', async (req, res) => {
  const stats = await state.getStats();
  res.json({ 
    sites: SITES.map(s => s.name), 
    interval: CHECK_INTERVAL_MS,
    database: stats,
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, async () => {
  console.log(`Monitor API listening on http://localhost:${PORT}`);
  
  // Connect to DB once at startup
  try {
    await state.connect();
    
    // Initial Run
    await runMonitor();
    
    // Setup Interval
    setInterval(runMonitor, CHECK_INTERVAL_MS);
  } catch (err) {
    console.error("FATAL: Could not initialize database. Process exiting.");
    process.exit(1);
  }
});