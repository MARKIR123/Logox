#!/usr/bin/env node
// Standalone interactive demonstration of the Starship Actor Bar & interaction.
// Run with: node scripts/demo-actor-bar.mjs
import React, {useState, useEffect, useRef} from 'react';
import {render, Box, Text, useApp, useInput, useStdout, useWindowSize} from 'ink';
import {computeActivePills, calculatePillsWidth, ActorPills} from '../dist/src/tui/status/actor-pills.js';
import {statusbarParts} from '../dist/src/tui/status/statusbar.js';
import {palette} from '../dist/src/tui/appearance/theme.js';

const e = React.createElement;

const roles = {
  aletheia: {
    id: 'aletheia',
    name: 'Aletheia',
    title: '澄明 · 侦察者',
    color: '#7FAE99',
    symbol: '◎',
    cardClosed: '#232E2E',
    cardOpen: '#2C3A39',
    thinkingAnimation: ['·', '○', '⊙', '⊚', '◉', '⊚', '⊙', '○'],
  },
  techne: {
    id: 'techne',
    name: 'Techne',
    title: '精工 · 构建匠人',
    color: '#E5C07B',
    symbol: '⊞',
    cardClosed: '#403622',
    cardOpen: '#57492F',
    thinkingAnimation: [
      '\u{F08A1}', '\u{F00CB}', '\u{F00C7}', '\u{F11D9}',
      '\u{F0570}', '\u{F11D9}', '\u{F00C7}', '\u{F00CB}',
    ],
  },
  kalon: {
    id: 'kalon',
    name: 'Kalon',
    title: '雅正 · 审美官',
    color: '#D3869B',
    symbol: '✧',
    cardClosed: '#352731',
    cardOpen: '#473342',
    thinkingAnimation: ['·', '✦', '✧', '★', '✧', '✦'],
  },
};

function DemoApp() {
  const {columns, rows: screenRows} = useWindowSize();
  const width = Math.max(1, columns - 1);
  const height = Math.max(1, screenRows);
  const {exit} = useApp();
  const {stdout} = useStdout();

  const [activeActors, setActiveActors] = useState({
    aletheia: true,
    techne: true,
    kalon: true,
  });
  const [style, setStyle] = useState('starship'); // 'starship' | 'pipes'
  const [currentView, setCurrentView] = useState('logox');
  const [hoveredOwner, setHoveredOwner] = useState(null);
  const [lastAction, setLastAction] = useState('Ready. Move mouse over pills or click/double-click them.');
  const [focusedCard, setFocusedCard] = useState('techne');
  const lastClickRef = useRef({time: 0, owner: ''});

  const activities = [
    {activityId: 'act-aletheia', ownerId: 'aletheia', sessionId: 'demo', status: activeActors.aletheia ? 'running' : 'completed'},
    {activityId: 'act-techne', ownerId: 'techne', sessionId: 'demo', status: activeActors.techne ? 'running' : 'completed'},
    {activityId: 'act-kalon', ownerId: 'kalon', sessionId: 'demo', status: activeActors.kalon ? 'running' : 'completed'},
  ];

  const activePills = computeActivePills(
    activities,
    'demo',
    roles,
    0,
    width,
    ['aletheia', 'techne', 'kalon']
  );
  const pillsWidth = calculatePillsWidth(activePills);

  const fakeStatus = {
    ownerId: currentView,
    name: currentView === 'logox' ? 'Logox' : roles[currentView]?.name ?? currentView,
    color: currentView === 'logox' ? '#7DA1DE' : roles[currentView]?.color ?? '#7DA1DE',
    model: {provider: 'antigravity', model: 'opus-4-6'},
    effort: 'high',
    permission: 'creative',
    state: 'running',
    context: {tokens: 38240, window: 100000},
    tokens: 41280,
    cost: 0.052,
    session: 'gameboy_demo',
    project: 'G:/hz/codes/gameboy/logox_v2',
  };

  const footerStatusWidth = Math.max(0, width - pillsWidth - (pillsWidth > 0 ? 1 : 0));
  const statusParts = statusbarParts(fakeStatus, footerStatusWidth, undefined, {style});

  // Enable mouse tracking
  useEffect(() => {
    stdout?.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    return () => {
      stdout?.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');
    };
  }, [stdout]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c' || input === 'q' || key.escape && currentView === 'logox') {
      exit();
      return;
    }
    if (key.escape && currentView !== 'logox') {
      setCurrentView('logox');
      setLastAction('Esc pressed: Returned to main Logox stage.');
      return;
    }
    if (input === '1') {
      setActiveActors(prev => ({...prev, aletheia: !prev.aletheia}));
      setLastAction(`Toggled Aletheia: ${!activeActors.aletheia ? 'RUNNING' : 'IDLE'}`);
      return;
    }
    if (input === '2') {
      setActiveActors(prev => ({...prev, techne: !prev.techne}));
      setLastAction(`Toggled Techne: ${!activeActors.techne ? 'RUNNING' : 'IDLE'}`);
      return;
    }
    if (input === '3') {
      setActiveActors(prev => ({...prev, kalon: !prev.kalon}));
      setLastAction(`Toggled Kalon: ${!activeActors.kalon ? 'RUNNING' : 'IDLE'}`);
      return;
    }
    if (input === 's' || input === 'S') {
      const next = style === 'starship' ? 'pipes' : 'starship';
      setStyle(next);
      setLastAction(`Switched statusbar style to: ${next.toUpperCase()}`);
      return;
    }
    if (input === 'h' || input === 'H') {
      const owners = activePills.map(p => p.ownerId);
      if (!owners.length) return;
      const idx = hoveredOwner ? (owners.indexOf(hoveredOwner) + 1) % owners.length : 0;
      setHoveredOwner(owners[idx]);
      setLastAction(`Keyboard simulated hover on: ${owners[idx]}`);
      return;
    }

    // Parse SGR mouse escape sequences: \x1b[<button;x;y(M|m)
    if (input.startsWith('\x1b[<')) {
      const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(input);
      if (m) {
        const btn = parseInt(m[1], 10);
        const x = parseInt(m[2], 10) - 1;
        const y = parseInt(m[3], 10) - 1;
        const release = m[4] === 'm';
        const isMove = btn === 32 || btn === 35;

        const footerY = height - 1;
        if (y === footerY) {
          const pill = activePills.find(p => x >= p.startX && x < p.endX);
          if (pill) {
            if (isMove) {
              setHoveredOwner(pill.ownerId);
            } else if (!release && btn === 0) {
              const now = Date.now();
              if (now - lastClickRef.current.time < 350 && lastClickRef.current.owner === pill.ownerId) {
                // Double click
                setCurrentView(pill.ownerId);
                setLastAction(`[DOUBLE-CLICK] Entered ${roles[pill.ownerId].name} independent chat window!`);
                lastClickRef.current = {time: 0, owner: ''};
              } else {
                // Single click
                setFocusedCard(pill.ownerId);
                setLastAction(`[SINGLE-CLICK] Anchored viewport to ${roles[pill.ownerId].name}'s latest task card!`);
                lastClickRef.current = {time: now, owner: pill.ownerId};
              }
            }
            return;
          }
        }
        if (hoveredOwner !== null) setHoveredOwner(null);
      }
    }
  });

  const hairline = '─'.repeat(width);

  return e(
    Box,
    {flexDirection: 'column', width, height, overflow: 'hidden'},
    // Top Banner & Controls
    e(
      Box,
      {height: 4, flexDirection: 'column', paddingX: 1, flexShrink: 0},
      e(Text, {color: palette.accent, bold: true}, 'Logox · Starship Actor Bar Interactive Demo'),
      e(Text, {color: palette.fg}, `[1] Aletheia: ${activeActors.aletheia ? 'ON ' : 'OFF'}  |  [2] Techne: ${activeActors.techne ? 'ON ' : 'OFF'}  |  [3] Kalon: ${activeActors.kalon ? 'ON ' : 'OFF'}  |  [S] Style: ${style.toUpperCase()}  |  [H] Sim Hover  |  [Q/Esc] Exit`),
      e(Text, {color: '#D77757', bold: true}, `Action: ${lastAction}`),
      e(Text, {color: palette.muted}, `View: ${currentView === 'logox' ? 'Main Stage (Logox)' : `${roles[currentView]?.name} Independent Window`}`)
    ),
    e(Box, {height: 1, flexShrink: 0}, e(Text, {color: palette.line}, hairline)),
    // Main Simulated Stage
    e(
      Box,
      {flexGrow: 1, flexDirection: 'column', paddingX: 1, overflow: 'hidden'},
      currentView === 'logox'
        ? [
            e(Box, {key: 'logox-hdr', height: 1}, e(Text, {color: '#7DA1DE', bold: true}, '◈ Logox: Coordinating retro pixel handheld console implementation')),
            e(Box, {key: 'logox-sub', height: 1}, e(Text, {color: palette.muted}, '  Active ensemble companions working in parallel below:')),
            e(Box, {key: 'spacer', height: 1}),
            activeActors.techne
              ? e(
                  Box,
                  {key: 'card-techne', height: 3, flexDirection: 'column'},
                  e(Text, {color: '#E5C07B', bold: focusedCard === 'techne'}, `${focusedCard === 'techne' ? '▶ ' : '  '}⊞ Techne · LCD 像素天际线与交互 · 正在联调渲染管线`),
                  e(Text, {color: palette.muted}, '     Files: js/screen/ui.js, js/screen/main.js | Running: browser_take_screenshot')
                )
              : null,
            activeActors.kalon
              ? e(
                  Box,
                  {key: 'card-kalon', height: 3, flexDirection: 'column'},
                  e(Text, {color: '#D3869B', bold: focusedCard === 'kalon'}, `${focusedCard === 'kalon' ? '▶ ' : '  '}✧ Kalon · PIXOPOLIS 掌机机身外壳与按键 · 正在调整阴影`),
                  e(Text, {color: palette.muted}, '     Files: index.html, styles.css | Running: Edit styles.css')
                )
              : null,
            activeActors.aletheia
              ? e(
                  Box,
                  {key: 'card-aletheia', height: 3, flexDirection: 'column'},
                  e(Text, {color: '#7FAE99', bold: focusedCard === 'aletheia'}, `${focusedCard === 'aletheia' ? '▶ ' : '  '}◎ Aletheia · 架构与性能独立审查 · 正在测量 60fps 帧率`),
                  e(Text, {color: palette.muted}, '     Files: js/screen/core.js | Running: Shell node --check')
                )
              : null,
          ].filter(Boolean)
        : e(
            Box,
            {flexDirection: 'column'},
            e(Text, {color: roles[currentView]?.color, bold: true}, `${roles[currentView]?.symbol} ${roles[currentView]?.name} · ${roles[currentView]?.title} · 独立对话窗口`),
            e(Text, {color: palette.muted}, `(You double-clicked ${roles[currentView]?.name}'s pill! Press Esc to return to the main Logox stage.)`),
            e(Box, {height: 1}),
            e(Text, {color: palette.fg}, `${roles[currentView]?.name}: "正在推进任务。有什么直接交代给我的吗？"`)
          )
    ),
    e(Box, {height: 1, flexShrink: 0}, e(Text, {color: palette.line}, hairline)),
    // Footer: Left Statusbar + Right Starship Connected Actor Bar
    e(
      Box,
      {height: 1, flexShrink: 0, flexDirection: 'row', justifyContent: 'space-between'},
      e(
        Text,
        {wrap: 'truncate'},
        statusParts.map((part, i) =>
          e(Text, {key: i, color: part.color, backgroundColor: part.backgroundColor}, part.text)
        )
      ),
      e(ActorPills, {pills: activePills, hoveredOwnerId: hoveredOwner})
    )
  );
}

const instance = render(e(DemoApp), {
  alternateScreen: true,
  interactive: true,
  patchConsole: false,
});
await instance.waitUntilExit();
