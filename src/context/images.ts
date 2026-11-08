import type {ImageBlock, ModelMessage} from '../runtime/messages.js';

/** The text that stands in for an image removed from a request: its file on disk, so the model can Read it again. */
export function imageReference(image: ImageBlock): string {
  return '[image: ' + (image.path ?? 'not saved') + ']';
}

/** The same message with its images replaced by `[image: <path>]` lines; messages without images are returned as is. */
export function imagesAsText<T extends ModelMessage>(value: T): T {
  if (!('images' in value) || !value.images?.length) return value;
  const {images, ...rest} = value;
  return {...rest, text: value.text + '\n' + images.map(imageReference).join('\n')} as unknown as T;
}

export function imageCount(value: ModelMessage): number {
  return 'images' in value ? value.images?.length ?? 0 : 0;
}
