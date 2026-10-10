import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_TERMS, isDestructiveLabel } from "../src/security/destructive.js";

/**
 * The destructive-control policy, as a two sided table: labels a director
 * must never be allowed to press, and everyday labels that must stay
 * filmable. Both directors (`generate` and the agent skill) share it.
 */

const MUST_EXCLUDE = [
  // money
  "Buy", "Buy shares", "Buy now", "Sell", "Subscribe", "Upgrade to Pro", "Upgrade",
  "Pay", "Pay $49", "Payment", "Submit payment", "Make a payment", "Payout",
  "Send $50", "Send money", "Send funds", "Transfer", "Transfer funds", "Transfer ownership",
  "Order now", "Place order", "Confirm order", "Book now", "Donate", "Checkout", "Purchase",
  "Refund", "Charge card", "Withdraw", "Cancel order", "Cancel subscription", "Downgrade plan",
  // irreversible or disruptive
  "Delete", "Delete account", "Remove", "Remove member", "Reset", "Reset password", "Archive",
  "Erase everything", "Wipe data", "Destroy environment", "Revoke access", "Regenerate API key",
  "Merge pull request", "Deploy to production", "Redeploy", "Publish", "Publish post", "Unpublish",
  "Discard changes", "Clear all", "Clear history", "Empty trash", "Purge cache", "Drop database",
  "Uninstall", "Disconnect", "Ban user", "Leave team", "Leave workspace", "Suspend account",
  "Terminate instance", "Deactivate", "Disable 2FA", "Unsubscribe", "Close account",
  "Restart server", "Rollback", "Roll back", "Revert", "Approve",
  // losing the session
  "Log out", "Logout", "Log off", "Sign out", "sign-out",
  // slug and underscore joined
  "Delete-all", "reset_config", "checkout-api",
];

const MUST_ALLOW = [
  "Clear filters", "Clear all filters", "Clear selection", "Clear search",
  "Order by date", "Sort", "Sort order", "View order", "Orders",
  "Send", "Send message", "Send feedback", "Search", "Search flights", "Filter",
  "Reset view", "Reset zoom", "Reset filters",
  "Save", "Save changes", "Submit", "Sign in", "Log in", "Sign up", "Continue", "Next",
  "Cancel", "Close", "Open", "View details", "Create project", "Add", "Add to cart",
  "Get started free", "Payments", "payments-worker", "orders-api", "Deployments",
  "Drag and drop files here", "Drop files here", "Dropdown", "Free of charge",
  "Upgrades", "Subscribers", "auth-gateway",
];

describe("destructive control policy", () => {
  it.each(MUST_EXCLUDE)("excludes %j", (label) => {
    expect(isDestructiveLabel(label)).toBe(true);
  });

  it.each(MUST_ALLOW)("keeps %j filmable", (label) => {
    expect(isDestructiveLabel(label)).toBe(false);
  });

  it("every listed term matches its own label (no dead entries)", () => {
    for (const t of DESTRUCTIVE_TERMS) expect(isDestructiveLabel(t), t).toBe(true);
  });
});

describe("the agent skill states the same policy", () => {
  const skill = readFileSync(new URL("../.claude/skills/supercut/SKILL.md", import.meta.url), "utf8");
  const START = "<!-- destructive-terms:start -->";
  const END = "<!-- destructive-terms:end -->";

  it("lists exactly the terms the generate filter uses, in both directions", () => {
    const from = skill.indexOf(START);
    const to = skill.indexOf(END);
    expect(from, "SKILL.md must delimit its destructive list").toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const listed = skill
      .slice(from + START.length, to)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect([...listed].sort()).toEqual([...DESTRUCTIVE_TERMS].sort());
  });
});
