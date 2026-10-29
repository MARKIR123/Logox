import {useEffect, useRef, useState} from 'react';
import {LoginWizardPanel} from './login-wizard.js';
import {Box, Text, useInput, usePaste} from 'ink';
import {accountProviders, type LoginFlow, type LoginState} from '../../providers/login.js';
import {emptyDraft, erase, graphemes, insert, move, type Draft} from '../input/editor.js';
import {palette} from '../appearance/theme.js';
import {Picker} from '../panels/picker.js';

export function LoginDialog({flow, state, width, height, y, onCursor, onClose, notice = ''}: {
  flow: LoginFlow; state: LoginState; width: number; height: number; y: number; onCursor(position: {x: number; y: number} | undefined): void; onClose(): void;
  notice?: string;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const draftRef = useRef(draft);
  const inputWidth = Math.max(1, width - 6);
  const start = Math.max(0, draft.cursor - inputWidth + 1);
  const isInputPhase = ['key', 'custom_name', 'custom_url', 'custom_key'].includes(state.phase);
  const isMasked = state.phase === 'key' || state.phase === 'custom_key';
  const displayText = isMasked
    ? '•'.repeat(Math.min(inputWidth, [...draft.text].length - start))
    : draft.text.slice(start, start + inputWidth);
  // 编辑既有自定义 provider 时，地址输入框以当前值起步；换阶段才重置，避免打断输入。
  useEffect(() => {
    const seed = state.phase === 'custom_url' ? state.customUrl ?? '' : '';
    draftRef.current = seed ? {text: seed, cursor: graphemes(seed).length} : emptyDraft;
    setDraft(draftRef.current);
  }, [state.phase]);

  const edit = (next: Draft) => {if (isInputPhase && next.text.length <= 16384) {draftRef.current = next; setDraft(next);}};
  if (state.phase !== 'wizard') onCursor(isInputPhase ? {x: Math.min(width - 1, 4 + draft.cursor - start), y: y + 2} : undefined);
  usePaste(text => {if (isInputPhase) edit(insert(draftRef.current, text.trim()));});
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'd') {onClose(); return;}
    if (state.phase === 'wizard') return;
    if (key.escape) {flow.cancel(); return;}
    if (!isInputPhase) return;
    if (key.return) {void flow.submit(draftRef.current.text); return;}
    if (key.backspace || key.delete) {edit(erase(draftRef.current, Boolean(key.backspace))); return;}
    if (key.leftArrow || key.rightArrow) {edit(move(draftRef.current, key.leftArrow ? -1 : 1)); return;}
    if (key.home || key.end) {edit(move(draftRef.current, key.home ? -Infinity : Infinity)); return;}
    if (key.ctrl && input === 'u') {edit(emptyDraft); return;}
    if (!key.ctrl && !key.meta && input) edit(insert(draftRef.current, input));
  });

  if (state.phase === 'wizard') return <LoginWizardPanel flow={flow} state={state} width={width} height={height} y={y}/>;

  if (state.phase === 'provider') return <Picker key={state.phase} title="Providers" description="Enter: log in or edit · Ctrl+X delete · + Add: account or URL" width={width} height={height} y={y}
    items={state.providers.map(row => ({
      id: row.name,
      label: row.name,
      description: row.name === '+ Import'
        ? 'From dsh-tui / Codex store'
        : row.name === '+ Add'
          ? 'Account login or endpoint URL'
          : row.custom
            ? (row.baseUrl ?? '')
            : row.saved ? 'Saved' : 'Not configured',
      ...(row.deletable ? {deletable: true} : {}),
    }))}
    deleteLabel="Delete provider"
    onDelete={name => {void flow.delete(name);}}
    error={state.error} notice={notice} onSelect={name => flow.choose(name)} onCancel={() => flow.cancel()}/>;

  if (state.phase === 'add') return <Picker key={state.phase} title="Add Provider" description="Pick how this provider authenticates" width={width} height={height} y={y}
    items={[
      {id: 'account', label: 'Account login', description: 'ChatGPT account (browser)'},
      {id: 'url', label: 'Custom URL', description: 'Base URL or port + protocol'},
    ]}
    error={state.error} notice={notice}
    onSelect={id => flow.chooseAddMode(id === 'account' ? 'account' : 'url')} onCancel={() => flow.cancel()}/>;

  if (state.phase === 'account') return <Picker key={state.phase} title="Account Login" description="Providers with a browser account flow" width={width} height={height} y={y}
    items={accountProviders.map(name => ({id: name, label: name, description: 'ChatGPT account (browser)'}))}
    error={state.error} notice={notice} onSelect={name => flow.chooseAccount(name)} onCancel={() => flow.cancel()}/>;

  if (state.phase === 'import') return <Picker key={state.phase} title="Import Credential" description="Read-only scan of ~/.codex/auth.json and ~/.dsh/.credentials.yaml; the copy goes to ~/.logox/auth.json" width={width} height={height} y={y}
    items={(state.importables ?? []).map(item => ({id: item.id, label: item.label, description: item.provider + ' · ' + item.kind}))}
    error={state.error} notice={notice} onSelect={id => {void flow.chooseImport(id);}} onCancel={() => flow.cancel()}/>;

  if (state.phase === 'custom_kind') return <Picker key={state.phase} title={(state.editing ? 'Edit Provider' : 'Add Custom Provider') + ' · Step 3/4: Protocol'}
    description="Pick the wire protocol this endpoint speaks" current={state.customKind ?? ''} width={width} height={height} y={y}
    items={[
      {id: 'openai_compat', label: 'OpenAI-compatible', description: '/v1/chat/completions · most reverse proxies'},
      {id: 'anthropic', label: 'Anthropic Messages', description: '/v1/messages · Claude-compatible endpoints'},
    ]}
    error={state.error} notice={notice}
    onSelect={id => flow.chooseCustomKind(id === 'anthropic' ? 'anthropic' : 'openai_compat')} onCancel={() => flow.cancel()}/>;

  if (state.phase === 'method' && state.methods) return <Picker key={state.phase} title={state.provider + ' · Authentication Method'} description="Choose API Key or browser account authorization" width={width} height={height} y={y}
    items={state.methods.map(method => ({id: method.id, label: method.label}))}
    error={state.error} notice={notice} onSelect={id => flow.chooseMethod(id as 'key' | 'oauth')} onCancel={() => flow.cancel()}/>;

  if (state.phase === 'oauth') return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{'OpenAI Account Authorization'}</Text>
    <Text color={palette.fg}>❯ Please open the following link in your browser to complete authorization:</Text>
    <Text color={palette.accent} wrap="truncate-end">{state.oauthUrl || 'Generating authorization link…'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || 'Esc Cancel'}</Text>
  </Box>;

  if (state.phase === 'custom_name') return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{'Add Custom Provider · Step 1/4: Name'}</Text>
    <Text color={palette.fg}>❯ {displayText || 'Enter provider identifier (e.g. antigravity, my-proxy)'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || 'Enter Next · Esc Cancel'}</Text>
  </Box>;

  if (state.phase === 'custom_url') return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{(state.editing ? 'Edit Provider' : 'Add Custom Provider') + ' · Step 2/4: Address or Port'}</Text>
    <Text color={palette.fg}>❯ {displayText || 'Enter port (e.g. 8045) or full URL (e.g. http://127.0.0.1:8045/v1)'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || (state.editing ? 'Current address prefilled · Enter Next · Esc Cancel' : 'Enter Next · Esc Cancel')}</Text>
  </Box>;

  if (state.phase === 'custom_key') return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{(state.editing ? 'Edit Provider' : 'Add Custom Provider') + ' · Step 4/4: API Key (Optional)'}</Text>
    <Text color={palette.fg}>❯ {displayText || (state.editing ? 'Enter to keep the saved key' : 'Enter API key (press Enter to skip for local reverse proxy)')}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || 'Enter Save · Esc Cancel'}</Text>
  </Box>;

  return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{'Log In ' + state.provider + ' · API Key'}</Text>
    <Text color={palette.fg}>❯ {state.phase === 'saving' ? 'Saving…' : displayText || 'Enter or paste API key'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{notice || state.error || 'Enter Save · Esc Cancel · Loaded automatically on restart'}</Text>
  </Box>;
}
