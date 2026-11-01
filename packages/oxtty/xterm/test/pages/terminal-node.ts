// Node test entry: the public module with its own bundled copy of the engine, plus the engine's crash trigger.
import * as engine from '../../../src/index.js';

export * from '../../src/index';
export const trapEngine = (engine as unknown as { __trapForTest(): void }).__trapForTest;
