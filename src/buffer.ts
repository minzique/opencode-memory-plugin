export interface BufferItem {
  text: string;
  context?: string;
}

export interface BufferConfig {
  maxSize: number;
  flushIntervalMs: number;
  onFlush: (items: BufferItem[]) => Promise<void>;
}

/**
 * Batches content items and flushes them either when full or on a timer.
 * Used to batch event content for LLM extraction — avoids one API call per event.
 */
export class ContentBuffer {
  private items: BufferItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private config: BufferConfig;

  constructor(config: BufferConfig) {
    this.config = config;
  }

  add(item: BufferItem): void {
    this.items.push(item);

    if (this.items.length >= this.config.maxSize) {
      this.flush().catch(() => {});
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush().catch(() => {});
      }, this.config.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.items.length === 0) return;

    const batch = this.items.splice(0);
    try {
      await this.config.onFlush(batch);
    } catch {
      // Best-effort: if extraction fails, items are lost. Acceptable for auto-capture.
    }
  }
}
