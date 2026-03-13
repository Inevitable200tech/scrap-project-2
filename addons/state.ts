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
      // This keeps your 512MB DB from ever getting full.
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
   * Helper to convert long URLs into short 32-char MD5 hashes
   */
  private getHash(url: string): string {
    return createHash('md5').update(url).digest('hex');
  }

  /**
   * Checks if URL is new. 
   * Note: This is now ASYNC to save RAM by querying DB directly.
   */
  async isNew(url: string, type: "topic_visited" | "video_host_link"): Promise<boolean> {
    if (!this.collection) return true;

    const hash = this.getHash(url);

    try {
      // Check if hash exists
      const existing = await this.collection.findOne({ hash });
      
      if (existing) {
        return false;
      }

      // If not exists, insert it
      await this.collection.insertOne({
        hash,
        type,
        url: url.substring(0, 500), // Store a snippet for debugging, but hash is for lookup
        createdAt: new Date()
      });

      return true;
    } catch (e) {
      // If a race condition occurs, unique index on 'hash' catches it
      return false;
    }
  }

  async disconnect() {
    await this.client.close();
  }
}