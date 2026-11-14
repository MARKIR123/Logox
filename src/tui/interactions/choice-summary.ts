// The one-line hint shown in place of the composer while a question or approval owns the keyboard.
import type {Interaction} from '../../runtime/contracts.js';
import type {DemoSceneState} from '../../demo/scene.js';
import {getInteractionUI} from '../../tools/ui-registry.js';
import {approvalModel} from './approval-view.js';
import {interactionState, type ResponseDraft} from './response-draft.js';

export function choiceSummaryText({demoScene, inlineRequest, request, response, scene}: {
  demoScene: boolean; inlineRequest: unknown; request: Interaction | undefined; response: ResponseDraft | undefined; scene: DemoSceneState;
}): string {
  const choiceSummary = demoScene && inlineRequest
    ? request?.kind === 'permission' ? 'Permission: ' + (scene.permissionChoice === 'allow' ? 'Allow once' : 'Deny (default)') + ' · Enter Confirm'
      : 'Choice: ' + (scene.choice === 'minimal' ? 'Restrained text portfolio' : scene.choice === 'editorial' ? 'Warm editorial' : 'Free-form answer') + ' · Enter Confirm'
    : request && response
    ? request.kind === 'permission'
      ? 'Permission: ' + (approvalModel(request, '').options[response.selected]?.id ?? 'allow_once').replace('_', ' ') + ' · Enter Confirm'
      : getInteractionUI(request)?.describe(interactionState(request, response)).hint ?? ''
    : '↑↓ Select · Enter Confirm · Esc Later';
  return choiceSummary;
}
