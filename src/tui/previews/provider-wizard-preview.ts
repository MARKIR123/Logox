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
  /** A provider of the user's own (custom endpoint) rather than a built-in template. */
  custom: boolean;
  /** Set up already: opens an edit menu; an unset built-in opens the add flow. */
  setUp: boolean;
  /** Account-only provider (browser sign-in), listed under Account sign-in only. */
  account?: boolean;
  /** The account provider an API-key template points at; its sign-in shows as a hint on this entry. */
  sibling?: string;
  endpoint: string;
  protocol: string;
  models: readonly string[];
};
// These are demonstration records, not imported configuration or remote discovery results.
const samples: readonly Sample[] = [
  {route: 'deepseek', custom: false, setUp: true, endpoint: 'https://api.deepseek.com', protocol: 'openai-completions', models: ['deepseek-chat']},
  {route: 'openai', custom: false, setUp: false, sibling: 'openai-auth', endpoint: 'https://api.openai.com/v1', protocol: 'openai-completions', models: ['demo-model-a']},
  {route: 'openai-auth', custom: false, setUp: true, account: true, endpoint: 'https://api.openai.com/v1', protocol: 'openai-responses', models: ['demo-model-a']},
  {route: 'anthropic', custom: false, setUp: false, endpoint: 'https://api.anthropic.com', protocol: 'anthropic', models: ['demo-model-a']},
  {route: 'local-gateway', custom: true, setUp: true, endpoint: 'http://127.0.0.1:8045/v1', protocol: 'openai-completions', models: ['demo-model-a']},
];
const modelSamples = ['demo-model-a', 'demo-model-b'];
const question = (text: string, extra: Partial<PanelQuestion> = {}): PanelQuestion =>
  ({header: 'Providers', question: text, inputLabel: 'Input', ...extra});
const choices = (text: string, labels: readonly string[]): PanelQuestion =>
  question(text, {options: labels.map(label => ({label})), hideCustomInput: true});
/** The list rows the way `/login` draws them: origin, then the credential state (a signed-in account sibling is only a hint, in the info tone). */
function providerOption(sample: Sample, accountList: boolean): NonNullable<PanelQuestion['options']>[number] {
  const origin = {text: sample.custom ? 'custom' : 'built-in', tone: 'dim'} as const;
  const sibling = samples.find(item => item.route === sample.sibling);
  const state = !sample.setUp ? undefined : accountList ? '✓ account' : '✓ signed in';
  return {label: sample.route, ...(sample.custom ? {description: sample.endpoint} : {}), badge: state
    ? [origin, {text: ' · ', tone: 'dim'}, {text: state, tone: 'success'}]
    : sibling?.setUp ? [origin, {text: ' · ', tone: 'dim'}, {text: 'account signed in', tone: 'info'}] : [origin]};
}
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

  const CUSTOM = 'Custom endpoint';
  const method = await ask(choices('Choose a sign-in method', ['API key', 'Account sign-in']));
  if (!method) return;
  if (selected(method) === 'Account sign-in') {
    const accounts = samples.filter(sample => sample.account);
    const account = await ask(question('Choose an account provider', {hideCustomInput: true, options: accounts.map(sample => providerOption(sample, true))}));
    const fixture = accounts.find(sample => sample.route === (account ? selected(account) : ''));
    if (!fixture) return;
    if (!fixture.setUp) {deps.commit({action: 'signed-in', route: fixture.route}); return;}
    const action = await ask(choices('Choose one field to edit', ['Sign in again', 'Model list', 'Delete provider']));
    if (!action) return;
    switch (selected(action)) {
      case 'Sign in again': deps.commit({action: 'signed-in', route: fixture.route}); return;
      case 'Model list': {
        const answer = await chooseModels(fixture, true);
        if (!answer) return;
        const models = modelsFrom(answer);
        if (models.length === fixture.models.length && models.every(model => fixture.models.includes(model))) return;
        deps.commit({action: 'updated', ...metadata({...fixture, models}), field: 'Model list'});
        return;
      }
      case 'Delete provider': {
        const confirmation = await ask(choices('Delete this provider?', ['Delete provider', 'Cancel']));
        if (confirmation && selected(confirmation) === 'Delete provider') deps.commit({action: 'deleted', route: fixture.route});
        return;
      }
    }
    return;
  }
  if (selected(method) !== 'API key') return;
  // One list: every API-key template, then the user's own providers, then the entry that starts a custom endpoint.
  const keyed = samples.filter(sample => !sample.account);
  const chosen = await ask(question('Choose a provider', {hideCustomInput: true,
    options: [...keyed.map(sample => providerOption(sample, false)), {label: CUSTOM, description: 'Any OpenAI- or Anthropic-compatible URL with an API key'}]}));
  if (!chosen) return;
  if (selected(chosen) === CUSTOM) {
    const name = await ask(question('Enter a route name', {detail: 'Choose a new route name. Choose the existing provider in the list to edit it.'}));
    if (!name) return;
    const route = selected(name);
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(route)) return;
    if (samples.some(sample => sample.route === route)) return;
    // Reduce the secret immediately to presence. It is never retained in a sample or change record.
    const key = await ask(question('Enter the API key', {secret: true, allowEmpty: true, detail: 'Use a fake key only. This field is optional.'}));
    if (!key) return;
    const hasKey = Boolean(selected(key));
    const connection = await askBatch([question('Enter the base URL or port'), protocolQuestion()]);
    if (!connection) return;
    const endpoint = parseEndpoint(selected(connection[0]!));
    const protocol = parseProtocol(connection[1]!);
    if (!endpoint || !protocol) return;
    await finishAdd({route, custom: true, setUp: false, endpoint, protocol, models: []}, hasKey);
    return;
  }
  const fixture = keyed.find(sample => sample.route === selected(chosen));
  if (!fixture) return;
  if (!fixture.setUp) {
    // An unset built-in template: the base URL (default pre-filled), then the key.
    let sample: Sample = {...fixture, models: []};
    const endpoint = await ask(question('Choose the base URL', {options: [{label: 'Use default endpoint', description: sample.endpoint}]}));
    if (!endpoint) return;
    if (selected(endpoint) !== 'Use default endpoint') {
      const parsed = parseEndpoint(selected(endpoint));
      if (!parsed) return;
      sample = {...sample, endpoint: parsed};
    }
    const key = await ask(question('Enter the API key', {secret: true, detail: 'Use a fake key only. No authentication will be attempted.'}));
    if (!key || !selected(key)) return;
    await finishAdd(sample, true);
    return;
  }
  const target = await ask(choices('Choose one field to edit', ['API key', 'Base URL', 'Wire protocol', 'Model list', 'Delete provider']));
  if (!target) return;
  const field = selected(target);
  switch (field) {
    case 'API key': {
      const key = await ask(question('Enter the API key', {secret: true, allowEmpty: true, detail: 'Use a fake key; leave empty to keep the current key.'}));
      if (key && selected(key)) deps.commit({action: 'updated', route: fixture.route, field, hasKey: true});
      return;
    }
    case 'Base URL': {
      const answer = await ask(question('Enter the base URL or port', {allowEmpty: true}));
      if (!answer) return;
      const endpoint = parseEndpoint(selected(answer));
      if (endpoint && endpoint !== fixture.endpoint) deps.commit({action: 'updated', ...metadata({...fixture, endpoint}), field});
      return;
    }
    case 'Wire protocol': {
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

  /** Models, then the final confirmation; shared by the template add flow and the custom endpoint flow. */
  async function finishAdd(chosenSample: Sample, hasKey: boolean): Promise<void> {
    const modelAnswer = await chooseModels(chosenSample, false);
    if (!modelAnswer) return;
    const sample = {...chosenSample, models: modelsFrom(modelAnswer)};
    if (sample.custom && !sample.models.length) return;
    const confirmation = await ask(question('Write this provider configuration?', {
      hideCustomInput: true, options: [{label: 'Write and enable'}, {label: 'Cancel'}],
      detail: [sample.route, sample.endpoint, sample.protocol, sample.models.join(', ') || 'Whole catalog', hasKey ? 'Fake key supplied' : 'No key supplied'].join(' · '),
    }));
    if (confirmation && selected(confirmation) === 'Write and enable') deps.commit({action: 'added', ...metadata(sample), hasKey});
  }
}
