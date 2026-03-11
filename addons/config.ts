export const API_ENDPOINT = 'https://scrap-project-1-j2sd.onrender.com/api/scrape/';
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface SiteConfig {
  name: string;
  url: string;
  topicSelector: string;     // Finds the topics on the forum index
  videoLinkSelector: string; // Finds the video hosts inside the topic post
  parse: ($: any) => string[]; // Returns the actual external video URLs
}

export const SITES: SiteConfig[] = [
  {
    name: 'dropmms',
    // Using the .co domain as per your update
    url: 'https://dropmms.co/forum/2-desi-new-videoz-hd-sd/', 
    topicSelector: '.tthumb_grid_item .tthumb_gal_title a',
    videoLinkSelector: '.cPost_contentWrap a[href]',
    parse: ($) => {
      const videoLinks: string[] = [];
      
      // Target only the links inside the post body
      $('.cPost_contentWrap a[href]').each((_: any, el: any) => {
        const href = $(el).attr('href') || '';
        
        // Define what we want to send to the scraper
        const isStreamingHost = /streamtape|vidara|vidoza|vidnest|vidsonic/i.test(href);
        
        // Define what we want to ignore (luluvid + file download hosts)
        const isExcluded = /luluvid|krakenfiles|upfiles|frdl\.io|torupload/i.test(href);
        
        if (isStreamingHost && !isExcluded) {
          videoLinks.push(href);
        }
      });
      
      // Return unique links found in this specific post
      return [...new Set(videoLinks)];
    }
  }
];