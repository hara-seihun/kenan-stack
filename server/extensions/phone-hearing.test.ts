import { describe, expect, it } from 'vitest';
import { HearingWatch, goodbyeHangUp, hearingNote, type HearingCue } from './phone-hearing.js';

type Step = ['kenan' | 'person', string, number];
/** Feeds a call's transcripts word by word, 300 ms a word from each step's start on the session timeline, in the order
 *  the bridge receives them: the person's transcript arrives a second after the words, Kenan's as they are spoken. */
function replay(steps: Step[]): { cue: HearingCue; atMs: number }[] {
  const watch = new HearingWatch();
  const events = steps.flatMap(([who, text, startMs]) => text.split(/(?<= )/).map((delta, i) => {
    const said = { delta, startMs: startMs + i * 300, endMs: startMs + (i + 1) * 300 };
    return { who, said, arrivesMs: said.endMs + (who === 'person' ? 1000 : 0) };
  })).sort((a, b) => a.arrivesMs - b.arrivesMs);
  return events.flatMap(({ who, said, arrivesMs }) => {
    if (who === 'kenan') { watch.kenan(said); return []; }
    const cue = watch.person(said);
    return cue ? [{ cue, atMs: arrivesMs }] : [];
  });
}

// Call 488e7d78 (2026-10-19) as transcribed, with times approximated from the bridge's turn log.
const CALL: Step[] = [
  ['kenan', "Bonjour Monsieur Tremblay, ici Kenan, l'assistant de Jordan Lee pour le piano à vendre. Désolé pour l'appel silencieux de tout à l'heure, ", 16000],
  ['person', 'Oui ', 23900],
  ['kenan', "c'était un problème de ligne de notre côté. Vous avez deux minutes ? ", 24400],
  ['person', 'Oui ', 28500],
  ['kenan', "Merci. Je voulais juste m'assurer que vous avez bien reçu le dossier complet qu'on vous a envoyé ce matin par courriel. ", 29500],
  ['person', 'Oui ', 36000],
  ['kenan', "Parfait, tant mieux. Une offre écrite, claire, avec vos conditions, c'est pris au sérieux. Elle les regarde jeudi soir. ", 37000],
  ['person', 'OK maintenant ', 43500],
  ['kenan', "Oui, c'est ça, d'ici jeudi 22 octobre à 17h. Vous pouvez l'envoyer à l'adresse offres ", 45000],
  ['person', 'Quelle heure maintenant ', 50300],
  ['kenan', 'Là on est vers 11 h à Montréal. Donc vous avez encore quelques jours. ', 52000],
  ['person', 'Quelle heure maintenant ', 63000],
  ['kenan', 'Vers 11 h à Montréal. ', 65400],
];

describe('hearing on a call', () => {
  it("tells GPT it was cut off giving 488e7d78's address, then that the person asked the same thing again", () => {
    const cues = replay(CALL);
    expect(cues.map(c => c.cue.kind)).toEqual(['cut-off', 'repeat']);
    const [cut, repeat] = cues;
    expect(cut!.cue).toEqual({ kind: 'cut-off', said: expect.stringMatching(/Vous pouvez l'envoyer à l'adresse offres$/) });
    expect(cut!.atMs).toBeLessThan(52_000);
    expect(repeat!.atMs).toBeLessThan(65_000);
    expect(repeat!.cue).toMatchObject({ kind: 'repeat', asked: 'Quelle heure maintenant', cutOff: expect.stringMatching(/l'adresse offres$/) });
    expect(hearingNote(repeat!.cue)).toContain("l'adresse offres");
  });

  it('ignores backchannels over Kenan, acknowledgements said twice, finished sentences and menus replaying', () => {
    expect(replay([['kenan', 'Désolé pour le silence de tout à l\'heure, ', 0], ['person', 'Oui ', 2300], ['kenan', "c'était la ligne. ", 2700]])).toEqual([]);
    expect(replay([['kenan', 'Vous avez reçu le dossier ? ', 0], ['person', "Oui d'accord ", 3000], ['kenan', 'Parfait. ', 4000], ['person', "Oui d'accord ", 5000]])).toEqual([]);
    const menu = "Bienvenue chez Achat Exemple. Pour le français, faites le 1. Pour l'anglais, faites le 2. Pour l'espagnol, faites le 3 ";
    expect(replay([['person', menu, 0], ['kenan', 'Bonjour. ', 3000], ['person', menu, 4000]])).toEqual([]);
  });

  it("takes the NRC clock's announcement, replayed with the next time, for a recording (call 9d89b14a)", () => {
    const clock = (seconds: string) => `NRC. Eastern Daylight Time. nineteen hours twenty-six minutes and ${seconds} seconds `;
    expect(replay([
      ['person', clock('ten'), 0], ['kenan', 'This is a short latency test. ', 4500],
      ['person', clock('twenty'), 10_000], ['kenan', 'Je crois que je n\'ai pas compris, vous ', 14_000],
      ['person', clock('thirty'), 15_000], ['person', clock('forty'), 25_000],
    ])).toEqual([]);
    const hold = 'Thank you for holding, your call is important to us, please stay on the line ';
    expect(replay([['person', hold, 0], ['kenan', 'Hello? ', 5000], ['person', hold, 7000]])).toEqual([]);
  });

  it('still hears a person who asks the same short question twice, numbers and all', () => {
    const cues = replay([['person', 'Is it at 5 ', 0], ['kenan', 'It is on Thursday. ', 1500], ['person', 'Is it at 5 ', 4000]]);
    expect(cues.map(c => c.cue.kind)).toEqual(['repeat']);
  });

  it('answers a person who repeats an unclear question once, not every time', () => {
    const cues = replay([['person', 'Vous êtes qui déjà ', 0], ['kenan', "Kenan, l'assistant de Jordan. ", 1000], ['person', 'Vous êtes qui déjà ', 3000], ['person', 'qui ', 3500]]);
    expect(cues.map(c => c.cue)).toMatchObject([{ kind: 'repeat', answered: "Kenan, l'assistant de Jordan.", cutOff: null }]);
  });

  it('knows the question again when the first time ran on from a yes', () => {
    const cues = replay([['kenan', 'Vous avez reçu le dossier ? ', 0], ['person', "Oui je l'ai reçu quelle heure maintenant ", 2000], ['kenan', 'Il est 10 h 53. ', 5000], ['person', 'Quelle heure maintenant ', 8000]]);
    expect(cues.map(c => c.cue.kind)).toEqual(['repeat']);
  });
});

describe('hanging up after goodbye', () => {
  const base = { goodbyeAt: 0, lastSpeech: 0, lastKenanVoice: 0, pendingReplies: 0 };
  it('waits for Kenan\'s audio, not just its transcript, and for a reply still being written', () => {
    expect(goodbyeHangUp({ ...base, now: 4000, lastKenanVoice: 3500 }).kind).toBe('wait');
    expect(goodbyeHangUp({ ...base, now: 4000, pendingReplies: 1 })).toEqual({ kind: 'hold', pendingReplies: 1 });
    expect(goodbyeHangUp({ ...base, now: 4000 })).toEqual({ kind: 'end', unanswered: 0 });
    expect(goodbyeHangUp({ ...base, now: 21_000, lastSpeech: 17_000, lastKenanVoice: 17_000, pendingReplies: 1 })).toEqual({ kind: 'end', unanswered: 1 });
  });
  it('ends a call whose voice stream never goes quiet once nobody has said a word for a while (call 9cbb9e63)', () => {
    const hum = (now: number) => goodbyeHangUp({ ...base, now, lastKenanVoice: now }).kind;
    expect(hum(5000)).toBe('wait');
    expect(hum(16_000)).toBe('end');
    expect(goodbyeHangUp({ ...base, now: 16_000, lastSpeech: 10_000, lastKenanVoice: 16_000 }).kind).toBe('wait');
  });
});
