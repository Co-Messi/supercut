import { createRequire } from "node:module";

/**
 * The command that installs the Chromium supercut drives.
 *
 * Playwright keeps one browser folder per revision, and each Playwright
 * version looks only for its own. A bare `npx playwright install chromium`
 * run inside an app that has its own `@playwright/test` runs that app's
 * Playwright and installs its revision, which supercut cannot use; run
 * anywhere else it fetches the latest Playwright. Naming supercut's own
 * version installs the browser supercut will look for.
 */

/** the version of the `playwright` package supercut resolves, if it resolves */
export function playwrightVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)("playwright/package.json") as { version: string }).version;
  } catch {
    return undefined;
  }
}

/** the install command for a Playwright version (bare when it is unknown) */
export function installCommandFor(version: string | undefined): string {
  return version ? `npx playwright@${version} install chromium` : "npx playwright install chromium";
}

export function chromiumInstallCommand(): string {
  return installCommandFor(playwrightVersion());
}
