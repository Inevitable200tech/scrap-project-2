import axios from 'axios';

export const API_ENDPOINT = 'https://scrap-project-1-j2sd.onrender.com/api/scrape/';
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface SiteConfig {
  name: string;
  url: string;
  topicSelector: string;
  videoLinkSelector: string;
  parse: ($: any) => Promise<string[]>;
}

/**
 * Sequential health check to keep memory flat.
 */
async function isLinkAlive(url: string): Promise<boolean> {
  try {
    const response = await axios.get(url, { 
      timeout: 5000, 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      validateStatus: (status) => status === 200 
    });
    
    const html = response.data.toString().toLowerCase();
    const isDeleted = html.includes('video was deleted') || 
                      html.includes('file not found') || 
                      html.includes('no longer exists');
    
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
        // Added postimg/imagetwist to avoid image host "false positives"
        if (/luluvid|dropmms|pixhost|postimg|imagetwist|krakenfiles|upfiles|frdl\.io|torupload/i.test(href)) return;

        try {
          const domain = new URL(href).hostname.replace('www.', '');
          if (!domainMap[domain]) domainMap[domain] = [];
          domainMap[domain].push(href);
        } catch (e) {}
      });

      const domains = Object.keys(domainMap);
      if (domains.length === 0) return [];

      // 2. Perform Health Checks SEQUENTIALLY (RAM Optimization)
      const healthResults = [];
      for (const domain of domains) {
        const links = domainMap[domain];
        const validLinks = [];
        
        console.log(`    [CHECK] Validating ${domain}...`);
        for (const link of links) {
          if (await isLinkAlive(link)) {
            validLinks.push(link);
          }
          // Micro-delay to yield the event loop
          await new Promise(r => setTimeout(r, 100));
        }
        
        healthResults.push({
          domain,
          allLinks: links,
          validLinks,
          count: validLinks.length
        });
      }

      // 3. Find the best host
      const maxWorkingCount = Math.max(...healthResults.map(r => r.count));
      if (maxWorkingCount === 0) {
        console.log('    [HEALTH] All links in all groups are dead.');
        return [];
      }

      const finalists = healthResults.filter(r => r.count === maxWorkingCount);

      // 4. Tie-break priority
      const getPriority = (d: string) => {
        if (d.includes('streamtape')) return 1;
        if (d.includes('vidara')) return 2;
        if (d.includes('vidnest')) return 3;
        return 4; 
      };

      finalists.sort((a, b) => getPriority(a.domain) - getPriority(b.domain));

      const winner = finalists[0];
      console.log(`    [DECISION] Winner: ${winner.domain} | Working: ${winner.count}/${winner.allLinks.length}`);
      
      return winner.validLinks;
    }
  }
];