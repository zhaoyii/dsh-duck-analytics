/**
 * Single-process test entry.
 *
 * `node --test` runs each file in a child process, which the DSH file sandbox
 * denies; importing every suite here keeps one process and the same coverage.
 */
await import('./sql-guard.test.ts')
await import('./render.test.ts')
await import('./data-files.test.ts')
await import('./session-database.test.ts')
await import('./client-bundle.test.ts')
await import('./client-row.test.ts')
await import('./tools.test.ts')
