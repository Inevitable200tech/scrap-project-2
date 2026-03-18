import axios from 'axios';

export const API_ENDPOINT = 'https://scrap-project-1-j2sd.onrender.com/api/scrape';
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface SiteConfig {
  name: string;
  url: string;
  topicSelector: string;
  videoLinkSelector: string;
  parse: ($: any) => Promise<string[]>;
}

// ── Host priority ──────────────────────────────────────────────────────────
// Known/supported hosts rank higher than unknown ones.
// Lower number = higher priority.
function getHostPriority(domain: string): number {
  if (domain.includes('streamtape'))  return 1;
  if (domain.includes('vidara'))      return 2;
  if (domain.includes('vidnest'))     return 3;
  if (domain.includes('vidsonic'))    return 4;
  if (domain.includes('boodstream'))  return 5;
  return 99; // unknown — lowest priority but still usable as fallback
}

// ── Domains to ignore entirely ─────────────────────────────────────────────
// Image hosts, file lockers, forum itself — never video content.
const IGNORED_DOMAINS = /luluvid|dropmms|pixhost|postimg|imagetwist|flash-files|krakenfiles|upfiles|frdl\.io|torupload|file-upload/i;

// ── Quick dead check ───────────────────────────────────────────────────────
// Only catches definitive HTTP 404/410.
// TLS-blocking hosts (vidsonic etc.) return false — scraper handles them.
async function isDefinitelyDead(url: string): Promise<boolean> {
  try {
    const res = await axios.head(url, {
      timeout: 4000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      validateStatus: () => true,
    });
    return res.status === 404 || res.status === 410;
  } catch {
    return false; // assume alive — scraper will catch it
  }
}

export const SITES: SiteConfig[] = [
  {
    name: 'dropmms',
    url: 'https://dropmms.co/forum/2-desi-new-videoz-hd-sd/',
    topicSelector: '.tthumb_grid_item .tthumb_gal_title a',
    videoLinkSelector: '.cPost_contentWrap a[href]',
    parse: async ($) => {

      // ── Step 1: Collect and group links by domain ──────────────────────
      const domainMap: Record<string, string[]> = {};

      $('.cPost_contentWrap a[href]').each((_: any, el: any) => {
        const href = $(el).attr('href') || '';
        if (IGNORED_DOMAINS.test(href)) return;

        try {
          const domain = new URL(href).hostname.replace('www.', '');
          if (!domainMap[domain]) domainMap[domain] = [];
          if (!domainMap[domain].includes(href)) {
            domainMap[domain].push(href);
          }
        } catch {
          // skip malformed URLs
        }
      });

      const domains = Object.keys(domainMap);

      if (domains.length === 0) {
        console.log('    [PARSE] No video links found in topic');
        return [];
      }

      console.log(`    [PARSE] Found ${domains.length} host(s):`);
      domains.forEach(d => {
        console.log(`      ${d}: ${domainMap[d].length} link(s)`);
      });

      // ── Step 2: Quick dead check per domain ───────────────────────────
      const domainStats: {
        domain: string;
        allLinks: string[];
        liveLinks: string[];
        deadCount: number;
        priority: number;
      }[] = [];

      for (const domain of domains) {
        const allLinks = domainMap[domain];
        const liveLinks: string[] = [];
        let deadCount = 0;

        for (const link of allLinks) {
          const dead = await isDefinitelyDead(link);
          if (dead) {
            deadCount++;
            console.log(`      [DEAD] ${link}`);
          } else {
            liveLinks.push(link);
          }
          await new Promise(r => setTimeout(r, 100));
        }

        console.log(`      [${domain}] Live: ${liveLinks.length}/${allLinks.length} | Priority: ${getHostPriority(domain)}`);

        domainStats.push({
          domain,
          allLinks,
          liveLinks,
          deadCount,
          priority: getHostPriority(domain),
        });
      }

      // ── Step 3: Selection logic ────────────────────────────────────────
      //
      // Goal: find the single best host that has the most complete set of
      // parts for the video. Rules in order:
      //
      // Rule 1: Prefer hosts where ALL links are alive (no dead parts).
      // Rule 2: Among complete hosts, pick the one with the most live links.
      // Rule 3: Tie-break by priority (lower = better / more supported).
      // Rule 4: If NO host is fully alive, pick the one with the most live
      //         links regardless, same tie-break.
      //
      // This means boodstream (unknown, priority 99) beats vidara (3 parts)
      // if boodstream has 4 complete alive parts and vidara has 3.

      const withLiveLinks = domainStats.filter(d => d.liveLinks.length > 0);

      if (withLiveLinks.length === 0) {
        console.log('    [DECISION] All links across all hosts are dead — skipping topic');
        return [];
      }

      const completeHosts = withLiveLinks.filter(d => d.deadCount === 0);
      const pool = completeHosts.length > 0 ? completeHosts : withLiveLinks;

      if (completeHosts.length === 0) {
        console.log('    [WARN] No host has all parts alive — using best partial match');
      }

      // Find the maximum live link count in the pool
      const maxLive = Math.max(...pool.map(d => d.liveLinks.length));

      // All hosts tied at that count
      const finalists = pool.filter(d => d.liveLinks.length === maxLive);

      // Tie-break: lower priority number wins (known hosts beat unknown)
      finalists.sort((a, b) => a.priority - b.priority);

      const winner = finalists[0];
      const isUnknown = winner.priority === 99;

      console.log(
        `    [DECISION] Winner: ${winner.domain}` +
        ` | Live: ${winner.liveLinks.length}/${winner.allLinks.length}` +
        ` | Dead: ${winner.deadCount}` +
        (isUnknown ? ' | ⚠ Unknown host — scraper will attempt generic extraction' : '')
      );

      return winner.liveLinks;
    }
  }
];
