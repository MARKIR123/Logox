import type {RuntimeStore} from './store.js';

/**
 * Roots whose final report the Director has already delivered with no dispatched work still open.
 * In-memory per store: a later wake for the same root (a late report) asks for only what changed.
 */
export class FinalReports {
  private readonly roots = new Set<string>();
  has(root: string): boolean {return this.roots.has(root);}
  mark(root: string): void {this.roots.add(root);}
  clear(root: string): void {this.roots.delete(root);}
}

const registries = new WeakMap<RuntimeStore, FinalReports>();

export function finalReportsFor(store: RuntimeStore): FinalReports {
  let reports = registries.get(store);
  if (!reports) {reports = new FinalReports(); registries.set(store, reports);}
  return reports;
}
