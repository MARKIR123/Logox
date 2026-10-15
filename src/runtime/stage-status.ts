/** 展示快照仅携带公开值，不携带凭据、模型客户端或业务回调。 */
export interface StageStatus {
  readonly ownerId: string;
  readonly name: string;
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
