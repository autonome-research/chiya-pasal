import type { SourceAdapter, SourceContext, SourceRunResult } from './source-adapter.js';

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter<unknown>>();

  register<TConfig>(adapter: SourceAdapter<TConfig>): this {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`source adapter already registered: ${adapter.name}`);
    }
    this.adapters.set(adapter.name, adapter as SourceAdapter<unknown>);
    return this;
  }

  get(name: string): SourceAdapter<unknown> | undefined {
    return this.adapters.get(name);
  }

  list(): string[] {
    return [...this.adapters.keys()].sort();
  }

  async runAll(
    configs: Record<string, unknown>,
    ctx: SourceContext,
  ): Promise<SourceRunResult[]> {
    const results: SourceRunResult[] = [];
    for (const name of this.list()) {
      const adapter = this.adapters.get(name)!;
      results.push(await adapter.fetch(configs[name], ctx));
    }
    return results;
  }
}
