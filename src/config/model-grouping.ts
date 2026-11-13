/**
 * Smart model catalog folding and tier merging
 * Folds the many same-family models that proxies or providers return with thinking-effort suffixes (e.g. *-low, *-medium, *-high, *-tiered, *-thinking)
 * into a single base model, so the left/right arrow keys switch the underlying thinking level and the matching real model.
 */

import {isOpenAiReasoningModel} from './model-preferences.js';

const SUFFIX_REGEX = /^(.*?)-(low|medium|high|extra-low|max|tiered|thinking)$/;

export interface GroupedModelVariant {
  readonly id: string; // Actual model ID, e.g. gemini-3.8-flash-high
  readonly effort: string; // Matching level, e.g. high
}

export interface GroupedModel {
  readonly id: string; // Option ID in the picker
  readonly baseModel: string; // Base display name after folding, e.g. gemini-3.8-flash
  readonly provider: string;
  readonly isCurrent: boolean;
  readonly effortLevels: readonly string[];
  readonly currentEffort: string;
  readonly variantMap: Record<string, string>; // effort -> actual modelId
}

/**
 * Normalize model name suffixes to standard thinking levels
 */
function normalizeTier(suffix: string): string {
  if (suffix === 'thinking') return 'high';
  if (suffix === 'tiered') return 'auto';
  if (suffix === 'extra-low') return 'low';
  return suffix;
}

export const STANDARD_THINKING_LEVELS: readonly string[] = ['auto', 'off', 'low', 'medium', 'high', 'max'];

/**
 * Detect the unified thinking levels supported by the model and provider
 */
export function detectEffortLevels(modelId: string, provider: string): readonly string[] {
  const cleanModel = modelId.toLowerCase();
  const cleanProvider = provider.toLowerCase();

  // Known non-reasoning / embedding / audio / image models
  if (
    cleanModel.startsWith('text-embedding') ||
    cleanModel.startsWith('dall-e') ||
    cleanModel.startsWith('tts') ||
    cleanModel.startsWith('whisper') ||
    cleanModel === 'gpt-4' ||
    cleanModel === 'gpt-4-turbo' ||
    cleanModel === 'gpt-3.5-turbo' ||
    cleanModel === 'gpt-4o' ||
    cleanModel === 'gpt-4o-mini' ||
    cleanModel.includes('embedding')
  ) {
    return [];
  }

  // 1. Anthropic / Claude: all modern Claude models support thinking
  if (cleanProvider === 'anthropic' || cleanModel.includes('claude') || cleanModel.includes('fable')) {
    return STANDARD_THINKING_LEVELS;
  }

  // 2. DeepSeek: deepseek provider or models
  if (cleanProvider === 'deepseek' || cleanModel.includes('deepseek') || cleanModel.includes('reasoner') || cleanModel.includes('r1')) {
    return STANDARD_THINKING_LEVELS;
  }

  // 3. OpenAI Reasoning models (o1~o4, gpt-5*, gpt-6*, sol, luna, astra, terra, codex, daybreak, etc.)
  if (cleanProvider === 'openai' || isOpenAiReasoningModel(cleanModel)) {
    if (isOpenAiReasoningModel(cleanModel)) {
      return STANDARD_THINKING_LEVELS;
    }
  }

  // 4. Gemini thinking models
  if (cleanModel.includes('gemini') || cleanModel.includes('gemma')) {
    if (cleanModel.includes('2.5') && !cleanModel.includes('thinking')) return [];
    return STANDARD_THINKING_LEVELS;
  }

  // 5. Antigravity local/reverse proxy: models with thinking keywords or known reasoning models (claude, gemini, o1, etc.)
  if (cleanProvider === 'antigravity' && (cleanModel.includes('thinking') || cleanModel.includes('gemini') || cleanModel.includes('claude') || isOpenAiReasoningModel(cleanModel))) {
    return STANDARD_THINKING_LEVELS;
  }

  // 6. Generic models containing thinking keywords (qwq, cot, reason, etc.)
  if (cleanModel.includes('think') || cleanModel.includes('reason') || cleanModel.includes('cot') || cleanModel.includes('qwq')) {
    return STANDARD_THINKING_LEVELS;
  }

  return [];
}

/**
 * Fold and merge a provider's model list by family
 */
export function groupModelsForProvider(
  models: readonly string[],
  provider: string,
  currentModel: string
): GroupedModel[] {
  // 1. Scan candidates and group by baseModel
  const groups = new Map<string, Array<{modelId: string; tier?: string}>>();

  for (const modelId of models) {
    const match = SUFFIX_REGEX.exec(modelId);
    if (match) {
      const base = match[1]!;
      const tier = normalizeTier(match[2]!);
      const list = groups.get(base) ?? [];
      list.push({modelId, tier});
      groups.set(base, list);
    } else {
      const list = groups.get(modelId) ?? [];
      list.push({modelId, tier: 'auto'});
      groups.set(modelId, list);
    }
  }

  const result: GroupedModel[] = [];

  for (const [base, items] of groups.entries()) {
    // Fold only when a group has multiple variants of the same family
    const hasVariants = items.length > 1;

    if (hasVariants) {
      const variantMap: Record<string, string> = {};
      const tiersSet = new Set<string>();

      for (const item of items) {
        const tier = item.tier ?? 'auto';
        if (!variantMap[tier] || item.modelId === base) {
          variantMap[tier] = item.modelId;
        }
        tiersSet.add(tier);
      }

      // Without an explicit auto, point to the base name or default entry
      if (!variantMap['auto']) {
        const fallback = items.find(i => i.modelId === base)?.modelId ?? items[0]!.modelId;
        variantMap['auto'] = fallback;
        tiersSet.add('auto');
      }

      // Sort levels for display in the standard order
      const order = ['off', 'low', 'medium', 'high', 'max', 'auto'];
      const effortLevels = order.filter(t => tiersSet.has(t));

      // Check whether the current model belongs to this family
      const matchingCurrent = items.find(i => i.modelId === currentModel);
      const isCurrent = Boolean(matchingCurrent || base === currentModel);
      const currentEffort = matchingCurrent?.tier ?? 'high';

      result.push({
        id: JSON.stringify([provider, base]),
        baseModel: base,
        provider,
        isCurrent,
        effortLevels,
        currentEffort: tiersSet.has(currentEffort) ? currentEffort : (effortLevels[0] ?? 'auto'),
        variantMap,
      });
    } else {
      // Standalone model, no suffix family
      const single = items[0]!;
      const isCurrent = single.modelId === currentModel;
      const detectedLevels = detectEffortLevels(single.modelId, provider);
      result.push({
        id: JSON.stringify([provider, single.modelId]),
        baseModel: single.modelId,
        provider,
        isCurrent,
        effortLevels: detectedLevels,
        currentEffort: detectedLevels.includes('high') ? 'high' : (detectedLevels[0] ?? 'auto'),
        variantMap: {auto: single.modelId},
      });
    }
  }

  return result;
}

/**
 * Resolve the model ID to request from the selected base model and the user-adjusted thinking level
 */
export function resolveActualModel(
  grouped: GroupedModel,
  chosenEffort?: string
): {modelId: string; effort?: string} {
  const effort = chosenEffort ?? grouped.currentEffort;
  const actualModel = grouped.variantMap[effort] ?? grouped.variantMap['auto'] ?? grouped.baseModel;
  return {modelId: actualModel, effort};
}

/**
 * Filter out noise such as non-chat, embedding, speech, image generation and obsolete models
 */
export function isConversationalModel(modelId: string): boolean {
  const clean = modelId.toLowerCase();
  return !(
    clean.startsWith('text-embedding') ||
    clean.includes('embedding') ||
    clean.startsWith('dall-e') ||
    clean.startsWith('tts') ||
    clean.startsWith('whisper') ||
    clean.startsWith('babbage') ||
    clean.startsWith('davinci') ||
    clean.includes('moderation') ||
    clean.startsWith('canary') ||
    clean.startsWith('embed-')
  );
}

export interface ModelFamilyGroup {
  readonly baseModel: string;
  readonly variants: readonly string[];
  readonly effortLevels: readonly string[];
  readonly description: string;
}

/**
 * Merge a flat model ID list by family base name (extracting -low/-medium/-high/-thinking variants)
 */
export function groupModelFamilies(
  models: readonly string[],
  provider = ''
): ModelFamilyGroup[] {
  const filtered = models.filter(isConversationalModel);
  const pool = filtered.length ? filtered : models;
  const groups = new Map<string, Array<{modelId: string; tier?: string}>>();

  for (const modelId of pool) {
    const match = SUFFIX_REGEX.exec(modelId);
    if (match) {
      const base = match[1]!;
      const tier = normalizeTier(match[2]!);
      const list = groups.get(base) ?? [];
      list.push({modelId, tier});
      groups.set(base, list);
    } else {
      const list = groups.get(modelId) ?? [];
      list.push({modelId, tier: 'auto'});
      groups.set(modelId, list);
    }
  }

  const order = ['off', 'low', 'medium', 'high', 'max'];
  const result: ModelFamilyGroup[] = [];

  for (const [base, items] of groups.entries()) {
    const variants = [...new Set(items.map(i => i.modelId))];
    const tiers = order.filter(t => items.some(i => i.tier === t));
    const description =
      variants.length > 1 || tiers.length > 0
        ? `✦ ${tiers.length ? tiers.join(' / ') : 'default'} (${variants.length} variant${variants.length > 1 ? 's' : ''})`
        : '';
    result.push({
      baseModel: base,
      variants,
      effortLevels: tiers,
      description,
    });
  }

  return result;
}
