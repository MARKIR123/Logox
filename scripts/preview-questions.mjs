// Standalone acceptance preview; never starts Logox, an agent, networking or real authentication.
// npm run build; node scripts/preview-questions.mjs [--scene login]
if (process.argv.includes('--snapshot')) process.env.FORCE_COLOR = '3';
const {runQuestionPreview} = await import('../dist/src/tui/previews/question-preview.js');
await runQuestionPreview();
