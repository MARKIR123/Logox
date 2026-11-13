import {Box, Text, useInput} from 'ink';
import {LoginWizardPanel} from './login-wizard.js';
import type {LoginFlow, LoginState} from '../../providers/login.js';
import {palette} from '../appearance/theme.js';

/** The login surface: the local wizard form, or the browser sign-in in progress (link, error, Esc to cancel). */
export function LoginDialog({flow, state, width, height, y, onCursor, onClose}: {
  flow: LoginFlow; state: LoginState; width: number; height: number; y: number; onCursor(position: {x: number; y: number} | undefined): void; onClose(): void;
  notice?: string;
}) {
  if (state.phase !== 'wizard') onCursor(undefined);
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'd') {onClose(); return;}
    if (state.phase === 'wizard') return;
    if (key.escape) flow.cancel();
  });

  if (state.phase === 'wizard') return <LoginWizardPanel flow={flow} state={state} width={width} height={height} y={y}/>;

  return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={2}>
    <Text color={palette.line}>{'─'.repeat(Math.max(1, width - 4))}</Text>
    <Text bold color={palette.accent}>{'OpenAI Account Authorization'}</Text>
    <Text color={palette.fg}>❯ Please open the following link in your browser to complete authorization:</Text>
    <Text color={palette.accent} wrap="truncate-end">{state.oauthUrl || 'Generating authorization link…'}</Text>
    <Text color={state.error ? palette.error : palette.muted}>{state.error || 'Esc Cancel'}</Text>
  </Box>;
}
