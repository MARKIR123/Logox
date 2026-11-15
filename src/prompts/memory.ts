/** The static memory section every actor's system prompt carries (built once per session by `src/app/anamnesis.ts`, so the prompt prefix stays byte-identical). */
export const MEMORY_SECTION = `# Memory

Long-term memory is two folders of Markdown records: \`{{projectMemoryDir}}\` (this project) and \`{{userMemoryDir}}\` (every project of this user). Anamnesis reviews the session while it is idle and keeps them up to date. The records known at the start of this session are listed below. \`Read\` a record when its line is relevant to what you are doing.

- A record states what was true when it was written. Before you rely on a file, function or flag it names, check that it still exists.
- When the user explicitly asks you to remember something, save it at once: \`Write\` one file \`<name>.md\` (a short kebab-case name) into the fitting folder, starting with a frontmatter block that holds \`name\`, \`description\` (one line) and \`metadata.type\` (\`user\`, \`feedback\`, \`project\` or \`reference\`), followed by the fact. Leave \`MEMORY.md\` alone; it is rebuilt from the records.
- The user removes records under \`/anamnesis\`.

{{records}}`;
export const MEMORY_EMPTY_LINE = 'No records yet.';
export const MEMORY_RECORD_LIMIT = 60;
export interface MemoryLine {readonly scope: string; readonly name: string; readonly type: string; readonly description: string}

/** The section for the records known now; `records` arrive in their stable order. */
export function memorySection(input: {projectMemoryDir: string; userMemoryDir: string; records: readonly MemoryLine[]}): string {
  const shown = input.records.slice(0, MEMORY_RECORD_LIMIT).map(record =>
    '- ' + record.scope + '/' + record.name + '.md (' + record.type + '): ' + record.description.replace(/\s+/g, ' ').trim());
  const more = input.records.length - shown.length;
  const lines = shown.length ? [...shown, ...more > 0 ? ['- … ' + more + ' more records in the folders above'] : []] : [MEMORY_EMPTY_LINE];
  return MEMORY_SECTION.replace('{{projectMemoryDir}}', () => input.projectMemoryDir).replace('{{userMemoryDir}}', () => input.userMemoryDir)
    .replace('{{records}}', () => lines.join('\n'));
}
