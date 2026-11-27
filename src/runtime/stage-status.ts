import type {ContextBreakdown} from '../context/breakdown.js';
/** Token totals split so a design can choose what to show: `input` excludes cache reads, `cached` is cache reads, output is generated tokens. */
export interface TokenTotals {readonly input: number; readonly output: number; readonly cached: number}
export interface GitStatus {readonly branch: string; readonly dirty: number; readonly ahead: number; readonly behind: number}
/** Cache facts of one window actor (epoch milliseconds); the countdown is `startedAt + lifetimeMs - now`. */
export interface CacheStatus {
  readonly lifetimeMs: number;
  /** `known`: configured or set by LOGOX (exact countdown); `estimated`: a conservative reading of the provider's documentation (shown with `~`, never warmed). */
  readonly confidence: 'known' | 'estimated';
  /** When the latest request that refreshed the cache started (a real request or a keep-alive warm-up). */
  readonly startedAt: number;
  /** Present while the keep-alive warms this cache: for another actor (`peer`) or for the returning human (`human`, until the away budget ends). */
  readonly keepAlive?: {readonly reason: 'peer' | 'human'; readonly nextWarmAt?: number; readonly until?: number};
}
/** Display snapshots carry public values only: no credentials, model clients or business callbacks. */
export interface StageStatus {
  readonly ownerId: string;
  readonly name: string;
  readonly color?: string;
  readonly model?: {readonly provider: string; readonly model: string};
  /** Table facts about the selected model; unknown fields are omitted. Prices are per million tokens. */
  readonly modelInfo?: {readonly window?: number; readonly maxOutput?: number; readonly currency?: string; readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly subscription?: boolean};
  readonly effort?: string;
  /** Why effort is not a level: `unsupported` (model has no levels) or an error such as an unregistered provider. */
  readonly effortError?: string;
  readonly permission?: string;
  /**
   * `tokens`: last known context size (provider-reported when `estimated` is false); `high`: compaction watermark;
   * `over`: tokens exceed the window.
   */
  readonly context?: {readonly tokens: number; readonly window: number; readonly high?: number; readonly estimated?: boolean; readonly over?: boolean;
    /** Whole tokens per category, summing exactly to `tokens`; absent until a request has been measured. */
    readonly categories?: ContextBreakdown};
  readonly state: string;
  /** Session total across all windows: fresh input plus output (cache reads excluded). */
  readonly tokens?: number;
  readonly usage?: {readonly window: TokenTotals; readonly session: TokenTotals};
  readonly cost?: number;
  readonly costCurrency?: string;
  /** True when some usage could not be priced or a cache rate fell back to the input rate. */
  readonly costPartial?: boolean;
  /** Prompt cache of the window actor; absent while its lifetime is unknown or no request has refreshed it yet. */
  readonly cache?: CacheStatus;
  readonly git?: GitStatus;
  readonly session?: string;
  readonly project?: string;
}
