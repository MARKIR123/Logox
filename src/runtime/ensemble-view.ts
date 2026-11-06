/** Public data behind the /ensemble page: plain values only, so the renderer never touches the catalog, registry or disk layout. */
export interface EnsembleToolParam {readonly name: string; readonly type: string; readonly required: boolean; readonly description: string}
export interface EnsembleTool {
  readonly name: string;
  /** Folder path under the tool directory: `[]` for a core tool, `['coordination']`, or `['mcp:playwright']` for an MCP server. */
  readonly folder: readonly string[];
  /** First line of the description. */
  readonly summary: string;
  /** The description exactly as the model reads it (Markdown). */
  readonly description: string;
  readonly params: readonly EnsembleToolParam[];
  /** `eager` tools carry their full contract; `deferred` ones load on demand. */
  readonly loading: 'eager' | 'deferred';
  /** Who gets the tool, in words (`everyone`, `Director only`, `Kalon, Techne`). */
  readonly roles: string;
  readonly visibility: 'card' | 'notice' | 'silent';
  readonly source: 'builtin' | 'mcp';
}
export interface EnsembleSkill {
  readonly name: string; readonly description: string; readonly path: string;
  readonly scope: 'built-in' | 'user' | 'project';
  /** Folders between the scope root and the file (`['techne', 'browser']`). */
  readonly folder: readonly string[];
}
export interface EnsemblePrompt {
  readonly id: 'persona' | 'execution' | 'collaboration' | 'memory';
  readonly heading: string; readonly file: string; readonly text: string;
  /** A project-level file extends the user-level one; `text` is the merged result. */
  readonly project: boolean;
  /** The file `e` opens for this section, when one exists on disk. */
  readonly path?: string;
}
export interface EnsembleStats {
  readonly completed: number; readonly failed: number; readonly toolCalls: number; readonly toolsFailed: number; readonly approvals: number;
  readonly tokensIn: number; readonly tokensOut: number; readonly cost?: string;
}
export interface EnsembleActor {
  readonly id: string; readonly name: string; readonly title: string; readonly glyph: string; readonly color: string; readonly description: string;
  /** `<model> · <thinking>` and where it comes from. */
  readonly model: {readonly text: string; readonly source: 'set' | 'follows'};
  /** One human sentence from the context policy. */
  readonly context: string;
  /** User-level profile directory, and the project-level one when a project persona extends it. */
  readonly userPath: string; readonly projectPath?: string;
  readonly tools: readonly EnsembleTool[];
  readonly skills: readonly EnsembleSkill[];
  readonly stats: EnsembleStats;
  readonly prompts: readonly EnsemblePrompt[];
}
export interface EnsembleData {readonly actors: readonly EnsembleActor[]; readonly initial?: string}
