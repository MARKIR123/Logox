import {useEffect, useState} from 'react';
import {Box, Text, render, renderToString, useApp, useCursor, useInput, useStdout, useWindowSize} from 'ink';
import stringWidth from 'string-width';
import {writeFile} from 'node:fs/promises';
import {palette} from '../appearance/theme.js';
import {clipLine} from '../terminal/text.js';
import {CommandSuggestions, suggestionWindow, type SuggestionCommand} from '../commands/command-suggestions.js';

// Static fixtures only: this showcase never creates an application, reads credentials,
// executes slash commands, or invokes an agent/provider.
export const previewCommands: readonly SuggestionCommand[] = [
  {name: '/login', description: 'Add or edit providers'},
  {name: '/model', description: 'Select a model and thinking effort'},
  {name: '/settings', description: 'Theme, cursor and animations'},
  {name: '/permissions', description: 'Review execution permissions'},
  {name: '/status', description: 'View runtime status and usage'},
  {name: '/resume', description: 'Open a previous session'},
  {name: '/clear', description: 'Clear the visible conversation'},
  {name: '/help', description: 'Show commands and shortcuts'},
];

export interface PreviewFrameProps {
  readonly width: number;
  readonly height: number;
  readonly query: string;
  readonly selected: number;
  readonly open?: boolean;
  readonly notice?: string;
  readonly onPick?: ((index: number) => void) | undefined;
  readonly onWheelStep?: ((direction: 1 | -1) => void) | undefined;
}
export function filteredPreviewCommands(query: string): readonly SuggestionCommand[] {
  return previewCommands.filter(command => command.name.toLowerCase().startsWith(query.toLowerCase()));
}

export function PreviewFrame({width, height, query, selected, open = true, notice = '', onPick, onWheelStep}: PreviewFrameProps) {
  if (height < 5) return <Box width={width} height={height} overflow="hidden"><Text color={palette.muted} wrap="truncate">Expand terminal to preview the menu.</Text></Box>;
  const commands = open ? filteredPreviewCommands(query) : [];
  const noticeRows = height >= 6 ? 1 : 0;
  const maxVisible = Math.max(1, Math.min(5, height - 7));
  const {count} = suggestionWindow(commands.length, selected, maxVisible);
  const menuHeight = commands.length ? 1 + Math.min(count, commands.length) + (commands.length > count ? 1 : 0) : 0;
  const menuY = Math.max(0, height - menuHeight - 2);
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <Box height={Math.max(0, height - menuHeight - 2 - noticeRows)} flexShrink={0} flexDirection="column" overflow="hidden">
      <Text color={palette.fg} wrap="truncate">Logox · Command menu preview</Text>
      <Text color={palette.muted} wrap="truncate">Standalone preview — no commands are executed.</Text>
    </Box>
    {noticeRows > 0 && <Box height={1} flexShrink={0}><Text color={palette.muted} wrap="truncate">{notice || 'Command navigation · System theme and borders'}</Text></Box>}
    <CommandSuggestions commands={commands} selectedIndex={selected} columns={width} query={query} maxVisible={maxVisible} y={menuY}
      onPick={onPick} onWheelStep={onWheelStep}/>
    <Box height={1} flexShrink={0}><Text color={palette.fg} wrap="truncate">{clipLine(query, width)}</Text></Box>
    <Box height={1} flexShrink={0}><Text color={palette.muted} wrap="truncate">↑↓ / Wheel Select · Enter Preview · Tab Complete · Esc Close · Ctrl+C Exit</Text></Box>
  </Box>;
}

export function SlashPreview() {
  const {columns, rows} = useWindowSize(), {stdout} = useStdout(), {exit} = useApp(), {setCursorPosition} = useCursor();
  const width = Math.max(1, columns - 1), height = Math.max(1, rows);
  const [query, setQuery] = useState('/'), [selected, setSelected] = useState(0), [open, setOpen] = useState(true), [notice, setNotice] = useState('');
  const commands = filteredPreviewCommands(query);
  const move = (direction: number) => setSelected(previous => (previous + direction + commands.length) % Math.max(1, commands.length));
  useEffect(() => {
    stdout.write('\x1b[?1000h\x1b[?1006h');
    return () => {stdout.write('\x1b[?1000l\x1b[?1006l');};
  }, [stdout]);
  setCursorPosition(height >= 5 ? {x: Math.min(width - 1, stringWidth(query)), y: height - 2} : undefined);
  useInput((input, key) => {
    if (key.eventType === 'release' || input.includes('\x1b') || input.startsWith('[<')) return;
    if (key.ctrl && (input === 'c' || input === 'd')) {exit(); return;}
    if (key.escape) {setOpen(false); return;}
    if (open && (key.upArrow || key.downArrow)) {move(key.upArrow ? -1 : 1); return;}
    const current = commands[Math.min(selected, commands.length - 1)];
    if (open && key.return) {setNotice(current ? `Preview only: ${current.name}` : 'No matching commands'); return;}
    if (open && key.tab) {if (current) {setQuery(current.name); setSelected(0);} return;}
    if (key.ctrl || key.meta) return;
    if (key.backspace || key.delete) {setQuery(previous => [...previous].slice(0, -1).join('')); setSelected(0); setOpen(true); return;}
    if (input && !key.tab && !key.return) {setQuery(previous => previous + input.replace(/[\r\n]/g, ' ')); setSelected(0); setOpen(true);}
  });
  return <PreviewFrame width={width} height={height} query={query} selected={selected} open={open} notice={notice}
    onPick={setSelected} onWheelStep={move}/>;
}

export async function runSlashPreview(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const numberArg = (name: string, fallback: number) => {
    const at = args.indexOf(name), value = at >= 0 ? Number(args[at + 1]) : fallback;
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
  };
  const snapshotAt = args.indexOf('--snapshot');
  if (args.includes('--static') || snapshotAt >= 0) {
    const queryAt = args.indexOf('--query');
    const frame = renderToString(<PreviewFrame width={Math.max(8, numberArg('--width', 80))} height={Math.max(8, numberArg('--height', 20))}
      query={queryAt >= 0 ? args[queryAt + 1] ?? '/' : '/'} selected={numberArg('--selected', 1)}/>, {columns: Math.max(8, numberArg('--width', 80))});
    if (snapshotAt >= 0) {
      const path = args[snapshotAt + 1];
      if (!path) throw new Error('--snapshot requires an output path');
      await writeFile(path, frame, 'utf8');
    } else process.stdout.write(frame + '\n');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive preview requires a terminal. Use --static for a text preview.');
  const instance = render(<SlashPreview/>, {alternateScreen: true, exitOnCtrlC: false, patchConsole: false});
  await instance.waitUntilExit();
}
