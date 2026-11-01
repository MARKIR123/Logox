import type {ActivityStatus, Interaction} from '../runtime/contracts.js';
import stringWidth from 'string-width';
import type {ActorId} from '../actors/ensemble.js';
import {cast} from '../actors/ensemble.js';
import {choiceStyle} from '../tui/interactions/choice-style.js';
import {mixHex} from '../tui/appearance/colors.js';
import {palette} from '../tui/appearance/theme.js';
import {ownerSurface} from '../tui/appearance/actor-style.js';
import {
  type SceneRow,
  type SceneSegment,
  type SceneAction,
  type FrameWrap,
  type RowBuilder,
  createBuilder,
  appendActorCard,
  insetFrame,
} from '../tui/timeline/scene.js';

export interface DemoEvent {
  readonly id: number | string;
  readonly type: 'dispatch' | 'direct' | 'main' | 'permission' | 'style';
  readonly actor?: 'aletheia' | 'techne' | 'kalon';
  readonly text?: string;
  readonly direction?: string;
  readonly reply?: string;
  readonly value?: 'allow' | 'deny';
  readonly from?: string;
  readonly status?: string;
  readonly activityId?: string;
  readonly error?: string;
}

export interface DemoSceneState {
  readonly view: ActorId;
  readonly permission: 'allow' | 'deny' | null;
  readonly permissionChoice: 'allow' | 'deny';
  readonly style: string | null;
  readonly choice: 'minimal' | 'editorial' | 'custom';
  readonly custom: string;
  readonly customError: boolean;
  readonly folds: Readonly<Record<string, boolean>>;
  readonly events: readonly DemoEvent[];
  readonly runtime?: {
    readonly techne: ActivityStatus;
    readonly kalon: ActivityStatus;
    readonly permissionRequest?: Interaction;
    readonly styleRequest?: Interaction;
    readonly background?: readonly {id: string; title: string; stage: string; detail: string; status: string}[];
  };
}

export type DemoSceneUi = Pick<DemoSceneState, 'view' | 'permissionChoice' | 'choice' | 'custom' | 'customError' | 'folds'>;

export const INITIAL_DEMO_DRAFT = "@kalon Take a look at the homepage colors. Suggestions only, please don't edit any files yet.";

export const initialDemoSceneState: DemoSceneState = {
  view: 'logox',
  permission: null,
  permissionChoice: 'deny',
  style: null,
  choice: 'minimal',
  custom: '',
  customError: false,
  folds: {},
  events: [],
};

export const demoRoles = {
  aletheia: {name: 'Aletheia', role: 'Scout', symbol: '◇', color: cast.aletheia.color, task: 'Survey homepage, find problems'},
  techne: {name: 'Techne', role: 'Builder', symbol: '⊞', color: cast.techne.color, task: 'Fix hero hierarchy and layout'},
  kalon: {name: 'Kalon', role: 'Aesthete', symbol: '✧', color: cast.kalon.color, task: 'Tune homepage type, color, space'},
} as const;

export function isFoldOpen(state: Pick<DemoSceneState, 'folds'>, id: string, fallback = false): boolean {
  return id in state.folds ? Boolean(state.folds[id]) : fallback;
}

export function defaultSceneFoldOpen(state: DemoSceneState, id: string): boolean {
  if (id === 'main-techne' || id === 'history-techne-question') {
    return state.runtime ? state.runtime.permissionRequest?.status === 'pending' : !state.permission;
  }
  if (id === 'main-kalon' || id === 'history-kalon-question') {
    return state.runtime ? state.runtime.styleRequest?.status === 'pending' : Boolean(state.permission) && !state.style;
  }
  return false;
}

function portfolioTaskStatus(state: DemoSceneState, owner: 'techne' | 'kalon'): string {
  const runtime = state.runtime;
  const request = owner === 'techne' ? runtime?.permissionRequest : runtime?.styleRequest;
  if (runtime) {
    const status = runtime[owner];
    if (status === 'cancelled') return 'Cancelled';
    if (status === 'failed') return 'Failed';
    if (status === 'queued') return 'Queued';
    if (status === 'running') return 'Running';
    if (status === 'paused') return 'Paused';
    if (request?.status === 'cancelled') return 'Closed · Request cancelled';
  }
  if (owner === 'techne') return state.permission
    ? state.permission === 'allow' ? 'Completed · Demo plan approved' : 'Closed · No files changed'
    : 'Awaiting approval';
  return state.style ? 'Completed · Preference recorded' : state.permission || request?.status === 'pending' ? 'Awaiting answer' : 'Queued · Waiting for Techne';
}

function appendOption(builder: RowBuilder, id: string, label: string, description: string, checked: boolean, frame: FrameWrap, railColor: string, actorColor: string, action: SceneAction) {
  const style = choiceStyle(checked, actorColor);
  builder.pushFramedLine(id, railColor, [
    {text: style.marker, color: style.markerColor, bold: checked, selectionOffset: 0},
    {text: label, color: style.color, bold: checked, selectionOffset: style.marker.length},
  ], frame, action);
  if (description) builder.pushProse(id + '-description', description, railColor, 'body', insetFrame(frame, frame.bg, style.indent, 0), action, style.descriptionColor);
}

function appendInteractionActions(builder: RowBuilder, id: string, frame: FrameWrap, railColor: string, actorColor: string, kind: 'confirm_permission' | 'confirm_style') {
  const action: SceneAction = {kind, foldId: id};
  const confirm: SceneSegment = {text: 'Enter Confirm', color: actorColor, bold: true};
  const later: SceneSegment = {text: 'Esc Later', color: palette.muted};
  if (frame.innerWidth >= stringWidth(confirm.text + '    ' + later.text)) {
    builder.pushFramedLine(id + '-actions', railColor, [confirm, {text: '    '}, later], frame, action);
  } else {
    builder.pushFramedLine(id + '-actions', railColor, [confirm], frame, action);
    builder.pushFramedLine(id + '-later', railColor, [later], frame, {kind: 'later', foldId: id});
  }
}

function appendPermissionInteraction(builder: RowBuilder, state: DemoSceneState, railColor: string, frame: FrameWrap, actorColor: string, foldId: string) {
  if (state.runtime && state.runtime.permissionRequest?.status !== 'pending' && !state.permission) {
    builder.pushProse(foldId + '-perm-state', state.runtime.permissionRequest?.status === 'cancelled' || state.runtime.techne === 'cancelled' ? 'Permission cancelled; no changes were made.' : 'No permission request is pending.', railColor, 'body', frame);
    return;
  }
  if (state.permission) {
    builder.pushOrdinaryCard({id: 'permission-done-' + foldId, ownerId: 'techne', kind: 'Permission', title: 'File edit permission', bodyLines: [state.permission === 'allow' ? 'You allowed this edit.' : 'You declined this edit; suggestions kept.'], status: 'Answered', open: isFoldOpen(state, 'permission-done-' + foldId, false), railColor, parentFrame: frame});
    return;
  }
  builder.pushFramedLine(foldId + '-perm-rule', railColor, [{text: '─'.repeat(frame.innerWidth), color: mixHex(actorColor, frame.bg, 0.25)}], frame);
  if (state.runtime) builder.pushProse(foldId + '-perm-demo', 'Demo approval: shows the plan only; no files are modified.', railColor, 'direction', frame);
  builder.pushProse(foldId + '-perm-legend', 'Allow edits to these two files?', railColor, 'body', frame);
  for (const file of ['src/pages/index.tsx:18-34', 'src/styles/home.css:96-112']) builder.pushProse(foldId + '-file-' + file, file, railColor, 'direction', frame);
  appendOption(builder, foldId + '-perm-allow', 'Allow once', 'Only apply this hero layout and whitespace cleanup.', state.permissionChoice === 'allow', frame, railColor, actorColor, {kind: 'select_permission', value: 'allow'});
  appendOption(builder, foldId + '-perm-deny', 'Deny', 'Keep the suggestions; do not modify source files.', state.permissionChoice === 'deny', frame, railColor, actorColor, {kind: 'select_permission', value: 'deny'});
  appendInteractionActions(builder, foldId, frame, railColor, actorColor, 'confirm_permission');
}

function appendQuestionInteraction(builder: RowBuilder, state: DemoSceneState, railColor: string, frame: FrameWrap, actorColor: string, foldId: string) {
  if (state.runtime && state.runtime.styleRequest?.status !== 'pending' && !state.style) {
    builder.pushProse(foldId + '-style-state', state.runtime.styleRequest?.status === 'cancelled' || state.runtime.kalon === 'cancelled' ? 'Preference question cancelled; no candidate generated.' : 'No preference question is pending.', railColor, 'body', frame);
    return;
  }
  if (state.style) {
    builder.pushOrdinaryCard({id: 'question-done-' + foldId, ownerId: 'kalon', kind: 'Question', title: 'Homepage mood', bodyLines: [state.style], status: 'Answered', open: isFoldOpen(state, 'question-done-' + foldId, false), railColor, parentFrame: frame});
    return;
  }
  builder.pushFramedLine(foldId + '-style-rule', railColor, [{text: '─'.repeat(frame.innerWidth), color: mixHex(actorColor, frame.bg, 0.25)}], frame);
  builder.pushProse(foldId + '-style-legend', 'Which mood should the homepage lean toward?', railColor, 'body', frame);
  const options = [
    {value: 'minimal', label: 'Restrained text portfolio', desc: 'Let projects and writing take center stage, with minimal decoration.'},
    {value: 'editorial', label: 'Warm editorial', desc: 'Soft colors and a layout that invites reading.'},
    {value: 'custom', label: 'I have my own idea', desc: 'Write down your preference.'},
  ] as const;
  for (const opt of options) {
    appendOption(builder, foldId + '-style-' + opt.value, opt.label, opt.desc, state.choice === opt.value, frame, railColor, actorColor, {kind: 'select_style', value: opt.value});
  }
  builder.pushFramedLine(foldId + '-style-custom', railColor, [
    {text: 'Extra preference: ', color: palette.muted},
    {text: state.custom || 'Like an indie magazine, but no retro decoration', color: state.custom ? palette.fg : palette.muted},
  ], frame, {kind: 'focus_custom'});
  if (state.customError) builder.pushProse(foldId + '-style-error', 'Write down your idea, or pick a direction.', railColor, 'body', frame);
  appendInteractionActions(builder, foldId, frame, railColor, actorColor, 'confirm_style');
}

export function buildDemoSceneRows(state: DemoSceneState, width: number, hoveredFoldId: string | null = null): readonly SceneRow[] {
  const builder = createBuilder(width, hoveredFoldId);
  if (state.view !== 'logox') {
    return buildActorHistoryRows(builder, state, state.view);
  }
  const logoxRail = palette.accent;

  // Turn 1: User
  builder.pushTurnHeader('main-user-turn', 'user');
  builder.pushProse('main-user', "Keep the project content, but make it feel like a developer's work with taste, less template-like.", palette.user, 'body');
  builder.pushBlank();

  // Turn 2: Logox + borderless filled cards with compact sub-row gaps and generous internal margins
  builder.pushTurnHeader('main-logox-turn', 'logox', 'Director');
  builder.pushProse(
    'main-reply',
    'Diagnose first, restructure next, polish last. Aletheia maps the source coordinates, Techne rebuilds the hero skeleton from them, and Kalon finishes by tuning spacing, color and breathing room.',
    logoxRail,
    'body',
  );

  builder.pushOrdinaryCard({
    id: 'main-thinking',
    ownerId: 'logox',
    kind: 'Thinking',
    title: 'Confirm the information hierarchy first',
    bodyLines: ['The project is solid; the problem is that every element fights for first glance. Restore order first, no rewrite needed.'],
    status: 'Closed',
    open: isFoldOpen(state, 'main-thinking', false),
    railColor: logoxRail,
  });

  builder.pushOrdinaryCard({
    id: 'main-tool',
    ownerId: 'logox',
    kind: 'Tool',
    title: 'Read · package.json',
    bodyLines: ['Check the homepage entry point and build toolchain config.'],
    status: 'Completed',
    open: isFoldOpen(state, 'main-tool', false),
    railColor: logoxRail,
  });

  // Actor 1: Aletheia
  appendActorCard(builder, {
    id: 'main-aletheia',
    owner: 'aletheia',
    task: demoRoles.aletheia.task,
    status: 'Completed · Read 3 files',
    open: isFoldOpen(state, 'main-aletheia', false),
    railColor: demoRoles.aletheia.color,
    renderBody(frame, _actorColor, bodyAction) {
      builder.pushProse('main-aletheia-dir', '（flips through the three files just read）', demoRoles.aletheia.color, 'direction', frame, bodyAction);
      builder.pushProse(
        'main-aletheia-prose',
        'All three problem spots are marked: three hero elements compete for visual weight, and on narrow screens there are three layers of redundant nested padding. Coordinates have gone to Techne; visual details are left for Kalon to finish.',
        demoRoles.aletheia.color,
        'body',
        frame,
        bodyAction,
      );
      builder.pushOrdinaryCard({
        id: 'main-aletheia-reads',
        ownerId: 'aletheia',
        kind: 'Tool',
        title: 'Read · 3 homepage files',
        bodyLines: [
          'src/pages/index.tsx:18             hero title, tag group and button share one weight; focus is scattered',
          'src/components/ProjectCard.tsx:42  project blurb repeats the third hero line',
          'src/styles/home.css:96             three nested containers stack padding to 48px on mobile',
        ],
        status: 'Completed',
        open: isFoldOpen(state, 'main-aletheia-reads', false),
        railColor: demoRoles.aletheia.color,
        parentFrame: frame,
      });
    },
  });

  // Actor 2: Techne
  const tStatus = portfolioTaskStatus(state, 'techne');
  appendActorCard(builder, {
    id: 'main-techne',
    owner: 'techne',
    task: demoRoles.techne.task,
    status: tStatus,
    open: isFoldOpen(state, 'main-techne', defaultSceneFoldOpen(state, 'main-techne')),
    railColor: demoRoles.techne.color,
    renderBody(frame, actorColor, bodyAction) {
      builder.pushProse('main-techne-dir', '（checks the line numbers, keeps the change to two files）', demoRoles.techne.color, 'direction', frame, bodyAction);
      builder.pushProse(
        'main-techne-prose',
        "Aletheia's locations are spot on. I won't touch the project copy, just strip the extra containers and align the hero grid, so Kalon doesn't call it an unpainted shell again.",
        demoRoles.techne.color,
        'body',
        frame,
        bodyAction,
      );
      appendPermissionInteraction(builder, state, demoRoles.techne.color, frame, actorColor, 'main-techne');
      if (state.permission === 'allow') {
        builder.pushOrdinaryCard({
          id: 'main-edit',
          ownerId: 'techne',
          kind: 'Tool',
          title: state.runtime ? 'Plan · Layout and styles (not applied)' : 'Edit · Layout and styles',
          bodyLines: [
            'src/pages/index.tsx:18 — tighten hero primary/secondary hierarchy, remove duplicate blurb node',
            state.runtime ? 'src/styles/home.css:96 — suggest merging nested narrow-screen padding (48px → 18px); not yet verified' : 'src/styles/home.css:96 — merge nested narrow-screen padding (48px → 18px); grid assertions pass',
          ],
          status: 'Completed',
          open: isFoldOpen(state, 'main-edit', false),
          railColor: demoRoles.techne.color,
          parentFrame: frame,
        });
      }
    },
  });

  // Actor 3: Kalon
  const kalonReady = state.runtime ? state.runtime.kalon !== 'queued' : Boolean(state.permission);
  const kStatus = portfolioTaskStatus(state, 'kalon');
  appendActorCard(builder, {
    id: 'main-kalon',
    owner: 'kalon',
    task: demoRoles.kalon.task,
    status: kStatus,
    open: isFoldOpen(state, 'main-kalon', defaultSceneFoldOpen(state, 'main-kalon')),
    railColor: demoRoles.kalon.color,
    renderBody(frame, actorColor, bodyAction) {
      builder.pushProse(
        'main-kalon-dir',
        state.runtime ? '（studies the current hero layout plan）' : state.permission ? '（studies the freshly edited hero layout）' : '（skims the current hero stylesheet）',
        demoRoles.kalon.color,
        'direction',
        frame,
        bodyAction,
      );
      builder.pushProse(
        'main-kalon-prose',
        kalonReady
          ? state.runtime ? "The layout plan is approved. Now let's set the tone: what feel do you want for the homepage?" : "Techne has finally cleaned up the foundation. Now let's set the tone: what feel do you want for the homepage?"
          : "Once Techne has the layout skeleton sorted, I'll tune spacing, color and whitespace.",
        demoRoles.kalon.color,
        'body',
        frame,
        bodyAction,
      );
      if (kalonReady) {
        appendQuestionInteraction(builder, state, demoRoles.kalon.color, frame, actorColor, 'main-kalon');
      }
    },
  });

  if (state.style) {
    builder.pushOrdinaryCard({
      id: 'main-memory',
      ownerId: 'anamnesis',
      kind: 'Anamnesis',
      title: 'Anamnesis · Preference candidate',
      bodyLines: [`This round's preference is "${state.style}". Based on this round's answer; not yet written to long-term memory.`],
      status: 'Pending review',
      open: isFoldOpen(state, 'main-memory', false),
      railColor: logoxRail,
    });
    if (!state.runtime || state.runtime.kalon === 'completed') builder.pushProse('main-finish', 'Structure and aesthetic tuning are both wrapped up.', logoxRail, 'body');
  }
  builder.pushBlank();

  // Dynamic events (e.g. @kalon quick dispatch or follow-up messages)
  for (const event of state.events) {
    if (event.type === 'dispatch' && event.actor && event.text) {
      const role = demoRoles[event.actor];
      builder.pushTurnHeader(`main-user-${event.id}`, 'user', `→ ${role.name} · Assigned in Logox`);
      builder.pushProse(`main-user-prose-${event.id}`, event.text, palette.user, 'body');
      builder.pushBlank();

      builder.pushTurnHeader(`main-actor-turn-${event.id}`, event.actor, 'Quick dispatch');
      appendActorCard(builder, {
        id: `dispatch-${event.id}`,
        owner: event.actor,
        task: event.text.replace(/^@\w+\s*/, ''),
        status: event.status ?? 'Task received',
        open: isFoldOpen(state, `dispatch-${event.id}`, true),
        railColor: role.color,
        renderBody(frame, _actorColor, bodyAction) {
          if (event.direction) builder.pushProse(`dispatch-dir-${event.id}`, event.direction, role.color, 'direction', frame, bodyAction);
          builder.pushProse(`dispatch-reply-${event.id}`, event.reply || event.error || (event.status && event.status !== 'Queued' ? event.status : 'Task received; waiting to take the stage.'), role.color, 'body', frame, bodyAction);
        },
      });
      builder.pushBlank();
    } else if (event.type === 'main' && event.text) {
      builder.pushTurnHeader(`main-user-${event.id}`, 'user');
      builder.pushProse(`main-user-prose-${event.id}`, event.text, palette.user, 'body');
      builder.pushBlank();
      builder.pushTurnHeader(`main-reply-turn-${event.id}`, 'logox', 'Director');
      builder.pushProse(`main-reply-prose-${event.id}`, event.reply || event.error || event.status || 'Waiting to take the stage.', logoxRail, 'body');
      builder.pushBlank();
    }
  }

  for (const activity of state.runtime?.background ?? []) {
    builder.pushOrdinaryCard({id: activity.id, ownerId: 'anamnesis', kind: 'Anamnesis', title: activity.title,
      bodyLines: [activity.stage, activity.detail].filter(Boolean), status: activity.status,
      open: isFoldOpen(state, activity.id, false), railColor: logoxRail});
    builder.pushBlank();
  }

  return builder.rows;
}

function buildActorHistoryRows(
  builder: RowBuilder,
  state: DemoSceneState,
  owner: 'aletheia' | 'techne' | 'kalon',
): readonly SceneRow[] {
  const role = demoRoles[owner];
  const actorRail = role.color;
  const outerFrame: FrameWrap = {
    leftSegments: [],
    rightSegments: [],
    leftCols: 0,
    rightCols: 0,
    innerWidth: builder.contentWidth,
  };

  if (owner === 'kalon') {
    builder.pushTurnHeader('kalon-prev-dir-turn', 'logox', `→ ${role.name}`, 'Previous round · 10:02');
    builder.pushProse('kalon-prev-dir', 'Start with a read-only check of the homepage colors and information hierarchy to see where the template feel comes from.', palette.accent, 'body');
    builder.pushBlank();

    builder.pushTurnHeader('kalon-prev-turn', 'kalon', 'Aesthete', '10:03');
    builder.pushOrdinaryCard({
      id: 'kalon-previous-read',
      kind: 'Tool',
      title: 'Read · src/styles/home.css',
      bodyLines: ['L14-L52: the same high-saturation accent is applied to the title, card borders and buttons, which looks cluttered.'],
      status: 'Completed',
      open: isFoldOpen(state, 'kalon-previous-read', false),
      railColor: actorRail,
    });
    builder.pushOrdinaryCard({
      id: 'kalon-previous-thinking',
      kind: 'Thinking',
      title: 'Rein in surface decoration',
      bodyLines: ['Drop the redundant highlight borders and build order from a weight scale and whitespace.'],
      status: 'Closed',
      open: isFoldOpen(state, 'kalon-previous-thinking', false),
      railColor: actorRail,
    });
    builder.pushBlank();

    builder.pushTurnHeader('kalon-prev-user-turn', 'user', `→ ${role.name} · This window`, '10:04');
    builder.pushProse('kalon-prev-user', "I like a restrained text portfolio, but I don't want it to feel as cold as product docs.", palette.user, 'body');
    builder.pushBlank();

    builder.pushTurnHeader('kalon-prev-reply-turn', 'kalon', 'Aesthete', '10:05');
    builder.pushProse('kalon-prev-reply-dir', '（jots down a set of warm-gray values beside the swatches）', actorRail, 'direction');
    builder.pushProse(
      'kalon-prev-reply',
      'Understood. Keep the name, a clean intro and the signature work at the visual center, warm the background by half a step, and reserve the accent color for things that really need a click.',
      actorRail,
      'body',
    );
    builder.pushBlank();

    builder.pushTurnHeader('kalon-curr-dir-turn', 'logox', `→ ${role.name}`, 'Current round');
    builder.pushProse('kalon-curr-dir', "Techne is restructuring based on Aletheia's coordinates. For this round, please finish typography, color and whitespace once his skeleton is settled.", palette.accent, 'body');
    builder.pushBlank();
  } else if (owner === 'aletheia') {
    builder.pushTurnHeader('aletheia-dir-turn', 'logox', `→ ${role.name}`, 'Current round');
    builder.pushProse('aletheia-dir', 'Pin down the hierarchy problems, duplicated content and mobile whitespace on the homepage, with line-accurate coordinates.', palette.accent, 'body');
    builder.pushBlank();

    builder.pushTurnHeader('aletheia-work-turn', 'aletheia', 'Scout', 'Current round');
    const paths = ['src/pages/index.tsx:18', 'src/components/ProjectCard.tsx:42', 'src/styles/home.css:96'];
    const notes = [
      'L18-L34: h1, .tag-list and .cta-btn share the same weight and contrast, so the hero has no primary/secondary order.',
      'L42-L58: the project card subtitle repeats the hero blurb verbatim.',
      'L96-L112: @media (max-width: 560px) stacks three container paddings up to 48px.',
    ];
    for (let i = 0; i < paths.length; ++i) {
      builder.pushOrdinaryCard({
        id: `aletheia-read-${i}`,
        ownerId: 'aletheia',
        kind: 'Tool',
        title: `Read · ${paths[i]}`,
        bodyLines: [notes[i]!],
        status: 'Completed',
        open: isFoldOpen(state, `aletheia-read-${i}`, false),
        railColor: actorRail,
      });
    }
    builder.pushProse('aletheia-dir-line', '（tidies up the three location notes）', actorRail, 'direction');
    builder.pushProse(
      'aletheia-reply',
      'Source coordinates for all three problems are verified (index.tsx:18, ProjectCard.tsx:42, home.css:96) and handed to Logox and Techne.',
      actorRail,
      'body',
    );
    builder.pushBlank();
  } else {
    builder.pushTurnHeader('techne-dir-turn', 'logox', `→ ${role.name}`, 'Current round');
    builder.pushProse('techne-dir', "Adjust the hero skeleton using Aletheia's exact coordinates, keeping the user's existing project content.", palette.accent, 'body');
    builder.pushBlank();

    builder.pushTurnHeader('techne-work-turn', 'techne', 'Requests edit permission from the user', 'Current round');
    builder.pushOrdinaryCard({
      id: 'techne-read',
      ownerId: 'techne',
      kind: 'Tool',
      title: 'Read · src/pages/index.tsx:18',
      bodyLines: ['Check the L18-L34 component tree and style references; confirm the edit has no external side effects.'],
      status: 'Completed',
      open: isFoldOpen(state, 'techne-read', false),
      railColor: actorRail,
    });
    builder.pushOrdinaryCard({
      id: 'techne-thinking',
      ownerId: 'techne',
      kind: 'Thinking',
      title: 'Narrow the edit scope',
      bodyLines: ['Touch only structural fit and responsive padding, strictly within two files.'],
      status: 'Closed',
      open: isFoldOpen(state, 'techne-thinking', false),
      railColor: actorRail,
    });
    const permOpen = isFoldOpen(state, 'history-techne-question', defaultSceneFoldOpen(state, 'history-techne-question'));
    if (state.permission || !permOpen) {
      builder.pushOrdinaryCard({
        id: 'history-techne-question',
        ownerId: 'techne',
        kind: 'Permission',
        title: 'Allow file edits',
        bodyLines: [state.permission ? 'This permission has been answered; the decision is kept below.' : 'Expand the card to answer the edit permission.'],
        status: state.permission ? 'Answered' : state.runtime?.permissionRequest?.status === 'cancelled' ? 'Cancelled' : 'Awaiting answer',
        open: permOpen,
        railColor: actorRail,
      });
    } else {
      const cardBg = ownerSurface('techne', true) ?? palette.cardExpanded;
      const histFrame: FrameWrap = {
        leftSegments: [],
        rightSegments: [],
        leftCols: 0,
        rightCols: 0,
        innerWidth: builder.contentWidth,
        bg: cardBg,
      };
      builder.pushCardCap('history-techne-question-top', 'top', cardBg, actorRail, outerFrame);
      appendPermissionInteraction(builder, state, actorRail, insetFrame(histFrame, cardBg), actorRail, 'history-techne-question');
      builder.pushCardCap('history-techne-question-bottom', 'bottom', cardBg, actorRail, outerFrame);
    }
    builder.pushBlank();
  }

  if (owner === 'kalon' && state.runtime?.styleRequest && !state.permission) {
    appendQuestionInteraction(builder, state, actorRail, outerFrame, actorRail, 'history-kalon-question');
    builder.pushBlank();
  }
  for (const event of state.events) {
    if ((event.type === 'dispatch' || event.type === 'direct') && event.actor === owner && event.text) {
      const origin = event.type === 'dispatch' ? `→ ${role.name} · From Logox window @${owner}` : `→ ${role.name} · This window`;
      builder.pushTurnHeader(`hist-user-${event.id}`, 'user', origin);
      builder.pushProse(`hist-user-prose-${event.id}`, event.text, palette.user, 'body');
      builder.pushBlank();

      builder.pushTurnHeader(`hist-actor-${event.id}`, owner);
      if (event.direction) builder.pushProse(`hist-actor-dir-${event.id}`, event.direction, actorRail, 'direction');
      builder.pushProse(`hist-actor-reply-${event.id}`, event.reply || event.error || event.status || 'Waiting to take the stage.', actorRail, 'body');
      if (event.reply && event.status && event.status !== 'Completed') builder.pushProse(`hist-actor-state-${event.id}`, event.status, actorRail, 'direction');
      builder.pushBlank();
    } else if (event.type === 'permission' && owner === 'techne') {
      builder.pushTurnHeader(`hist-perm-user-${event.id}`, 'user', `→ Techne · ${event.from || 'Decision'}`);
      builder.pushProse(`hist-perm-user-prose-${event.id}`, event.value === 'allow' ? 'Allow this edit once.' : 'Do not modify files.', palette.user, 'body');
      builder.pushBlank();

      builder.pushTurnHeader(`hist-perm-techne-${event.id}`, 'techne');
      if (event.value === 'allow') {
        builder.pushOrdinaryCard({
          id: `techne-edit-${event.id}`,
          kind: 'Tool',
          title: state.runtime ? 'Plan · Layout and styles (not applied)' : 'Edit · Layout and styles',
          bodyLines: ['src/pages/index.tsx:18: tighten hero primary/secondary hierarchy. src/styles/home.css:96: merge nested narrow-screen padding.'],
          status: 'Completed',
          open: isFoldOpen(state, `techne-edit-${event.id}`, false),
          railColor: actorRail,
        });
        builder.pushProse(`hist-perm-dir-${event.id}`, state.runtime ? '（notes the demo approval）' : '（confirms all layout tests pass）', actorRail, 'direction');
      } else {
        builder.pushProse(`hist-perm-dir-${event.id}`, '（leaves the files untouched）', actorRail, 'direction');
      }
      builder.pushProse(
        `hist-perm-reply-${event.id}`,
        event.value === 'allow' ? state.runtime ? 'Demo plan approved; no files were actually modified. Kalon continues with the preference check.' : 'Structure is updated and whitespace aligned as requested; Kalon takes over the visual details.' : 'Files untouched; the restructuring plan is attached to the suggestions for Kalon.',
        actorRail,
        'body',
      );
      builder.pushBlank();
    } else if (event.type === 'permission' && owner === 'kalon') {
      builder.pushTurnHeader(`hist-handoff-${event.id}`, 'logox', `→ ${role.name}`);
      builder.pushProse(
        `hist-handoff-prose-${event.id}`,
        event.value === 'allow' ? state.runtime ? 'The layout demo plan is approved; please continue with the aesthetic preference check.' : 'Techne has finished the hero skeleton edits; continue your aesthetic tuning.' : 'The user chose not to modify source files for now; please continue with a read-only aesthetic review.',
        palette.accent,
        'body',
      );
      builder.pushBlank();

      builder.pushTurnHeader(`hist-kalon-q-${event.id}`, 'kalon', 'Asks the user about homepage mood');
      const qOpen = isFoldOpen(state, 'history-kalon-question', defaultSceneFoldOpen(state, 'history-kalon-question'));
      if (state.style || !qOpen) {
        builder.pushOrdinaryCard({
          id: 'history-kalon-question',
          kind: 'Question',
          title: 'Which mood should the homepage lean toward?',
          bodyLines: [state.style ? 'This question has been answered; the preference is kept below.' : 'Expand the card to answer the homepage mood question.'],
          status: state.style ? 'Answered' : state.runtime?.styleRequest?.status === 'cancelled' ? 'Cancelled' : 'Awaiting answer',
          open: qOpen,
          railColor: actorRail,
        });
      } else {
        const cardBg = ownerSurface('kalon', true) ?? palette.cardExpanded;
        const histFrame: FrameWrap = {
          leftSegments: [],
          rightSegments: [],
          leftCols: 0,
          rightCols: 0,
          innerWidth: builder.contentWidth,
          bg: cardBg,
        };
        builder.pushCardCap('history-kalon-question-top', 'top', cardBg, actorRail, outerFrame);
        appendQuestionInteraction(builder, state, actorRail, insetFrame(histFrame, cardBg), actorRail, 'history-kalon-question');
        builder.pushCardCap('history-kalon-question-bottom', 'bottom', cardBg, actorRail, outerFrame);
      }
      builder.pushBlank();
    } else if (event.type === 'style' && owner === 'kalon' && event.text) {
      builder.pushTurnHeader(`hist-style-user-${event.id}`, 'user', `→ Kalon · ${event.from || 'Answer'}`);
      builder.pushProse(`hist-style-user-prose-${event.id}`, event.text, palette.user, 'body');
      builder.pushBlank();

      builder.pushTurnHeader(`hist-style-kalon-${event.id}`, 'kalon');
      builder.pushProse(`hist-style-dir-${event.id}`, state.runtime ? '（notes the chosen spacing and whitespace direction）' : '（fine-tunes spacing and whitespace in the chosen direction）', actorRail, 'direction');
      builder.pushProse(
        `hist-style-reply-${event.id}`,
        state.runtime ? `"${event.text}" is queued as a candidate; the page and long-term memory are not yet written.` : `Typography, colors and whitespace are tuned to "${event.text}"; ready for your review.`,
        actorRail,
        'body',
      );
      builder.pushBlank();
    }
  }

  return builder.rows;
}
