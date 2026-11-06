import type {Interaction} from '../../runtime/contracts.js';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';

type PermissionRequest = Extract<Interaction, {kind: 'permission'}>;
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'allow_project' | 'deny';
export interface ApprovalOption {readonly id: ApprovalDecision; readonly key: 'y' | 's' | 'a' | 'n'; readonly prefix: string; readonly emphasis?: string; readonly suffix?: string}
export interface ApprovalModel {
  readonly tool: string;
  readonly target: {readonly kind: 'shell' | 'target'; readonly text: string};
  readonly risk: string;
  readonly mode?: string | undefined;
  readonly options: readonly ApprovalOption[];
}
/** Segment of a styled line; renderers (Ink card and timeline rows) map it to their own primitives. */
export interface ApprovalSegment {readonly text: string; readonly color: string; readonly bold?: boolean; readonly italic?: boolean}
const PATH_KEYS = ['file_path', 'path', 'target_file', 'file', 'dir', 'cwd', 'directory'];
const URL_KEYS = ['url', 'uri'];
const MAX_TARGET = 600;
export const toolTitle = (tool: string) => tool.startsWith('mcp:') ? tool : tool.split(/[_\s]+/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');

/** A compact, human target for the call: the command for shell, the path or URL otherwise, never raw JSON. */
export function approvalTarget(tool: string, args: Readonly<Record<string, unknown>>): ApprovalModel['target'] {
  const clip = (text: string) => safeText(text.length > MAX_TARGET ? text.slice(0, MAX_TARGET) + ' …' : text);
  const command = args.command;
  if (tool.toLowerCase() === 'shell' && typeof command === 'string') return {kind: 'shell', text: clip(command.trim())};
  for (const key of [...PATH_KEYS, ...URL_KEYS]) {
    const value = args[key];
    if (typeof value === 'string' && value) return {kind: 'target', text: clip(value)};
  }
  for (const key of ['paths', 'files']) {
    const value = args[key];
    if (Array.isArray(value) && value.length) return {kind: 'target', text: clip(value.filter(item => typeof item === 'string').slice(0, 3).join(', ') + (value.length > 3 ? ' +' + (value.length - 3) + ' more' : ''))};
  }
  const parts = Object.entries(args).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 3)
    .map(([key, value]) => key + ': ' + (typeof value === 'string' && value.length > 60 ? value.slice(0, 60) + '…' : String(value)));
  return {kind: 'target', text: clip(parts.join(' · '))};
}

export function approvalModel(request: PermissionRequest, actorName: string): ApprovalModel {
  const options: ApprovalOption[] = [{id: 'allow_once', key: 'y', prefix: 'Allow once'}];
  if (request.suggestion) {
    options.push({id: 'allow_session', key: 's', prefix: 'Allow ', emphasis: request.suggestion.label, suffix: ' for this session'});
    options.push({id: 'allow_project', key: 'a', prefix: 'Always allow ', emphasis: request.suggestion.label, suffix: ' in this project'});
  }
  options.push({id: 'deny', key: 'n', prefix: 'Deny ', suffix: 'and tell ' + actorName + ' why…'});
  return {tool: toolTitle(request.tool), target: approvalTarget(request.tool, request.arguments), risk: safeText(request.reason), mode: request.mode, options};
}
export const optionIndex = (model: ApprovalModel, key: string) => model.options.findIndex(option => option.key === key);

/** One option row: `❯ Allow once        y`. `width` is the label column so the shortcuts align. */
export function optionSegments(option: ApprovalOption, selected: boolean, labelWidth: number, accent: string): ApprovalSegment[] {
  const text = option.prefix + (option.emphasis ?? '') + (option.suffix ?? '');
  const pad = ' '.repeat(Math.max(2, labelWidth - text.length + 2));
  return [
    {text: selected ? '❯ ' : '  ', color: selected ? accent : palette.muted, bold: true},
    {text: option.prefix, color: selected ? palette.fg : palette.fg, bold: selected},
    ...option.emphasis ? [{text: option.emphasis, color: palette.path, bold: selected}] : [],
    ...option.suffix ? [{text: option.suffix, color: option.id === 'deny' ? palette.muted : palette.fg, bold: false}] : [],
    {text: pad + option.key, color: palette.muted},
  ];
}
export const optionLabelWidth = (model: ApprovalModel) => Math.max(...model.options.map(option => (option.prefix + (option.emphasis ?? '') + (option.suffix ?? '')).length));
export function riskSegments(model: ApprovalModel): ApprovalSegment[] {
  return [{text: '▲ ', color: palette.warning, bold: true}, {text: model.risk, color: palette.warning},
    ...model.mode ? [{text: '  ·  mode ' + model.mode, color: palette.muted}] : []];
}
export function targetSegments(model: ApprovalModel): ApprovalSegment[] {
  return model.target.kind === 'shell' ? [{text: '$ ', color: palette.muted}, {text: model.target.text, color: palette.path}]
    : [{text: model.target.text, color: palette.path}];
}
export const approvalHint = (noting: boolean) => noting ? 'Type why · Enter send denial · Esc back' : '↑↓ choose · Enter confirm · y s a n shortcuts · Esc later';
export const noteSegments = (actorName: string, text: string): ApprovalSegment[] => [
  {text: 'Tell ' + actorName + ' why › ', color: palette.muted}, {text: text, color: palette.fg}, {text: '▌', color: palette.accent}];
