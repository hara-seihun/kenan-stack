import { describe, expect, it } from 'vitest';
import { MenuWatch, briefKeys } from './phone-menu.js';

// Call c6084b75 (2026-10-19): the brief's menu instruction and the menu as GPT Live transcribed it, in its deltas.
const BRIEF = `Parle en français québécois naturel. Aujourd'hui : lundi 19 octobre, vers 10 h 30 à Montréal.

MENU TÉLÉPHONIQUE : la ligne répond par un menu ; l'option 3 est pour acheter ou vendre un instrument : fais presser 3 tout de suite. En attente, attends jusqu'à 10 minutes.

QUI : Solutions Exemple / Immobilier Modèle, +1 438 555 0142 (autre numéro connu : +1 514 555 0187). Fais une offre claire. Essai le mercredi 21 octobre (10 h–12 h ou dès 16 h).`;
const MENU = "Bienvenue chez Solutions Exemple. Nous offrons des solutions simples et rapides pour acheter ou vendre votre instrument. Si vous êtes un professionnel, partenaire ou client actuel avec nous, faites-le 1. Pour la location, faites-le 2. Pour l'achat ou la vente de votre instrument, faites-le 3. Pour toute autre question, faites-le 0 Merci d'avoir contacté Solutions Exemple.";
const deltas = (text: string) => text.split(/(?<= )/);

describe('brief menu keys', () => {
  it("takes call c6084b75's menu key from its brief and nothing from its phone numbers, times or prose", () => {
    expect(briefKeys(BRIEF)).toEqual(['3']);
    expect(briefKeys('Press 1 for French. Then press 3 for sales. Call back at 514 555 0199 if needed.')).toEqual(['1', '3']);
    expect(briefKeys('Compose le 514 555 0187 si besoin. Fais un suivi.')).toEqual([]);
  });

  it("presses 3 once when c6084b75's menu announces option 3, however the transcript is split", () => {
    const watch = new MenuWatch(briefKeys(BRIEF));
    const pressed = deltas(MENU).map(d => watch.person(d)?.key).filter(Boolean);
    expect(pressed).toEqual(['3']);
    expect(watch.remaining).toEqual([]);
    expect(watch.person(' Pour les prêts, faites-le 2.')).toBeNull();
  });

  it('understands spoken keys and English menus, and waits for the right option', () => {
    const watch = new MenuWatch(briefKeys('Press 1 for English, then press 2 for billing.'));
    expect(watch.person('For service in English, press one.')?.key).toBe('1');
    expect(watch.person(' For sales, press 1. For billing,')).toBeNull();
    expect(watch.person(' press two.')?.key).toBe('2');
  });

  it("counts the call agent's own presses", () => {
    const watch = new MenuWatch(briefKeys('Appuie sur 3 au menu.'));
    watch.pressed('3');
    expect(watch.person('Pour les ventes, faites le 3.')).toBeNull();
  });
});

// Call 10b48b42 (2026-10-19): the 1 was pressed after the menu ended, did not register, and the menu replayed twice.
const ACHAT_DIRECT = "Bienvenue chez Achat Exemple. Pour le français, faites le 1. Pour l'anglais, faites le 2. Pour l'espagnol, faites le 3 ";
describe('menu replays', () => {
  it("presses the brief's key again each time call 10b48b42's menu replays the option, at most twice", () => {
    const watch = new MenuWatch(briefKeys("Dès que tu entends ce menu, demande immédiatement qu'on presse la touche 1 (délégation de touches)."));
    const presses = [0, 1, 2, 3].flatMap(() => deltas(ACHAT_DIRECT).map(d => watch.person(d)).filter(Boolean));
    expect(presses).toEqual([{ key: '1', why: 'brief' }, { key: '1', why: 'replay' }, { key: '1', why: 'replay' }]);
  });

  it("presses the call agent's key again when the menu replays its option, but not for a different menu", () => {
    const watch = new MenuWatch([]);
    deltas(ACHAT_DIRECT).forEach(d => watch.person(d));
    watch.pressed('1');
    expect(deltas(ACHAT_DIRECT).map(d => watch.person(d)).filter(Boolean)).toEqual([{ key: '1', why: 'replay' }]);
    const other = new MenuWatch([]);
    deltas(ACHAT_DIRECT).forEach(d => other.person(d));
    other.pressed('1');
    expect(other.person('Pour un nouvel achat, faites le 1. Pour une vente, faites le 2.')).toBeNull();
  });
});
