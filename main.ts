import express from 'express';
import { SITES, CHECK_INTERVAL_MS } from './addons/config';
import { StateManager } from './addons/state';
import { crawlSite } from './addons/engine';

const app = express();
const state = new StateManager();
const PORT = 823;

async function runMonitor() {
  console.log(`\n--- Starting Cycle ${new Date().toLocaleTimeString()} ---`);
  for (const site of SITES) {
    await crawlSite(site, state);
  }
  await state.save();
}

// Future Interface Routes
app.get('/api/status', (req, res) => {
  res.json({ sites: SITES.map(s => s.name), interval: CHECK_INTERVAL_MS });
});

app.listen(PORT, async () => {
  console.log(`Monitor API listening on http://localhost:${PORT}`);
  await state.load();
  
  // Run loop
  runMonitor();
  setInterval(runMonitor, CHECK_INTERVAL_MS);
});