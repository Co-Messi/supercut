/**
 * The destructive-control policy: the single source for which labels a
 * director may never press on the live app. `generate` excludes matching
 * controls from the crawl inventory (so the script stage can never reference
 * one), and the agent skill (.claude/skills/supercut/SKILL.md) lists the same
 * terms for a coding agent acting as the director; a test keeps the two equal.
 *
 * A label is destructive when it contains one of these terms as a whole word,
 * after `_` is read as a space (so `reset_config` and `checkout-api` match).
 * The criterion: firing the control by accident on a live app is costly AND
 * hard to undo (it loses data, state or access, moves money, ships something,
 * or ends the session). A false exclusion is loud (logged, with an opt-in
 * flag); a false inclusion is a real action in someone's app, so ties go to
 * exclusion.
 *
 * Best effort, English only: it reads visible text, aria-label and value. It
 * cannot see icon-only controls, other languages, or unusual wording, so film
 * staging data, never production.
 */

interface PolicyEntry {
  /** the human-readable term, as listed in SKILL.md */
  term: string;
  /** regex source (case-insensitive, whole word) covering the term's forms */
  pattern: string;
}

const POLICY: readonly PolicyEntry[] = [
  // data loss
  { term: "Delete", pattern: "delete" },
  { term: "Remove", pattern: "remove" },
  { term: "Erase", pattern: "erase" },
  { term: "Wipe", pattern: "wipe" },
  { term: "Destroy", pattern: "destroy" },
  { term: "Purge", pattern: "purge" },
  { term: "Drop", pattern: "drop" },
  { term: "Discard", pattern: "discard" },
  { term: "Clear all", pattern: "clear\\s+(?:all|everything|data|history|cache)" },
  { term: "Empty trash", pattern: "empty\\s+(?:the\\s+)?(?:trash|bin|recycle\\s+bin|cart)" },
  { term: "Reset", pattern: "reset" },
  { term: "Revert", pattern: "revert" },
  { term: "Rollback", pattern: "roll\\s*back" },
  { term: "Archive", pattern: "archive" },
  { term: "Regenerate", pattern: "regenerate" },
  // access and accounts
  { term: "Deactivate", pattern: "deactivate" },
  { term: "Disable", pattern: "disable" },
  { term: "Suspend", pattern: "suspend" },
  { term: "Terminate", pattern: "terminate" },
  { term: "Revoke", pattern: "revoke" },
  { term: "Ban", pattern: "ban" },
  { term: "Disconnect", pattern: "disconnect" },
  { term: "Uninstall", pattern: "uninstall" },
  { term: "Close account", pattern: "close\\s+(?:my\\s+)?account" },
  { term: "Leave team", pattern: "leave\\s+(?:the\\s+|this\\s+)?(?:team|workspace|organi[sz]ation|org|group|channel|server|project|company)" },
  { term: "Log out", pattern: "log[\\s-]*(?:out|off)" },
  { term: "Sign out", pattern: "sign[\\s-]*out" },
  // shipping changes
  { term: "Publish", pattern: "(?:un)?publish" },
  { term: "Deploy", pattern: "(?:re)?deploy" },
  { term: "Merge", pattern: "merge" },
  { term: "Approve", pattern: "approve" },
  { term: "Restart", pattern: "restart|reboot|shut\\s*down" },
  // money
  { term: "Pay", pattern: "pay(?:ing)?" },
  { term: "Payment", pattern: "payment" },
  { term: "Payout", pattern: "payout" },
  { term: "Buy", pattern: "buy" },
  { term: "Sell", pattern: "sell" },
  { term: "Purchase", pattern: "purchase" },
  { term: "Checkout", pattern: "checkout" },
  { term: "Subscribe", pattern: "(?:un)?subscribe" },
  { term: "Upgrade", pattern: "upgrade" },
  { term: "Downgrade", pattern: "downgrade" },
  { term: "Donate", pattern: "donate" },
  { term: "Refund", pattern: "refund" },
  { term: "Charge", pattern: "charge" },
  { term: "Withdraw", pattern: "withdraw" },
  { term: "Transfer", pattern: "transfer" },
  { term: "Send money", pattern: "send\\s+(?:money|funds|payment|[$€£¥]\\s*\\d+)" },
  { term: "Order now", pattern: "(?:order\\s+now|(?:place|confirm|submit)\\s+(?:my\\s+|the\\s+)?order)" },
  { term: "Book now", pattern: "(?:book\\s+now|confirm\\s+booking)" },
  { term: "Cancel order", pattern: "cancel\\s+(?:my\\s+|the\\s+)?(?:order|subscription|account|plan|membership|booking|reservation|payment|trip)" },
];

/** every term, in policy order: the list SKILL.md must repeat exactly */
export const DESTRUCTIVE_TERMS: readonly string[] = POLICY.map((p) => p.term);

/** the whole lexicon as one case-insensitive, whole-word regex */
export const DESTRUCTIVE_RE = new RegExp(`\\b(?:${POLICY.map((p) => p.pattern).join("|")})\\b`, "i");

/**
 * Phrases that contain a lexicon word but change only what the viewer sees,
 * never the app's data: a filter, a camera view, an upload drop zone. They
 * are removed from the label before the lexicon runs, so "Clear all filters"
 * and "Reset view" stay filmable while "Clear all" and "Reset" do not.
 */
const VIEW_ONLY_RE =
  /\b(?:clear\s+all\s+(?:filters?|selections?)|reset\s+(?:the\s+)?(?:view|zoom|filters?|search|sort|layout\s+view)|drag\s+(?:and|&|n)\s+drop|drop\s+(?:your\s+|a\s+|the\s+)?(?:files?|images?|photos?|documents?)(?:\s+here)?|drop\s+(?:here|zone|down)|free\s+of\s+charge|no\s+charge)\b/gi;

/**
 * True when a control with this label must not be filmed by default. Plain
 * lexicon match on the label text (hyphen, underscore and space joined forms
 * all count), after view-only phrases are set aside. Whether a slug-shaped
 * content name ("checkout-api") is kept is not decided here: the crawl judges
 * a container by its own label (see inventory.ts).
 */
export function isDestructiveLabel(label: string): boolean {
  return DESTRUCTIVE_RE.test(label.replace(/_/g, " ").replace(VIEW_ONLY_RE, " "));
}
