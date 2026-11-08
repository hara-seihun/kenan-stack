import { dropAllAbandonedSchemas } from './test-db.js';

// Runs once before the suites project: a day's backlog of abandoned test schemas is dropped here, not inside the
// first database suite's beforeAll, where it used up the 10 s hook timeout (Kenan Stack intake, 2026-11-04).
export default async function setup(): Promise<void> {
  await dropAllAbandonedSchemas();
}
