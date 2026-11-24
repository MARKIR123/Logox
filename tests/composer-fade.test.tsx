import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {useState} from 'react';
import chalk from 'chalk';
import {Box, Text} from 'ink';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {ComposerRule, COMPOSER_FADE_MS, fadedColor} from '../src/tui/input/composer-fade.js';
import {setTerminalFocus} from '../src/tui/terminal/focus.js';
import {palette} from '../src/tui/appearance/theme.js';
import {TerminalScreen} from './terminal-screen.js';

class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
const ACTIVE = '#4488ff';
let setActive: (value: boolean) => void = () => {};
function Host({motion, typed}: {motion: boolean; typed: string}) {
  const [active, set] = useState(true);
  setActive = set;
  return <Box flexDirection="column"><ComposerRule color={ACTIVE} width={10} active={active} motion={motion}/><Text color={palette.composerFg}>{typed}</Text></Box>;
}
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
/** Foreground colours (as hex) in order of appearance in the terminal output. */
const colours = (text: string) => [...text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map(m => hex(+m[1]!, +m[2]!, +m[3]!));

async function run(motion: boolean, act: (output: TerminalScreen) => Promise<void>) {
  const previousLevel = chalk.level; chalk.level = 3;
  const input = new Input(), output = new TerminalScreen();
  output.columns = 40; output.rows = 6;
  const instance = renderTerminal(<Host motion={motion} typed="typed text"/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false});
  try {await delay(100); await act(output);} finally {chalk.level = previousLevel; setTerminalFocus(undefined); instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();}
}

test('losing the keyboard fades the rule to the muted tone over several frames; regaining it wakes it back up; typed text keeps its colour', async () => {
  await run(true, async output => {
    const dim = fadedColor(ACTIVE, 0);
    assert.notEqual(dim, ACTIVE);
    output.text = ''; setActive(false);
    await delay(COMPOSER_FADE_MS + 250);
    const down = colours(output.text);
    const rule = down.filter(c => c !== palette.composerFg);
    assert.ok(new Set(rule).size >= 3, 'intermediate frames, not a jump: ' + [...new Set(rule)].join(' '));
    assert.equal(rule.at(-1), dim, 'ends on the muted tone');
    output.text = ''; setActive(true);
    await delay(COMPOSER_FADE_MS + 250);
    const up = colours(output.text).filter(c => c !== palette.composerFg);
    assert.ok(new Set(up).size >= 3, 'wakes up through frames: ' + [...new Set(up)].join(' '));
    assert.equal(up.at(-1), ACTIVE, 'ends on the active colour');
    assert.ok(![...down, ...up].some(c => c === fadedColor(palette.composerFg, 0.5)), 'the typed text is never recoloured');
  });
});

test('without motion the change is immediate: one colour, no intermediate frames', async () => {
  await run(false, async output => {
    output.text = ''; setActive(false);
    await delay(COMPOSER_FADE_MS + 250);
    const rule = [...new Set(colours(output.text).filter(c => c !== palette.composerFg))];
    assert.deepEqual(rule, [fadedColor(ACTIVE, 0)]);
  });
});

test('the terminal window losing focus dims the rule and a focus-in restores it', async () => {
  await run(true, async output => {
    output.text = ''; setTerminalFocus(false);
    await delay(COMPOSER_FADE_MS + 250);
    assert.equal(colours(output.text).filter(c => c !== palette.composerFg).at(-1), fadedColor(ACTIVE, 0));
    output.text = ''; setTerminalFocus(true);
    await delay(COMPOSER_FADE_MS + 250);
    assert.equal(colours(output.text).filter(c => c !== palette.composerFg).at(-1), ACTIVE);
  });
});
