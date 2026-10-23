/**
 * Formats system prompt instructions for using the scratchpad directory.
 * Modeled after Claude Code's scratchpad instructions.
 */
export function getScratchpadPromptSection(scratchpadDir: string): string {
  return `# Scratchpad Directory
Always use this directory for temporary probe scripts, calculations, and intermediate files instead of the project directory:
\`${scratchpadDir}\``;
}
