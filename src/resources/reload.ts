import type {Resources, ResourceSnapshot} from './manager.js';

const promptRevision = (snapshot: ResourceSnapshot) => JSON.stringify({guidelines: snapshot.guidelines, skills: snapshot.skills, categories: snapshot.categories});
export async function reloadResources(resources: Resources, validateConfig: () => Promise<unknown>) {
  const before = promptRevision(resources.snapshot());
  const snapshot = await resources.reload();
  const prefixChanged = before !== promptRevision(snapshot);
  const labels = {guidelines: 'Guidelines', skills: 'Skills', commands: 'Commands'};
  const report = (Object.keys(labels) as (keyof typeof labels)[]).map(kind => {
    const issues = snapshot.issues.filter(item => item.kind === kind);
    return labels[kind] + ': loaded ' + snapshot[kind].length + (issues.length ? '; failed ' + issues.length + '\n' +
      issues.map(item => item.path + ' · ' + item.reason).join('\n') : '; scan complete.');
  });
  try {await validateConfig(); report.push('Configuration: validation passed; active settings unchanged.');}
  catch {report.push('Configuration: validation failed; check config.toml. Active settings unchanged.');}
  return {prefixChanged, text: report.join('\n') + '\nProvider, MCP, hooks and extension code changes require a restart.' +
    (prefixChanged ? '\nPrompt resources updated; token estimates invalidated. History and checkpoints retained.' : '\nPrompt resources unchanged.')};
}
