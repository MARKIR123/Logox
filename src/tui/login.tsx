import {useState} from 'react';
import {Box, Text, useInput, usePaste} from 'ink';
import type {LoginFlow, LoginState} from '../providers/login.js';
import {emptyDraft, erase, insert, move, type Draft} from './editor.js';
import {palette} from './cards.js';
import {Picker} from './picker.js';

export function LoginDialog({flow, state, width, height, y, onCursor, onClose, notice = ''}: {
  flow: LoginFlow; state: LoginState; width: number; height: number; y: number; onCursor(position: {x: number; y: number} | undefined): void; onClose(): void;
  notice?: string;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const inputWidth = Math.max(1, width - 6);
  const start = Math.max(0, draft.cursor - inputWidth + 1);
  const isInputPhase = ['key', 'custom_name', 'custom_url', 'custom_key'].includes(state.phase);
  const isMasked = state.phase === 'key' || state.phase === 'custom_key';
  const displayText = isMasked
    ? '•'.repeat(Math.min(inputWidth, [...draft.text].length - start))
    : draft.text.slice(start, start + inputWidth);

  const edit = (next: Draft) => {if (isInputPhase && next.text.length <= 16384) setDraft(next);};
  onCursor(isInputPhase ? {x: Math.min(width - 1, 4 + draft.cursor - start), y: y + 2} : undefined);
  usePaste(text => edit(insert(draft, text.trim())));
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'd') {onClose(); return;}
    if (state.phase === 'saving' || state.phase === 'provider' || state.phase === 'method') return;
    if (key.escape) {setDraft(emptyDraft); flow.cancel(); return;}
    if (key.return) {const value = draft.text; setDraft(emptyDraft); void flow.submit(value); return;}
    if (key.backspace || key.delete) {edit(erase(draft, Boolean(key.backspace))); return;}
    if (key.leftArrow || key.rightArrow) {edit(move(draft, key.leftArrow ? -1 : 1)); return;}
    if (key.home || key.end) {edit(move(draft, key.home ? -Infinity : Infinity)); return;}
    if (key.ctrl && input === 'u') {setDraft(emptyDraft); return;}
    if (!key.ctrl && !key.meta && input) edit(insert(draft, input));
  });

  if (state.phase === 'provider') return <Picker title="Log In Provider · API Key" description="Saved credentials will be read automatically on restart" width={width} height={height} y={y}
    items={state.providers.map(provider => ({id: provider.name, label: provider.name, description: provider.saved ? 'Saved' : ''}))}
    error={state.error} notice={notice} onSelect={name => flow.choose(name)} onCancel={() => flow.cancel()}/>;

  if (state.phase === 'method' && state.methods) return <Picker title={state.provider + ' · Authentication Method'} description="Choose API Key or browser account authorization" width={width} height={height} y={y}
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
    <Text bold color={palette.accent}>{'Add Custom Provider · Step 1/3: Name'}</Text>
    <Text color={palette.fg}>❯ {displayText || 'Enter provider identifier (e.g. antigravity, my-proxy)'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || 'Enter Next · Esc Cancel'}</Text>
  </Box>;

  if (state.phase === 'custom_url') return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{'Add Custom Provider · Step 2/3: Address or Port'}</Text>
    <Text color={palette.fg}>❯ {displayText || 'Enter port (e.g. 8045) or full URL (e.g. http://127.0.0.1:8045/v1)'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || 'Enter Next · Esc Cancel'}</Text>
  </Box>;

  if (state.phase === 'custom_key') return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{'Add Custom Provider · Step 3/3: API Key (Optional)'}</Text>
    <Text color={palette.fg}>❯ {displayText || 'Enter API key (press Enter to skip for local reverse proxy)'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || 'Enter Save · Esc Cancel'}</Text>
  </Box>;

  return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{'Log In ' + state.provider + ' · API Key'}</Text>
    <Text color={palette.fg}>❯ {state.phase === 'saving' ? 'Saving…' : displayText || 'Enter or paste API key'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{notice || state.error || 'Enter Save · Esc Cancel · Loaded automatically on restart'}</Text>
  </Box>;
}
