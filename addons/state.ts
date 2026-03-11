import fs from 'fs/promises';
import path from 'path';

const STORAGE_FILE = path.join(process.cwd(), 'previous-topics.json');

export class StateManager {
  private seenKeys: Set<string> = new Set();

  async load() {
    try {
      const data = await fs.readFile(STORAGE_FILE, 'utf-8');
      this.seenKeys = new Set(JSON.parse(data));
      console.log(`[STATE] Loaded ${this.seenKeys.size} keys.`);
    } catch {
      console.log('[STATE] Fresh start.');
    }
  }

  async save() {
    await fs.writeFile(STORAGE_FILE, JSON.stringify([...this.seenKeys], null, 2));
  }

  isNew(link: string, title: string): boolean {
    const key = `${link}|${title.trim()}`;
    if (this.seenKeys.has(key)) return false;
    this.seenKeys.add(key);
    return true;
  }
}