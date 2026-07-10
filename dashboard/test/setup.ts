import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest globals are intentionally disabled, so Testing Library cannot
// auto-register its cleanup hook. Register it explicitly to prevent mounted
// hooks/listeners from leaking into the next test file or case.
afterEach(() => cleanup());
