// src/bin/run.ts
/**
 * Starts a transport's `main()` and turns a startup failure into a one-line message on
 * stderr and exit code 1.
 *
 * The `bin` entry points call this unconditionally. They used to live inside the
 * transport modules behind an `import.meta.url === file://${process.argv[1]}` check, but
 * npm's `bin` symlink (`npx`, `npm i -g`) makes `argv[1]` the link and `import.meta.url`
 * its target, so the check never matched and the server exited 0 without a word
 * (issue #31). An entry point that is only ever executed, never imported, needs no check.
 */
export function run(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
