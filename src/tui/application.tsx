import {useSyncExternalStore} from 'react';
import type {createApplication} from '../application.js';
import {App} from './app.js';

export function ApplicationStage({application, registerInterrupt}: {application: Awaited<ReturnType<typeof createApplication>>; registerInterrupt?: (handler: () => void) => () => void}) {
  const session = useSyncExternalStore(application.subscribeSession, application.getSessionSnapshot);
  useSyncExternalStore(application.subscribeStatus, application.getStatusSnapshot);
  return <App key={session.revision} store={application.store} sessionId={session.sessionId} stage
    authentication={application.authentication} surfaces={application.surfaces} getCommandContext={application.commandContext}
    getActors={() => application.actors.list()}
    getStatus={application.status} getQueuedCount={owner => application.getInputQueue(owner === 'logox' ? undefined : owner).queued.length} statusbar={application.statusbar} {...(registerInterrupt ? {registerInterrupt} : {})}
    onSubmit={application.submit} onDraft={application.noteDraft} onCancel={application.cancel} onClose={application.close}/>;
}
