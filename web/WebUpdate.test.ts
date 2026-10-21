import { expect, it } from 'vitest';
import { entryScript } from './WebUpdate.js';

it('reads the hashed entry script from a built index and from a running script URL', () => {
  expect(entryScript('<script type="module" crossorigin src="./assets/index-B3x_9kQa.js"></script><link rel="modulepreload" href="./assets/vendor-x1.js">')).toBe('index-B3x_9kQa.js');
  expect(entryScript('https://beta.kenan.example.com/assets/index-B3x_9kQa.js')).toBe('index-B3x_9kQa.js');
  expect(entryScript('<script type="module" src="/main.tsx"></script>')).toBeNull();
});
