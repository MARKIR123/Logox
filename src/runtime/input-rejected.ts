/** The input was refused before anything ran; the draft stays in the composer and the refusal is only flashed, not written to the timeline. */
export class InputRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputRejected';
  }
}
