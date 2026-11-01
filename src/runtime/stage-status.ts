/** Display snapshots carry public values only: no credentials, model clients or business callbacks. */
export interface StageStatus {
  readonly ownerId: string;
  readonly name: string;
  readonly color?: string;
  readonly model?: {readonly provider: string; readonly model: string};
  readonly effort?: string;
  readonly permission?: string;
  readonly context?: {readonly tokens: number; readonly window: number};
  readonly state: string;
  readonly tokens?: number;
  readonly cost?: number;
  readonly costCurrency?: string;
  readonly session?: string;
  readonly project?: string;
}
