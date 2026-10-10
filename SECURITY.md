# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use the "Report a vulnerability" button on the Security tab of https://github.com/Co-Messi/supercut. If that is not available, open an issue that says only that you have a security report and ask for a private channel, without details.

## What supercut does to the app it films

supercut drives a real browser against the URL you give it. It performs real clicks and typing, so it can change data in that app.

- Film a staging or local development instance, never production data, and never a recipe you do not trust.
- Destructive controls are left out of what the director may film by default. A control is destructive when its visible text, `aria-label` or `value` contains a term from the policy list in `src/security/destructive.ts`: data loss (Delete, Remove, Reset, Discard, Clear all, Purge, Drop and more), account and access changes (Log out, Sign out, Revoke, Ban, Leave team), shipping changes (Publish, Deploy, Merge, Approve, Restart) and money (Pay, Payment, Buy, Sell, Subscribe, Upgrade, Checkout, Transfer, Send money, Order now, Refund, Charge). View-only controls such as "Clear filters" and "Reset view" stay filmable. A text field whose form submits through a destructive control (its default submit button, an outside `form=` button, or its action URL) can be typed into, but a recipe that presses Enter in it is refused. The agent skill lists the same terms, and a test keeps the two lists equal. `--allow-destructive` turns the filter off.
- Residual risk: the filter is best effort and English only. It reads labels, so it cannot catch icon-only buttons, other languages, wording outside the list, or a side effect hidden behind a harmless label (a "Save" that emails a customer). With `--yes` (the path a coding agent or CI takes) nobody reviews the action list before the first click, so the filter is the only automated control between the director and your app. Film a disposable environment.
- Quality checks never film the app again to lengthen a hold or reframe a shot: those changes are applied to the recorded take at render time. A re-take happens only to drop a scene that failed or that the vision check cut, and it performs every action of the recipe again. There is at most one re-take, so each action runs at most twice per run, and the confirmation question says so.
- `generate` prints the full action list (every selector and every typed string) before filming. At a terminal it asks before the first click, and `--yes` skips the question. With no terminal (CI, a coding agent, piped stdin) it refuses to start unless you pass `--yes` or `--dry-run`. `--dry-run` writes `recipe.json` and stops, so you can review it and then film it with `supercut record`.

## Private network guard

Filming your own local dev app is the main use case, so localhost, RFC1918 and link-local addresses are allowed by default. For an untrusted or public target, add `--block-private-network`. It rejects localhost, RFC1918, link-local and cloud-metadata addresses, and validates every redirect hop.

```bash
supercut generate --url https://untrusted.example --block-private-network
```

`--allow-private-network` is a deprecated no-op kept for compatibility.

With the guard on, every in-flight browser request is checked against the policy before it leaves the browser. That covers navigations from clicked links and submits, `fetch` and XHR, images, scripts, and WebSocket connections, and it covers every redirect hop of each request. To see redirect hops at all, supercut makes the guarded requests itself (from Node), checks each `Location` before following it, and hands the browser the final response. A click that ends on a blocked or private page fails the scene instead of filming an error page. Service workers are blocked while the guard is on.

### Costs and limits of the guard

- A redirected page is reached through a one line stub page that replaces itself with the redirect target, so the page ends up at the right URL and the target is still fetched only once. A `307` or `308` chain that ends in a `POST` cannot be replayed that way and renders at the URL that was requested.
- Responses are buffered, not streamed. A response that never completes (a long poll or server-sent events endpoint) fails after 30 seconds.
- WebSocket gating relies on Playwright's `routeWebSocket`. On a Playwright older than 1.48, supercut prints a warning and WebSocket connections are not policy checked.
- Blocked ranges include CGNAT (`100.64.0.0/10`), `198.18.0.0/15`, multicast, and IPv6 link-local, unique-local, NAT64 and 6to4 forms of private addresses. A proxy or VPN in "fake-IP" DNS mode (for example Clash) answers every lookup from `198.18.0.0/15`, so the guard blocks every hostname there. The real destination is hidden inside the tunnel. Turn fake-IP off, or film from a machine without it.
- The guard is best effort against active DNS rebinding. It checks each hostname with a DNS lookup, and the connection makes its own lookup a moment later. A hostname built to answer "public" to the first and "private" to the second can slip between them. Enforcing at the connection would need a filtering proxy, which supercut does not ship. For a genuinely hostile target, run supercut on a machine or network namespace that cannot reach anything private.

## Data sent to an LLM provider

`generate` sends crawled page text, element labels and selectors, and optional repo notes (`--repo`) to your configured LLM provider. In vision mode it also uploads full, unredacted screenshots of your app. Text gets best effort secret redaction (keys, tokens, emails, private keys). Selectors cannot be redacted, because the model must copy them exactly, so an element whose selector would carry a secret or an identifier (a selector built from an email in link text, an id holding a token) is left out of what the director sees. Redaction cannot cover images, so do not film apps showing real customer data or secrets with vision on. Page content is wrapped in per-run unguessable markers and the prompts tell the model to treat it as data, which narrows but does not eliminate prompt injection from a hostile page. The selector whitelist and schema validation stop invented selectors.

`generate` also writes frames, recipes and director reports to `out/`. Review those before sharing. `record` and `render` never call an LLM.

An API key is only sent to its own provider. With `deepseek` or `openrouter`, a `SUPERCUT_LLM_BASE_URL` on any other host is refused, and every base URL must be `https:` (plain `http:` only for a loopback model server).

Every `generate` run has a hard LLM spend ceiling: 300000 tokens by default, tunable with `--max-tokens <n>` or `SUPERCUT_MAX_TOKENS` (`0` or `off` disables it).
