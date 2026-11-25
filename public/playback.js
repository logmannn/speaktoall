// Spoken-translation queue for listener phones, kept free of DOM code so it can be tested.
// The server releases audio in speech order, so clips play first-in, first-out.
// Playback speeds up a little when clips pile up and slows down once caught up.
export const MIN_RATE = 1;
export const MAX_RATE = 1.4;
export const RATE_STEP = 0.1;

export class PlaybackQueue {
  // play(clip, rate) starts a clip; call finished() when it ends or fails.
  // setRate(rate) changes the speed of the clip that is playing now.
  constructor({ play, setRate = () => {} }) {
    this.play = play;
    this.setRate = setRate;
    this.enabled = false;
    this.queue = [];
    this.playing = false;
    this.rate = MIN_RATE;
  }

  get backlog() {
    return this.queue.length;
  }

  push(clip) {
    if (!this.enabled) return;
    this.queue.push(clip);
    if (this.queue.length >= 2) this.adjustRate(RATE_STEP);
    this.next();
  }

  finished() {
    if (!this.playing) return;
    this.playing = false;
    if (!this.queue.length) this.adjustRate(-RATE_STEP);
    this.next();
  }

  clear() {
    this.queue = [];
    this.playing = false;
    this.adjustRate(MIN_RATE - this.rate);
  }

  next() {
    if (this.playing || !this.enabled || !this.queue.length) return;
    this.playing = true;
    this.play(this.queue.shift(), this.rate);
  }

  adjustRate(delta) {
    // Round so repeated 0.1 steps land exactly on 1.0 and 1.4.
    const rate = Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, this.rate + delta)) * 100) / 100;
    if (rate === this.rate) return;
    this.rate = rate;
    this.setRate(rate);
  }
}
