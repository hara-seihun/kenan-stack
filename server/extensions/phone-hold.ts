/** Kenan's first words, held until the phone leg can carry them. An inbound call's greeting is cued while the phone leg
 *  is still being taken over, so its first frames can arrive before the phone is ready. The hold keeps them (dropping
 *  the silence before the first word) and, once the phone is ready, plays them out at real-time pace while catching up:
 *  silences longer than `keepSilent` frames are dropped until the hold is empty, and from then on frames pass straight
 *  through. */
export class VoiceHold<F> {
  private readonly held: F[] = [];
  private silentRun = 0;
  private ready = false;
  constructor(private readonly limit: number, private readonly keepSilent: number, private readonly holding: boolean) {}

  /** A frame from GPT: 'send' it to the phone now, or it was 'held' or 'dropped'. */
  push(frame: F, loud: boolean): 'send' | 'held' | 'dropped' {
    this.silentRun = loud ? 0 : this.silentRun + 1;
    if (this.ready && this.held.length === 0) return 'send';
    if (!this.ready && !this.holding) return 'dropped';
    if (this.held.length === 0 && !loud) return 'dropped';
    if (this.silentRun > this.keepSilent || this.held.length >= this.limit) return 'dropped';
    this.held.push(frame);
    return 'held';
  }
  /** The phone leg can carry audio from now on. */
  open(): void { this.ready = true; }
  /** The next held frame to play (one per 20 ms tick), or null when nothing is held. */
  next(): F | null { return this.ready ? this.held.shift() ?? null : null; }
  get size(): number { return this.held.length; }
}
