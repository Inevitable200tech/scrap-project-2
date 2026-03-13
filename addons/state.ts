import { MongoClient, Collection } from 'mongodb';

export class StateManager {
  private client: MongoClient;
  private collection?: Collection;
  private cache: Set<string> = new Set(); // Local cache for speed

  constructor(connectionString: string) {
    this.client = new MongoClient(connectionString);
  }

  async connect() {
    await this.client.connect();
    const db = this.client.db('scraper_db');
    this.collection = db.collection('visited_urls');
    
    // Load existing URLs into a local Set once to keep checks fast
    const existing = await this.collection.find({}).toArray();
    existing.forEach(item => this.cache.add(item.url));
    console.log(`[STATE] Connected to MongoDB. Loaded ${this.cache.size} known URLs.`);
  }

  isNew(url: string, type: "topic_visited" | "video_host_link"): boolean {
    if (this.cache.has(url)) return false;
    
    // Add to local cache and queue for DB
    this.cache.add(url);
    this.saveToDb(url, type);
    return true;
  }

  private async saveToDb(url: string, type: string) {
    try {
      await this.collection?.updateOne(
        { url }, 
        { $set: { url, type, createdAt: new Date() } }, 
        { upsert: true }
      );
    } catch (e) {
      console.error(`[STATE ERR] DB Save failed: ${e}`);
    }
  }

  async disconnect() {
    await this.client.close();
  }
}