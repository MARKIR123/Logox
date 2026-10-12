import {useState} from 'react';
import {Box, Text, useInput, usePaste} from 'ink';
import type {LoginFlow, LoginState} from '../providers/login.js';
import {emptyDraft, erase, insert, move, type Draft} from './editor.js';
import {palette} from './cards.js';
import {Picker} from './picker.js';

export function LoginDialog({flow, state, width, height, y, onCursor, onClose}: {
  flow: LoginFlow; state: LoginState; width: number; height: number; y: number; onCursor(position: {x: number; y: number} | undefined): void; onClose(): void;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const inputWidth = Math.max(1, width - 6);
  const start = Math.max(0, draft.cursor - inputWidth + 1);
  const mask = '•'.repeat(Math.min(inputWidth, [...draft.text].length - start));
  const edit = (next: Draft) => {if (state.phase === 'key' && next.text.length <= 16384) setDraft(next);};
  onCursor(state.phase === 'key' ? {x: Math.min(width - 1, 4 + draft.cursor - start), y: y + 2} : undefined);
  usePaste(text => edit(insert(draft, text.trim())));
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'd') {onClose(); return;}
    if (state.phase === 'saving' || state.phase === 'provider') return;
    if (key.escape || key.ctrl && input === 'c') {setDraft(emptyDraft); flow.cancel(); return;}
    if (key.return) {const value = draft.text; setDraft(emptyDraft); void flow.submit(value); return;}
    if (key.backspace || key.delete) {edit(erase(draft, Boolean(key.backspace))); return;}
    if (key.leftArrow || key.rightArrow) {edit(move(draft, key.leftArrow ? -1 : 1)); return;}
    if (key.home || key.end) {edit(move(draft, key.home ? -Infinity : Infinity)); return;}
    if (key.ctrl && input === 'u') {setDraft(emptyDraft); return;}
    if (!key.ctrl && !key.meta && input) edit(insert(draft, input));
  });
  if (state.phase === 'provider') return <Picker title="登录提供商 · API key" description="保存后重启自动读取" width={width} height={height} y={y}
    items={state.providers.map(provider => ({id: provider.name, label: provider.name, description: provider.saved ? '已保存' : ''}))}
    error={state.error} onSelect={name => flow.choose(name)} onCancel={() => flow.cancel()}/>;
  return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{'登录 ' + state.provider + ' · API key'}</Text>
    <Text color={palette.fg}>❯ {state.phase === 'saving' ? '正在保存…' : mask || '输入或粘贴 API key'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || 'Enter 保存 · Esc 取消 · 重启后自动读取'}</Text>
  </Box>;
}
