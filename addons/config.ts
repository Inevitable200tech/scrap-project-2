import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ path: 'cert.env' });

const page_crawl = Number(process.env.PAGE_CRAWL || 1);
export const API_ENDPOINT = 'https://scrap-project-1-j2sd.onrender.com/api/scrape';
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface SiteConfig {
  name: string;
  url: string;
  // How many pages to crawl per cycle. 1 = front page only.
  // Increase this when you're ready to crawl deeper.
  pagesToCrawl: number;
  topicSelector: string;
  videoLinkSelector: string;
  parse: ($: any) => Promise<string[]>;
}

// ── Host priority ──────────────────────────────────────────────────────────
function getHostPriority(domain: string): number {
  if (domain.includes('streamtape'))  return 1;
  if (domain.includes('vidara'))      return 2;
  if (domain.includes('vidnest'))     return 3;
  if (domain.includes('vidsonic'))    return 4;
  if (domain.includes('boodstream'))  return 5;
  return 99;
}

// ── Domains to ignore entirely ─────────────────────────────────────────────
const IGNORED_DOMAINS = /luluvid|dropmms|pixhost|postimg|imagetwist|flash-files|krakenfiles|upfiles|frdl\.io|torupload|file-upload|twitter|reddit|linkedin|pinterest|dupload.net|img|facebook|fembed/i;

// ── Quick dead check ───────────────────────────────────────────────────────
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
    return false;
  }
}

// ── Page URL builder ───────────────────────────────────────────────────────
// Builds paginated URLs for IPS (Invision Power Suite) forums.

export const SITES: SiteConfig[] = [
  {
    name: 'dropmms',
    url: 'https://dropmms.co/forum/2-desi-new-videoz-hd-sd/',

    // ── Pagination control ─────────────────────────────────────────────
    // Set to 1 for front page only.
    // When ready to go deeper, increase this number.
    // The forum has 1079 pages × 24 topics = ~25,896 topics total.
    // Suggested progression: 1 → 5 → 25 → 100 as backlog is processed.
    pagesToCrawl: page_crawl,

    topicSelector: 'a[href*="/topic/"]',
    videoLinkSelector: '.cPost_contentWrap a[href]',

    parse: async ($) => {

      // ── Only parse the first post (OP) ──────────────────────────────
      // Replies on this forum quote the OP verbatim, so every post
      // contains identical links. Parsing only the first post avoids
      // collecting the same URLs 3× and speeds up dead-link checking.
      const firstPost = $('.cPost_contentWrap').first();

      if (!firstPost.length) {
        console.log('    [PARSE] Could not find first post container');
        return [];
      }

      // ── Collect and group links by domain ────────────────────────────
      const domainMap: Record<string, string[]> = {};

      firstPost.find('a[href]').each((_: any, el: any) => {
        const href = $(el).attr('href') || '';
        if (IGNORED_DOMAINS.test(href)) return;
        if (!href.startsWith('http')) return;

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
        console.log('    [PARSE] No video links found in first post');
        return [];
      }

      console.log(`    [PARSE] Found ${domains.length} host(s) in first post:`);
      domains.forEach(d => {
        console.log(`      ${d}: ${domainMap[d].length} link(s)`);
      });

      // ── Quick dead check per domain ──────────────────────────────────
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

        console.log(`      [${domain}] Live: ${liveLinks.length}/${allLinks.length}`);

        domainStats.push({
          domain,
          allLinks,
          liveLinks,
          deadCount,
          priority: getHostPriority(domain),
        });
      }

      // ── Pick the best host ───────────────────────────────────────────
      // Rule 1: Prefer hosts where ALL links are alive (complete set of parts).
      // Rule 2: Among complete hosts, pick the one with the most live links.
      // Rule 3: Tie-break by priority (lower = better / more supported).
      // Rule 4: If no complete host exists, fall back to most live links.
      const withLiveLinks = domainStats.filter(d => d.liveLinks.length > 0);

      if (withLiveLinks.length === 0) {
        console.log('    [DECISION] All links across all hosts are dead — skipping');
        return [];
      }

      const completeHosts = withLiveLinks.filter(d => d.deadCount === 0);
      const pool = completeHosts.length > 0 ? completeHosts : withLiveLinks;

      if (completeHosts.length === 0) {
        console.log('    [WARN] No host has all parts alive — using best partial match');
      }

      const maxLive = Math.max(...pool.map(d => d.liveLinks.length));
      const finalists = pool.filter(d => d.liveLinks.length === maxLive);
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