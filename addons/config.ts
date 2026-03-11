import axios from 'axios';

export const API_ENDPOINT = 'https://scrap-project-1-j2sd.onrender.com/api/scrape/';
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface SiteConfig {
  name: string;
  url: string;
  topicSelector: string;
  videoLinkSelector: string;
  // Updated to Promise<string[]> to support async health checks
  parse: ($: any) => Promise<string[]>;
}

/**
 * Fast health check to see if a link is still alive.
 * Uses a short timeout to prevent the scraper from hanging.
 */
async function isLinkAlive(url: string): Promise<boolean> {
  try {
    const response = await axios.get(url, { 
      timeout: 5000, 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      validateStatus: (status) => status === 200 // Only count 200 OK as alive
    });
    
    // Simple check for "Video Deleted" text often found in host HTML
    const html = response.data.toString().toLowerCase();
    const isDeleted = html.includes('video was deleted') || html.includes('file not found');
    
    return !isDeleted;
  } catch {
    return false;
  }
}

export const SITES: SiteConfig[] = [
  {
    name: 'dropmms',
    url: 'https://dropmms.co/forum/2-desi-new-videoz-hd-sd/',
    topicSelector: '.tthumb_grid_item .tthumb_gal_title a',
    videoLinkSelector: '.cPost_contentWrap a[href]',
    parse: async ($) => {
      const domainMap: Record<string, string[]> = {};

      // 1. Group links by domain
      $('.cPost_contentWrap a[href]').each((_: any, el: any) => {
        const href = $(el).attr('href') || '';
        if (/luluvid|krakenfiles|upfiles|frdl\.io|torupload/i.test(href)) return;

        try {
          const domain = new URL(href).hostname.replace('www.', '');
          if (!domainMap[domain]) domainMap[domain] = [];
          domainMap[domain].push(href);
        } catch (e) {}
      });

      const domains = Object.keys(domainMap);
      if (domains.length === 0) return [];

      // 2. Perform Health Checks on all groups
      const healthResults = await Promise.all(domains.map(async (domain) => {
        const links = domainMap[domain];
        const aliveStatus = await Promise.all(links.map(link => isLinkAlive(link)));
        const validLinks = links.filter((_, index) => aliveStatus[index]);
        
        return {
          domain,
          allLinks: links,
          validLinks: validLinks,
          count: validLinks.length
        };
      }));

      // 3. Find the maximum number of WORKING links found in any group
      const maxWorkingCount = Math.max(...healthResults.map(r => r.count));
      if (maxWorkingCount === 0) {
        console.log('[HEALTH] All links in all groups are dead.');
        return [];
      }

      // 4. Finalists are domains that have the maximum working links
      const finalists = healthResults.filter(r => r.count === maxWorkingCount);

      // 5. Tie-break finalists using your priority hierarchy
      const getPriority = (d: string) => {
        if (d.includes('streamtape')) return 1;
        if (d.includes('vidara')) return 2;
        if (d.includes('vidnest')) return 3;
        return 4; // General/Other
      };

      finalists.sort((a, b) => getPriority(a.domain) - getPriority(b.domain));

      const winner = finalists[0];
      console.log(`[DECISION] Winner: ${winner.domain} | Working: ${winner.count}/${winner.allLinks.length}`);
      
      // Return only the WORKING links from the winning group
      return winner.validLinks;
    }
  }
];