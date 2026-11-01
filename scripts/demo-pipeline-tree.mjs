#!/usr/bin/env node
// Standalone interactive demonstration of Logox Continuous Rail & Nested Tree Actor Card.
// Run with: npm run demo:pipeline (or node scripts/demo-pipeline-tree.mjs)
import React, {useState, useEffect} from 'react';
import {render, Box, Text, useApp, useInput, useWindowSize} from 'ink';
import {cast} from '../dist/src/actors/ensemble.js';
import {palette} from '../dist/src/tui/appearance/theme.js';

const e = React.createElement;

function ShimmerText({text, roleColor, shimmerColor}) {
  const chars = Array.from(text);
  const cycle = chars.length + 14;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % cycle);
    }, 60);
    return () => clearInterval(timer);
  }, [cycle]);

  const glimmerStart = frame - 7;
  const windowSize = 8;

  return e(
    Box,
    {flexDirection: 'row'},
    chars.map((ch, idx) => {
      const inBeam = idx >= glimmerStart && idx < glimmerStart + windowSize;
      const center = glimmerStart + windowSize / 2;
      const dist = Math.abs(idx - center) / (windowSize / 2);
      const isLuster = inBeam && dist < 0.8;
      return e(
        Text,
        {
          key: idx,
          color: isLuster ? shimmerColor : roleColor,
          bold: isLuster,
        },
        ch
      );
    })
  );
}

function DemoPipeline() {
  const {columns} = useWindowSize();
  const width = Math.max(1, columns - 1);
  const {exit} = useApp();

  const [kalonOpen, setKalonOpen] = useState(true);
  const [techneOpen, setTechneOpen] = useState(true);
  const [aletheiaOpen, setAletheiaOpen] = useState(false);
  const [isRunning, setIsRunning] = useState(true);

  const isInteractive = Boolean(process.stdin.isTTY);

  if (isInteractive) {
    useInput((input, key) => {
      if (key.escape || input === 'q') {
        exit();
        return;
      }
      if (input === '1') setKalonOpen(o => !o);
      if (input === '2') setTechneOpen(o => !o);
      if (input === '3') setAletheiaOpen(o => !o);
      if (input === ' ') setIsRunning(r => !r);
    });
  }

  const logoxBlue = palette.accent;
  const techneGold = cast.techne.color;
  const kalonRose = cast.kalon.color;
  const aletheiaGreen = cast.aletheia.color;
  const techneShimmer = '#F8E7BF'; // Lighter pastel variant of Techne gold

  // A single unified row component that guarantees Logox's rail is ALWAYS on column 0!
  const RailRow = (children, cardBg = undefined, indent = 0) =>
    e(
      Box,
      {flexDirection: 'row', width: '100%'},
      e(Text, {color: logoxBlue}, '│ '),
      e(
        Box,
        {
          flexDirection: 'row',
          flexGrow: 1,
          backgroundColor: cardBg,
          paddingLeft: indent,
        },
        children
      )
    );

  const BlankRail = (cardBg = undefined) =>
    e(
      Box,
      {flexDirection: 'row', width: '100%'},
      e(Text, {color: logoxBlue}, '│ '),
      cardBg ? e(Box, {flexGrow: 1, backgroundColor: cardBg}, e(Text, null, ' ')) : null
    );

  return e(
    Box,
    {flexDirection: 'column', width, paddingY: 1, paddingX: 1},
    // Top Banner
    e(
      Box,
      {flexDirection: 'column', marginBottom: 1},
      e(Text, {bold: true, color: '#FFFFFF'}, 'LOGOX 连贯管道导轨与内生树形 Actor 卡片 · 交互式 DEMO'),
      e(Text, {color: palette.muted}, '按 1 切换 Kalon 折叠 | 按 2 切换 Techne 折叠 | 按 3 切换 Aletheia 折叠 | 空格 切换工具运行/完成态 | q 退出')
    ),
    e(Text, {color: palette.borderMuted}, '─'.repeat(Math.min(90, width - 4))),

    // =====================================================================
    // 1. DIRECTOR LOGOX START TURN
    // =====================================================================
    e(
      Box,
      {flexDirection: 'row', marginTop: 1},
      e(Text, {color: logoxBlue, bold: true}, '◈ Logox '),
      e(Text, {color: palette.fg}, '· 任务顶层规划与分工派发')
    ),
    RailRow(
      e(Text, {color: palette.fg}, '用户需求：制作高质量鹈鹕骑车 2D 动画。确立 rig 几何契约，调度同伴协同完成。')
    ),
    BlankRail(),

    // =====================================================================
    // 2. ACTOR 1: KALON CARD (UNDER LOGOX RAIL)
    // =====================================================================
    (() => {
      const cardBg = kalonOpen ? '#1D1519' : undefined;
      return e(
        Box,
        {flexDirection: 'column', width: '100%'},
        // Header Row (Option 2: palette.fg regular weight, not bold!)
        RailRow(
          e(
            Box,
            {flexDirection: 'row', justifyContent: 'space-between', width: '100%'},
            e(
              Box,
              {flexDirection: 'row'},
              e(Text, {color: kalonRose, bold: true}, '✧ Kalon '),
              e(Text, {color: palette.fg}, '· 海滨公路与鹈鹕静态插画绘制 '),
              e(Text, {color: palette.muted}, '· Completed · 42s')
            ),
            e(Text, {color: palette.muted}, (kalonOpen ? '▾' : '▸') + ' ')
          ),
          cardBg,
          1
        ),
        // Expanded Body: Task brief + Intent titles start at indent 1
        kalonOpen && RailRow(e(Text, {color: kalonRose}, '│'), cardBg, 1),
        kalonOpen && RailRow([
          e(Text, {color: kalonRose}, '│ '),
          e(Text, {color: palette.muted}, '▸ ▮ Task from '),
          e(Text, {color: logoxBlue, bold: true}, '◈ Logox'),
          e(Text, {color: palette.muted}, ' · 完整任务书'),
        ], cardBg, 1),
        kalonOpen && RailRow(e(Text, {color: kalonRose}, '│'), cardBg, 1),
        kalonOpen && RailRow(e(Text, {color: kalonRose, bold: true}, '✧ 我先查阅骨骼尺寸与调色板'), cardBg, 1),
        kalonOpen && RailRow([
          e(Text, {color: kalonRose}, '│ '),
          e(Text, {color: palette.muted}, '▸ Observe 2 files · spec/rig-contract.md, palette.md · 0.2s')
        ], cardBg, 1),
        kalonOpen && RailRow([
          e(Text, {color: kalonRose}, '│ '),
          e(Text, {color: palette.fg}, '尺寸核对完毕，视口锁定 1200x720，后轮 (420,450)，前轮 (880,450)。确定复古海滨色调。')
        ], cardBg, 1),
        kalonOpen && RailRow(e(Text, {color: kalonRose}, '│'), cardBg, 1),
        kalonOpen && RailRow(e(Text, {color: kalonRose, bold: true}, '✧ 开始绘制海鸟骨骼与车架部件'), cardBg, 1),
        kalonOpen && RailRow([
          e(Text, {color: kalonRose}, '│ '),
          e(Text, {color: palette.muted}, '▮ Write art/pelican-scene.svg · 45.5 KB · 1.2s')
        ], cardBg, 1),
        kalonOpen && RailRow([
          e(Text, {color: kalonRose}, '│ '),
          e(Text, {color: palette.muted}, '▮ mcp.playwright.screenshot · 0.8s')
        ], cardBg, 1),
        kalonOpen && RailRow(e(Text, {color: kalonRose}, '│'), cardBg, 1),
        kalonOpen && RailRow(e(Text, {color: kalonRose, bold: true}, '✧ 插画交付完毕，通知 Techne 接棒'), cardBg, 1),
        kalonOpen && RailRow([
          e(Text, {color: kalonRose}, '│ '),
          e(Text, {color: palette.fg}, '静态画稿已就绪：喉囊自然下垂，翅膀握位 0 偏差对齐，已交付给 Techne。')
        ], cardBg, 1),
        kalonOpen && BlankRail(cardBg)
      );
    })(),

    BlankRail(),

    // =====================================================================
    // 3. ACTOR 2: TECHNE CARD (UNDER LOGOX RAIL, RUNNING IN-FLIGHT)
    // =====================================================================
    (() => {
      const cardBg = techneOpen ? '#1E1B14' : undefined;
      return e(
        Box,
        {flexDirection: 'column', width: '100%'},
        // Header Row (Starts at indent 1)
        RailRow(
          e(
            Box,
            {flexDirection: 'row', justifyContent: 'space-between', width: '100%'},
            e(
              Box,
              {flexDirection: 'row'},
              e(Text, {color: techneGold, bold: true}, '⊞ Techne '),
              e(Text, {color: palette.fg}, '· 运动学动画与音效驱动构建 '),
              e(Text, {color: isRunning ? techneGold : palette.muted, bold: isRunning}, isRunning ? '· Running (Pass 2) · 18s' : '· Completed · 18s')
            ),
            e(Text, {color: isRunning ? techneGold : palette.muted}, (techneOpen ? '▾' : '▸') + ' ')
          ),
          cardBg,
          1
        ),
        // Expanded Body: Task brief + Intent titles start at indent 1
        techneOpen && RailRow(e(Text, {color: techneGold}, '│'), cardBg, 1),
        techneOpen && RailRow([
          e(Text, {color: techneGold}, '│ '),
          e(Text, {color: palette.muted}, '▸ ▮ Task from '),
          e(Text, {color: logoxBlue, bold: true}, '◈ Logox'),
          e(Text, {color: palette.muted}, ' · 完整任务书'),
        ], cardBg, 1),
        techneOpen && RailRow(e(Text, {color: techneGold}, '│'), cardBg, 1),
        techneOpen && RailRow(e(Text, {color: techneGold, bold: true}, '⊞ 我先检查相关文件'), cardBg, 1),
        techneOpen && RailRow([
          e(Text, {color: techneGold}, '│ '),
          e(Text, {color: palette.muted}, '▸ Observe 2 files · palette.md, theme.json · 0.2s')
        ], cardBg, 1),
        techneOpen && RailRow([
          e(Text, {color: techneGold}, '│ '),
          e(Text, {color: palette.fg}, '相关文件浏览完毕。确认了 masterGain 初始值只有 0.6，接下来进行增益校准与防削波配置。')
        ], cardBg, 1),
        techneOpen && RailRow(e(Text, {color: techneGold}, '│'), cardBg, 1),
        techneOpen && RailRow(e(Text, {color: techneGold, bold: true}, '⊞ 开始实现'), cardBg, 1),
        techneOpen && RailRow([
          e(Text, {color: techneGold}, '│ '),
          e(Text, {color: palette.muted}, '▮ Edit screen/audio.js · +5 -1 lines · 0.8s')
        ], cardBg, 1),
        techneOpen && RailRow([
          e(Text, {color: techneGold}, '│ '),
          e(Text, {color: palette.muted}, '▮ Edit motion/rig-driver.js · +12 -2 lines · 0.9s')
        ], cardBg, 1),
        techneOpen && RailRow(e(Text, {color: techneGold}, '│'), cardBg, 1),
        techneOpen && RailRow(e(Text, {color: techneGold, bold: true}, '⊞ 开始测试'), cardBg, 1),
        techneOpen && RailRow([
          e(Text, {color: techneGold}, '│ '),
          isRunning
            ? e(
                Box,
                {flexDirection: 'row'},
                e(Text, {color: techneGold, bold: true}, '▮ '),
                e(ShimmerText, {text: 'Shell', roleColor: techneGold, shimmerColor: techneShimmer}),
                e(Text, {color: palette.muted}, ' npm test -- --grep "audio|driver" · 1.4s running...')
              )
            : e(Text, {color: palette.muted}, '▮ Shell npm test · exit 0 · 1.4s')
        ], cardBg, 1),
        techneOpen && RailRow([
          e(Text, {color: techneGold}, '│ '),
          e(Text, {color: palette.muted}, '▮ mcp.playwright.snapshot · 1.2s')
        ], cardBg, 1),
        techneOpen && RailRow(e(Text, {color: techneGold}, '│'), cardBg, 1),
        techneOpen && RailRow(e(Text, {color: techneGold, bold: true}, '⊞ 测试已完成，汇报结果'), cardBg, 1),
        techneOpen && RailRow([
          e(Text, {color: techneGold}, '│ '),
          e(Text, {color: palette.fg}, '音效与双骨骼 IK 运动学解算已全部绿标通过，全按键音达到 −22 dBFS 标准，向 Logox 交付。')
        ], cardBg, 1),
        techneOpen && BlankRail(cardBg)
      );
    })(),

    BlankRail(),

    // =====================================================================
    // 4. ACTOR 3: ALETHEIA CARD (UNDER LOGOX RAIL, COLLAPSED 1-LINE)
    // =====================================================================
    (() => {
      const cardBg = aletheiaOpen ? '#141A17' : undefined;
      return e(
        Box,
        {flexDirection: 'column', width: '100%'},
        // Header Row (Starts at indent 1, EXACT SAME COLUMN!)
        RailRow(
          e(
            Box,
            {flexDirection: 'row', justifyContent: 'space-between', width: '100%'},
            e(
              Box,
              {flexDirection: 'row'},
              e(Text, {color: aletheiaGreen, bold: true}, '◎ Aletheia '),
              e(Text, {color: palette.fg}, '· 16 相位 IK 运动学解算审计与无缝卷轴防穿模验证 '),
              e(Text, {color: palette.muted}, '· Completed · 12s')
            ),
            e(Text, {color: palette.muted}, (aletheiaOpen ? '▾' : '▸') + ' ')
          ),
          cardBg,
          1
        ),
        aletheiaOpen && RailRow(e(Text, {color: aletheiaGreen}, '│'), cardBg, 1),
        aletheiaOpen && RailRow(e(Text, {color: aletheiaGreen, bold: true}, '◎ 审计骨骼相位与踏板约束'), cardBg, 1),
        aletheiaOpen && RailRow([
          e(Text, {color: aletheiaGreen}, '│ '),
          e(Text, {color: palette.muted}, '▸ Audit 3 files · rig-contract.md, rig-driver.js, test.log · 0.2s')
        ], cardBg, 1),
        aletheiaOpen && RailRow([
          e(Text, {color: aletheiaGreen}, '│ '),
          e(Text, {color: palette.fg}, '16 相位截图全部比对通过，最大踏板闭合误差 0.0088px，无穿模无跳帧。')
        ], cardBg, 1),
        aletheiaOpen && BlankRail(cardBg)
      );
    })(),

    BlankRail(),

    // =====================================================================
    // 5. DIRECTOR LOGOX CLOSING TURN
    // =====================================================================
    e(
      Box,
      {flexDirection: 'row'},
      e(Text, {color: logoxBlue, bold: true}, '◈ Logox '),
      e(Text, {color: palette.fg}, '· 全剧团综合验收与最终成果交付')
    ),
    RailRow(
      e(Text, {color: palette.fg}, 'Kalon 的视觉插画、Techne 的动画音效驱动均已全绿验收，Aletheia 审计 16 相位误差 0.008px。动画已交付！')
    ),

    e(Box, {marginTop: 1}, e(Text, {color: palette.borderMuted}, '─'.repeat(Math.min(90, width - 4)))),
    e(Text, {dimColor: true}, '按 q 或 Esc 键退出演示')
  );
}

const isInteractive = Boolean(process.stdin.isTTY);
const instance = render(e(DemoPipeline), {
  alternateScreen: isInteractive,
  interactive: isInteractive,
  patchConsole: false,
});
if (isInteractive) {
  await instance.waitUntilExit();
} else {
  await new Promise(r => setTimeout(r, 150));
  instance.unmount();
}
