// Vitest's JSON reporter omits errors outside assertions, even when they make the process fail.
import { writeFileSync } from 'node:fs';

export default class BackgroundErrors {
  onTestRunEnd(_modules, errors) {
    writeFileSync(process.env.KENAN_BACKGROUND_ERRORS, JSON.stringify(errors.map(error => ({
      file: error.VITEST_TEST_PATH || '<test runner>',
      name: error.type || error.name || 'Unhandled error',
      messages: [error.stack || error.message || String(error)],
    })), null, 2) + '\n');
  }
}
