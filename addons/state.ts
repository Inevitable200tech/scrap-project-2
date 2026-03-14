import { MongoClient, Collection } from 'mongodb';
import { createHash } from 'crypto';

export class StateManager {
  private client: MongoClient;
  private collection?: Collection;

  constructor(connectionString: string) {
    this.client = new MongoClient(connectionString);
  }

  /**
   * Initializes connection and sets up database constraints
   */
  async connect() {
    try {
      await this.client.connect();
      const db = this.client.db('scraper_db');
      this.collection = db.collection('visited_urls');
      
      // 1. Create index for high-speed lookups
      await this.collection.createIndex({ hash: 1 }, { unique: true });

      // 2. TTL Index: Automatically delete 'topic_visited' types after 7 days (604800 seconds)
      // This prevents the 512MB free tier from filling up.
      await this.collection.createIndex(
        { createdAt: 1 }, 
        { 
          expireAfterSeconds: 604800, 
          partialFilterExpression: { type: 'topic_visited' } 
        }
      );

      console.log(`[STATE] Connected to MongoDB. Storage optimization active.`);
    } catch (err) {
      console.error(`[STATE CRITICAL] Failed to connect to MongoDB:`, err);
      throw err;
    }
  }

  /**
   * Fetches document counts for the verbose logging in main.ts
   */
  async getStats() {
    if (!this.collection) return { topics: 0, links: 0 };
    
    const [topics, links] = await Promise.all([
      this.collection.countDocuments({ type: 'topic_visited' }),
      this.collection.countDocuments({ type: 'video_host_link' })
    ]);

    return { topics, links };
  }

  /**
   * Helper to convert long URLs into short 32-char MD5 hashes
   */
  private getHash(url: string): string {
    return createHash('md5').update(url).digest('hex');
  }

  /**
   * Checks if URL is new. 
   * Uses direct DB queries to keep RAM usage near zero.
   */
  async isNew(url: string, type: "topic_visited" | "video_host_link"): Promise<boolean> {
    if (!this.collection) return true;

    const hash = this.getHash(url);

    try {
      // Check if hash exists
      const existing = await this.collection.findOne({ hash });
      
      if (existing) {
        // Optimization: If it's an existing topic, we could update the 'createdAt' 
        // to keep it from expiring while it's still active on the front page.
        if (type === 'topic_visited') {
           this.collection.updateOne({ hash }, { $set: { createdAt: new Date() } }).catch(()=>{});
        }
        return false;
      }

      // If not exists, insert it
      await this.collection.insertOne({
        hash,
        type,
        url: url.substring(0, 500), 
        createdAt: new Date()
      });

      return true;
    } catch (e) {
      // Catch duplicate key errors from race conditions
      return false;
    }
  }

  async disconnect() {
    await this.client.close();
  }
}