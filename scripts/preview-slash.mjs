// Standalone acceptance preview; never starts the Logox application or an agent.
// Build first: npm run build
if (process.argv.includes('--snapshot')) process.env.FORCE_COLOR = '3';
const {runSlashPreview} = await import('../dist/src/tui/previews/slash-preview.js');
await runSlashPreview();
