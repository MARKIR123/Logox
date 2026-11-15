/**
 * The image fallback: a request about to carry an image to a model whose vision mark is false carries a line of text instead,
 * so the model (and the person behind it) learns why it was not shown. Shared by actor requests (`src/kernel/request.ts`) and Automa workers.
 */
import type {ModelMessage} from '../runtime/messages.js';

/** Who reads the placeholder: an Automa worker (its dispatcher can resend the job) or an actor (the user can change its model). */
export type ImageAudience = 'worker' | 'actor';

export const IMAGE_OMITTED_WORKER_HINT = 'The dispatcher should resend the job with vision: true.';
export const IMAGE_OMITTED_ACTOR_HINT = 'Ask the user to choose a model that can see images for this actor.';

/** The text that takes an image's place. `model` is shown as `<provider>/<model>`. */
export function imageOmittedText(model: string, audience: ImageAudience): string {
  return '[Image omitted: ' + model + ' cannot see images.] ' + (audience === 'worker' ? IMAGE_OMITTED_WORKER_HINT : IMAGE_OMITTED_ACTOR_HINT);
}

/** The line a worker's Not verified section gets when any image was omitted. */
export const imagesOmittedNote = (model: string): string => 'Images were omitted: ' + model + ' cannot see images.';

/**
 * Replaces every image of user and tool messages with `imageOmittedText`, one line per image. The messages themselves are not changed;
 * `omitted` counts the images replaced and the same array comes back when there were none. The result is a pure function of its input,
 * so a request stays byte-identical between turns.
 */
export function omitImages(messages: readonly ModelMessage[], model: string, audience: ImageAudience): {readonly messages: readonly ModelMessage[]; readonly omitted: number} {
  let omitted = 0;
  const replaced = messages.map(message => {
    if ((message.role !== 'user' && message.role !== 'tool') || !message.images?.length) return message;
    const {images, ...rest} = message;
    omitted += images.length;
    return {...rest, text: [message.text, ...images.map(() => imageOmittedText(model, audience))].filter(Boolean).join('\n')} as ModelMessage;
  });
  return omitted ? {messages: replaced, omitted} : {messages, omitted: 0};
}
