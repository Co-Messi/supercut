import { defineConfig } from "vitest/config";

/** Without an explicit `include`, vitest walks the repo root and collects
 *  `.worktrees/<branch>/test/*.ts` alongside the real suite — a local run
 *  then reports ~305 tests from 22 files, half of them stale copies from
 *  another branch, and "tests pass locally" stops meaning anything.
 *  Scope collection to this checkout's `test/` directory only. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".worktrees/**"],
  },
});
