import type {PanelQuestion, QuestionSelection} from '../interactions/question-panel.js';

export interface PreviewProviderChange {
  readonly action: 'added' | 'updated' | 'deleted' | 'signed-in' | 'signed-out';
  readonly route: string;
  readonly field?: string;
  readonly endpoint?: string;
  readonly protocol?: string;
  readonly models?: readonly string[];
  readonly hasKey?: boolean;
}
export interface ProviderPreviewDeps {
  readonly ask: (questions: readonly PanelQuestion[]) => Promise<readonly QuestionSelection[] | null>;
  /** Receives safe metadata only, never the credential text. */
  readonly commit: (change: PreviewProviderChange) => void;
}

type Sample = {
  route: string;
  custom: boolean;
  endpoint: string;
  protocol: string;
  models: readonly string[];
};
// These are demonstration records, not imported configuration or remote discovery results.
const samples: readonly Sample[] = [
  {route: 'deepseek', custom: false, endpoint: 'https://api.deepseek.com', protocol: 'openai-completions', models: ['deepseek-chat']},
  {route: 'openai', custom: false, endpoint: 'https://api.openai.com/v1', protocol: 'openai-completions', models: ['demo-model-a']},
  {route: 'anthropic', custom: false, endpoint: 'https://api.anthropic.com', protocol: 'anthropic', models: ['demo-model-a']},
  {route: 'local-gateway', custom: true, endpoint: 'http://127.0.0.1:8045/v1', protocol: 'openai-completions', models: ['demo-model-a']},
];
const modelSamples = ['demo-model-a', 'demo-model-b'];
const question = (text: string, extra: Partial<PanelQuestion> = {}): PanelQuestion =>
  ({header: 'Providers', question: text, inputLabel: 'Input', ...extra});
const choices = (text: string, labels: readonly string[]): PanelQuestion =>
  question(text, {options: labels.map(label => ({label})), hideCustomInput: true});
const protocolQuestion = (): PanelQuestion => question('Choose the wire protocol', {
  hideCustomInput: true,
  options: [{label: 'Chat Completions', description: 'OpenAI-compatible chat completions'},
    {label: 'Responses', description: 'OpenAI-compatible Responses API'},
    {label: 'Anthropic Messages', description: 'Anthropic-compatible messages'}],
});
const selected = (answer: QuestionSelection): string => answer.selected[0] ?? answer.custom?.trim() ?? '';
const distinct = (items: readonly string[]): string[] => [...new Set(items.map(item => item.trim()).filter(Boolean))];
function modelsFrom(answer: QuestionSelection): string[] {
  return distinct([...answer.selected, ...(answer.custom ?? '').split(/[\s,]+/u)]);
}
function parseProtocol(answer: QuestionSelection): string | null {
  const value = selected(answer);
  if (['Chat Completions', 'openai-completions', 'completions'].includes(value)) return 'openai-completions';
  if (['Responses', 'openai-responses', 'responses'].includes(value)) return 'openai-responses';
  if (['Anthropic Messages', 'anthropic', 'anthropic-messages'].includes(value)) return 'anthropic';
  return null;
}
function parseEndpoint(input: string): string | null {
  const text = input.trim();
  if (/^\d{1,5}$/u.test(text)) {
    const port = Number(text);
    return port > 0 && port <= 65535 ? 'http://127.0.0.1:' + port + '/v1' : null;
  }
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? text : null;
  } catch {return null;}
}

/** An inert, lazy demonstration: only the requested next question is materialized. */
export async function runProviderPreview(deps: ProviderPreviewDeps): Promise<void> {
  const askBatch = async (questions: readonly PanelQuestion[]): Promise<readonly QuestionSelection[] | null> => {
    const answers = await deps.ask(questions);
    if (!answers || answers.length !== questions.length || answers.some(answer => ['Cancel', '__cancel'].includes(selected(answer)))) return null;
    return answers;
  };
  const ask = async (item: PanelQuestion): Promise<QuestionSelection | null> => (await askBatch([item]))?.[0] ?? null;
  const chooseModels = (sample: Sample, editing: boolean): Promise<QuestionSelection | null> => ask(question('Select the models to enable', {
    multiSelect: true,
    allowEmpty: !sample.custom,
    options: distinct([...modelSamples, ...sample.models]).map(label => ({label})),
    defaultSelected: editing ? sample.models : [],
    detail: sample.custom ? 'Fixed sample models; you may also enter names separated by spaces or commas.'
      : 'Leave empty to enable the whole catalog. Discovery is simulated.',
  }));
  const metadata = (sample: Sample): Pick<PreviewProviderChange, 'route' | 'endpoint' | 'protocol' | 'models'> =>
    ({route: sample.route, endpoint: sample.endpoint, protocol: sample.protocol, models: [...sample.models]});

  const entry = await ask(choices('Manage providers', ['Add a new provider', 'Edit an existing provider']));
  if (!entry) return;
  if (selected(entry) === 'Add a new provider') {
    const source = await ask(choices('Choose a provider source', ['Built-in provider', 'Custom API endpoint', 'Account sign-in']));
    if (!source) return;
    if (selected(source) === 'Account sign-in') {
      const account = await ask(choices('Choose an account provider', ['OpenAI / ChatGPT', 'Cancel']));
      if (!account || !['OpenAI / ChatGPT', 'openai'].includes(selected(account))) return;
      const action = await ask(question('OpenAI account: signed in (simulated)', {
        detail: 'Preview only. No browser, OAuth request, or credential file will be used.',
        hideCustomInput: true, options: [{label: 'Sign in again'}, {label: 'Sign out'}, {label: 'Cancel'}],
      }));
      if (!action) return;
      if (selected(action) === 'Sign in again') deps.commit({action: 'signed-in', route: 'openai'});
      else if (selected(action) === 'Sign out') deps.commit({action: 'signed-out', route: 'openai'});
      return;
    }
    let sample: Sample;
    let hasKey = false;
    if (selected(source) === 'Custom API endpoint') {
      const name = await ask(question('Enter a route name', {detail: 'Choose a new route name. Use Edit for an existing sample provider.'}));
      if (!name) return;
      const route = selected(name);
      if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(route)) return;
      if (samples.some(sample => sample.route === route)) return;
      // Reduce the secret immediately to presence. It is never retained in a sample or change record.
      const key = await ask(question('Enter the API key', {secret: true, allowEmpty: true, detail: 'Use a fake key only. This field is optional.'}));
      if (!key) return;
      hasKey = Boolean(selected(key));
      const connection = await askBatch([question('Enter the base URL or port'), protocolQuestion()]);
      if (!connection) return;
      const endpoint = parseEndpoint(selected(connection[0]!));
      const protocol = parseProtocol(connection[1]!);
      if (!endpoint || !protocol) return;
      sample = {route, custom: true, endpoint, protocol, models: []};
    } else if (selected(source) === 'Built-in provider') {
      const builtIn = await ask(choices('Choose a built-in provider', samples.filter(sample => !sample.custom).map(sample => sample.route)));
      if (!builtIn) return;
      const fixture = samples.find(sample => !sample.custom && sample.route === selected(builtIn));
      if (!fixture) return;
      sample = {...fixture, models: []};
      const key = await ask(question('Enter the API key', {secret: true, detail: 'Use a fake key only. No authentication will be attempted.'}));
      if (!key || !selected(key)) return;
      hasKey = true;
      const endpoint = await ask(question('Choose the base URL', {
        options: [{label: 'Use default endpoint', description: sample.endpoint}],
      }));
      if (!endpoint) return;
      if (selected(endpoint) !== 'Use default endpoint') {
        const parsed = parseEndpoint(selected(endpoint));
        if (!parsed) return;
        sample = {...sample, endpoint: parsed};
      }
    } else return;
    const modelAnswer = await chooseModels(sample, false);
    if (!modelAnswer) return;
    sample = {...sample, models: modelsFrom(modelAnswer)};
    if (sample.custom && !sample.models.length) return;
    const confirmation = await ask(question('Write this provider configuration?', {
      hideCustomInput: true, options: [{label: 'Write and enable'}, {label: 'Cancel'}],
      detail: [sample.route, sample.endpoint, sample.protocol, sample.models.join(', ') || 'Whole catalog', hasKey ? 'Fake key supplied' : 'No key supplied'].join(' · '),
    }));
    if (confirmation && selected(confirmation) === 'Write and enable') deps.commit({action: 'added', ...metadata(sample), hasKey});
    return;
  }
  if (selected(entry) !== 'Edit an existing provider') return;
  const provider = await ask(choices('Choose a provider to edit', samples.map(sample => sample.route)));
  if (!provider) return;
  const fixture = samples.find(sample => sample.route === selected(provider));
  if (!fixture) return;
  const target = await ask(choices('Choose one field to edit', ['API key', ...(fixture.custom ? ['Base URL', 'Wire protocol'] : []), 'Model list', 'Delete provider']));
  if (!target) return;
  const field = selected(target);
  switch (field) {
    case 'API key': {
      const key = await ask(question('Enter the API key', {secret: true, allowEmpty: true, detail: 'Use a fake key; leave empty to keep the current key.'}));
      if (key && selected(key)) deps.commit({action: 'updated', route: fixture.route, field, hasKey: true});
      return;
    }
    case 'Base URL': {
      if (!fixture.custom) return;
      const answer = await ask(question('Enter the base URL or port', {allowEmpty: true}));
      if (!answer) return;
      const endpoint = parseEndpoint(selected(answer));
      if (endpoint && endpoint !== fixture.endpoint) deps.commit({action: 'updated', ...metadata({...fixture, endpoint}), field});
      return;
    }
    case 'Wire protocol': {
      if (!fixture.custom) return;
      const answer = await ask(protocolQuestion());
      if (!answer) return;
      const protocol = parseProtocol(answer);
      if (protocol && protocol !== fixture.protocol) deps.commit({action: 'updated', ...metadata({...fixture, protocol}), field});
      return;
    }
    case 'Model list': {
      const answer = await chooseModels(fixture, true);
      if (!answer) return;
      const models = modelsFrom(answer);
      if (fixture.custom && !models.length) return;
      if (models.length === fixture.models.length && models.every(model => fixture.models.includes(model))) return;
      deps.commit({action: 'updated', ...metadata({...fixture, models}), field});
      return;
    }
    case 'Delete provider': {
      const confirmation = await ask(choices('Delete this provider?', ['Delete provider', 'Cancel']));
      if (confirmation && selected(confirmation) === 'Delete provider') deps.commit({action: 'deleted', route: fixture.route});
      return;
    }
  }
}
