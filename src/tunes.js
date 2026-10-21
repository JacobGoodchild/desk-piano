// Well-known public-domain tunes for "Follow a tune": the on-screen keyboard shows the next key.
import { parseNote } from './notes.js';

const T = (name, notes) => ({ name, notes: notes.trim().split(/\s+/).map(parseNote) });

export const TUNES = [
  T('C major scale', 'C4 D4 E4 F4 G4 A4 B4 C5 B4 A4 G4 F4 E4 D4 C4'),
  T('Mary had a little lamb', 'E4 D4 C4 D4 E4 E4 E4 D4 D4 D4 E4 G4 G4 E4 D4 C4 D4 E4 E4 E4 E4 D4 D4 E4 D4 C4'),
  T('Twinkle, twinkle, little star', 'C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4 G4 G4 F4 F4 E4 E4 D4 G4 G4 F4 F4 E4 E4 D4 C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4'),
  T('Ode to joy', 'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4 D4 D4 E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4'),
  T('Frère Jacques', 'C4 D4 E4 C4 C4 D4 E4 C4 E4 F4 G4 E4 F4 G4 G4 A4 G4 F4 E4 C4 G4 A4 G4 F4 E4 C4 C4 G3 C4 C4 G3 C4'),
  T('Chromatic scale', 'C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4 C5'),
  T('Für Elise (opening, right hand)', 'E5 D#5 E5 D#5 E5 B4 D5 C5 A4 C4 E4 A4 B4 E4 G#4 B4 C5 E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4 C4 E4 A4 B4 E4 C5 B4 A4'),
  T('Minuet in G (right hand)', 'D5 G4 A4 B4 C5 D5 G4 G4 E5 C5 D5 E5 F#5 G5 G4 G4 C5 D5 C5 B4 A4 B4 C5 B4 A4 G4 F#4 G4 A4 B4 G4 B4 A4'),
  T('Jingle bells (chorus)', 'E4 E4 E4 E4 E4 E4 E4 G4 C4 D4 E4 F4 F4 F4 F4 F4 E4 E4 E4 E4 D4 D4 E4 D4 G4'),
  T('Amazing grace', 'G4 C5 E5 C5 E5 D5 C5 A4 G4 G4 C5 E5 C5 E5 D5 G5'),
];

// Follows the player through a tune: right note → next; wrong notes are counted.
export class TuneFollower {
  constructor(tune) { this.tune = tune; this.i = 0; this.wrong = 0; }
  get next() { return this.done ? null : this.tune.notes[this.i]; }
  get done() { return this.i >= this.tune.notes.length; }
  play(midi) {
    if (this.done) { if (midi === this.tune.notes[0]) { this.i = 1; this.wrong = 0; } return; }
    if (midi === this.tune.notes[this.i]) this.i++;
    else this.wrong++;
  }
  progress() {
    const n = this.tune.notes.length;
    return this.done ? `Done! ${n} notes, ${this.wrong} wrong — play the first note to go again` : `${this.i} / ${n}${this.wrong ? ` · ${this.wrong} wrong` : ''}`;
  }
}
