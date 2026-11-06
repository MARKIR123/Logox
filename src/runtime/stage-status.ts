/** Token totals split so a design can choose what to show: `input` excludes cache reads, `cached` is cache reads, output is generated tokens. */
export interface TokenTotals {readonly input: number; readonly output: number; readonly cached: number}
export interface GitStatus {readonly branch: string; readonly dirty: number; readonly ahead: number; readonly behind: number}
/** Display snapshots carry public values only: no credentials, model clients or business callbacks. */
export interface StageStatus {
  readonly ownerId: string;
  readonly name: string;
  readonly color?: string;
  readonly model?: {readonly provider: string; readonly model: string};
  readonly effort?: string;
  /** Why effort is not a level: `unsupported` (model has no levels) or an error such as an unregistered provider. */
  readonly effortError?: string;
  readonly permission?: string;
  /**
   * `tokens`: last known context size (provider-reported when `estimated` is false); `high`: compaction watermark;
   * `over`: tokens exceed the window.
   */
  readonly context?: {readonly tokens: number; readonly window: number; readonly high?: number; readonly estimated?: boolean; readonly over?: boolean};
  readonly state: string;
  /** Session total across all windows: fresh input plus output (cache reads excluded). */
  readonly tokens?: number;
  readonly usage?: {readonly window: TokenTotals; readonly session: TokenTotals};
  readonly cost?: number;
  readonly costCurrency?: string;
  /** True when some usage could not be priced or a cache rate fell back to the input rate. */
  readonly costPartial?: boolean;
  readonly git?: GitStatus;
  readonly session?: string;
  readonly project?: string;
}
