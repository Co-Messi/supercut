import { describe, expect, it } from "vitest";
import { assertSafeNavigationUrl } from "../src/security/url-policy.js";

describe("navigation URL policy", () => {
  it("blocks cloud metadata addresses by default", async () => {
    await expect(assertSafeNavigationUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private network/i);
  });

  it("blocks localhost by default but allows it explicitly", async () => {
    await expect(assertSafeNavigationUrl("http://127.0.0.1:3000/")).rejects.toThrow(/private network/i);
    await expect(assertSafeNavigationUrl("http://127.0.0.1:3000/", { allowPrivateNetwork: true })).resolves.toBeUndefined();
  });

  it("rejects redirects to private networks", async () => {
    await expect(
      assertSafeNavigationUrl("https://example.com/start", {
        finalUrl: "http://10.0.0.2/admin",
      }),
    ).rejects.toThrow(/redirect/i);
  });
});
