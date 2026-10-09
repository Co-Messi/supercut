import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The command that installs the Chromium supercut drives.
 *
 * Playwright keeps one browser folder per revision, and each Playwright
 * version looks only for its own. Inside an app that has its own
 * `@playwright/test`, any `npx playwright ...` form (even one naming a
 * version, when the app's tree already holds a matching `playwright`) runs
 * the app's `playwright` bin and installs the app's revision, which supercut
 * cannot use. Running the CLI of the Playwright supercut itself resolved
 * installs exactly the browser supercut will look for.
 */

/** the CLI script of the `playwright` package supercut resolves, if it resolves */
export function playwrightCli(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("playwright/package.json");
    const pkg = require(pkgPath) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.playwright ?? "cli.js");
    return join(dirname(pkgPath), bin);
  } catch {
    return undefined;
  }
}

/** the install command for a Playwright CLI script (bare when it is unknown) */
export function installCommandFor(cli: string | undefined): string {
  return cli ? `node "${cli}" install chromium` : "npx playwright install chromium";
}

export function chromiumInstallCommand(): string {
  return installCommandFor(playwrightCli());
}
