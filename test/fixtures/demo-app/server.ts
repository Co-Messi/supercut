import { createServer, type Server } from "node:http";

/**
 * Fixture demo app — the app supercut films in tests and demos.
 *
 * A fake SaaS ("Lumon Metrics") with two routes:
 *   /      landing: headline, CTA button, signup form
 *   /dash  dashboard: animated counters, a task list with hover states
 *
 * Self-contained (inline CSS/JS, zero deps) and deliberately pretty enough
 * that rendered demo footage looks like a real product, not a test page.
 */

const LANDING = `<!doctype html><html><head><meta charset="utf-8"><title>Lumon Metrics</title><style>
  :root { --ink:#16161a; --accent:#2563eb; --bg:#fafaf7 }
  * { box-sizing:border-box; margin:0 }
  body { font-family:-apple-system,'Segoe UI',sans-serif; background:var(--bg); color:var(--ink) }
  nav { display:flex; justify-content:space-between; padding:28px 64px; font-weight:600 }
  nav span { color:var(--accent) }
  main { max-width:880px; margin:80px auto; padding:0 32px }
  h1 { font-size:56px; letter-spacing:-1.5px; line-height:1.05 }
  p.sub { font-size:20px; color:#555; margin:24px 0 40px; max-width:560px }
  #cta { background:var(--accent); color:#fff; border:0; font-size:17px; font-weight:600;
         padding:16px 36px; border-radius:10px; cursor:pointer; transition:transform .15s }
  #cta:hover { transform:translateY(-2px) }
  #signup { margin-top:64px; display:none; gap:12px }
  #signup.open { display:flex }
  #email { flex:1; max-width:360px; font-size:16px; padding:14px 18px; border:1.5px solid #ddd;
           border-radius:10px; outline-color:var(--accent) }
  #join { background:var(--ink); color:#fff; border:0; padding:14px 28px; border-radius:10px;
          font-size:16px; font-weight:600; cursor:pointer }
  #joined { display:none; margin-top:16px; color:var(--accent); font-weight:600 }
</style></head><body>
  <nav><div>Lumon <span>Metrics</span></div><div><a id="nav-dash" href="/dash" style="color:inherit;text-decoration:none">Live dashboard</a> · Pricing</div></nav>
  <main>
    <h1>Numbers your team<br>actually reads.</h1>
    <p class="sub">One dashboard for every metric that matters. Set up in two minutes, no SQL required.</p>
    <button id="cta">Get started free</button>
    <div id="signup">
      <input id="email" type="email" placeholder="you@company.com" autocomplete="off">
      <button id="join">Join</button>
    </div>
    <div id="joined">✓ You're in — check your inbox.</div>
  </main>
  <script>
    document.getElementById("cta").addEventListener("click", () => {
      document.getElementById("signup").classList.add("open");
      document.getElementById("email").focus();
    });
    document.getElementById("join").addEventListener("click", () => {
      document.getElementById("joined").style.display = "block";
    });
  </script>
</body></html>`;

const DASH = `<!doctype html><html><head><meta charset="utf-8"><title>Lumon — Dashboard</title><style>
  :root { --ink:#16161a; --accent:#2563eb; --bg:#fafaf7 }
  * { box-sizing:border-box; margin:0 }
  body { font-family:-apple-system,'Segoe UI',sans-serif; background:var(--bg); color:var(--ink) }
  header { padding:24px 48px; font-weight:600; border-bottom:1px solid #eee; background:#fff }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; padding:36px 48px }
  .card { background:#fff; border:1px solid #ececec; border-radius:14px; padding:24px;
          box-shadow:0 1px 4px rgba(0,0,0,.04) }
  .card .label { font-size:13px; color:#777; text-transform:uppercase; letter-spacing:.6px }
  .card .num { font-size:40px; font-weight:700; margin-top:8px; font-variant-numeric:tabular-nums }
  ul { list-style:none; margin:0 48px; padding:0 }
  li { background:#fff; border:1px solid #ececec; border-radius:12px; padding:18px 22px;
       margin-bottom:10px; display:flex; justify-content:space-between; transition:all .15s; cursor:pointer }
  li:hover { border-color:var(--accent); transform:translateX(4px) }
  li .tag { color:var(--accent); font-weight:600; font-size:14px }
</style></head><body>
  <header>Lumon Metrics — Live Dashboard</header>
  <div class="grid">
    <div class="card"><div class="label">Active users</div><div class="num" id="n1">0</div></div>
    <div class="card"><div class="label">Events / sec</div><div class="num" id="n2">0</div></div>
    <div class="card"><div class="label">Uptime</div><div class="num">99.99%</div></div>
  </div>
  <ul id="tasks">
    <li id="task-ship"><span>Ship weekly digest emails</span><span class="tag">On track</span></li>
    <li><span>Migrate events pipeline to v2</span><span class="tag">In review</span></li>
    <li><span>Quarterly metrics deep-dive</span><span class="tag">Planned</span></li>
  </ul>
  <script>
    let a = 0, b = 0;
    setInterval(() => {
      a = Math.min(12842, a + 257); b = Math.min(431, b + 9);
      document.getElementById("n1").textContent = a.toLocaleString();
      document.getElementById("n2").textContent = String(b);
    }, 50);
  </script>
</body></html>`;

/** third route: a query panel whose big result region is revealed only on
 *  click — exercises the changed-region (MutationObserver) focus fallback.
 *  The click also fires a transient toast (bottom-right, auto-removed after
 *  400ms): a vanished overlay must never end up inside the framed result. */
const PANEL = `<!doctype html><html><head><meta charset="utf-8"><title>Lumon — Query</title><style>
  :root { --ink:#16161a; --accent:#2563eb; --bg:#fafaf7 }
  * { box-sizing:border-box; margin:0 }
  body { font-family:-apple-system,'Segoe UI',sans-serif; background:var(--bg); color:var(--ink) }
  main { max-width:1200px; margin:48px auto; padding:0 32px }
  #reveal { background:var(--accent); color:#fff; border:0; font-size:16px; font-weight:600;
            padding:14px 30px; border-radius:10px; cursor:pointer }
  #results { display:none; margin-top:28px; background:#fff; border:1px solid #ececec;
             border-radius:14px; padding:32px; height:620px }
  #toast { position:fixed; right:24px; bottom:24px; width:300px; padding:18px 22px;
           background:var(--ink); color:#fff; border-radius:12px; font-size:14px }
</style></head><body>
  <main>
    <h2>Revenue query</h2>
    <button id="reveal">Run query</button>
    <div id="results"><h3>Q3 revenue by region</h3><p>EMEA up 34%, APAC up 21%, AMER up 12%.</p></div>
  </main>
  <script>
    document.getElementById("reveal").addEventListener("click", () => {
      document.getElementById("results").style.display = "block";
      const toast = document.createElement("div");
      toast.id = "toast";
      toast.textContent = "Query completed";
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 400);
    });
  </script>
</body></html>`;

/** fourth route: a DARK service-fleet dashboard shaped like real ops tools —
 *  six PASSIVE rows sharing one data-testid (each must survive as a distinct
 *  :nth-match entry), live-ticking latencies (text-based selectors self-
 *  invalidate), and destructive controls that must ALL be excluded: a <button>,
 *  an inline-onclick div, a bare <button>Delete-all</button>, a PASSIVE
 *  destructive-slug row (<li>delete-log-2024</li> — we can't prove it's inert,
 *  so it's fail-safe excluded), and a framework-wired "danger-row" div whose
 *  click is bound via addEventListener with NO onclick attr and NO cursor/
 *  tabindex/role signal at all — excluded purely by its destructive label. The
 *  dark surface is painted on a #root wrapper while body/html stay transparent —
 *  the React/Next shape a body-only theme probe misreads "light", so this
 *  exercises the largest-surface probe. */
const FLEET = `<!doctype html><html><head><meta charset="utf-8"><title>Lumon — Fleet</title><style>
  :root { --ink:#e8eaf2; --accent:#5b8cff; --surface:#0b0e14 }
  * { box-sizing:border-box; margin:0 }
  body { font-family:-apple-system,'Segoe UI',sans-serif }
  #root { min-height:100vh; background:var(--surface); color:var(--ink) }
  main { max-width:1000px; margin:0 auto; padding:40px 24px }
  input { width:100%; font-size:16px; padding:12px 16px; background:#141926; color:var(--ink);
          border:1px solid #232a3d; border-radius:10px; margin-top:16px }
  ul { list-style:none; padding:0; margin-top:20px }
  li { background:#11151f; border:1px solid #1d2333; border-radius:10px; padding:14px 18px;
       margin-bottom:8px; display:flex; justify-content:space-between; cursor:default }
  li:hover { border-color:var(--accent) }
  #danger, #danger-div { margin-top:28px; background:#3a1420; color:#ff9cae; border:0; padding:12px 22px;
            border-radius:8px; cursor:pointer }
</style></head><body>
  <div id="root">
  <main>
    <h2>Service fleet</h2>
    <input data-testid="service-search" placeholder="Search services…">
    <ul>
      <li data-testid="service-item"><span>orders-api</span><span class="ms">160ms</span></li>
      <li data-testid="service-item"><span>payments-worker</span><span class="ms">84ms</span></li>
      <li data-testid="service-item"><span>auth-gateway</span><span class="ms">41ms</span></li>
      <li data-testid="service-item"><span>search-indexer</span><span class="ms">203ms</span></li>
      <li data-testid="service-item"><span>media-transcoder</span><span class="ms">330ms</span></li>
      <li data-testid="service-item"><span>notification-hub</span><span class="ms">57ms</span></li>
    </ul>
    <ul><li data-testid="log-row"><span>delete-log-2024</span></li></ul>
    <button id="danger">Delete service</button>
    <div id="danger-div" data-testid="danger" onclick="return false">Delete account</div>
    <div data-testid="danger-row">delete-worker</div>
    <button>Delete-all</button>
  </main>
  </div>
  <script>
    setInterval(() => {
      for (const el of document.querySelectorAll(".ms"))
        el.textContent = (30 + Math.floor(Math.random() * 300)) + "ms";
    }, 100);
    // framework-style click binding: no onclick ATTR, handler via addEventListener
    document.querySelector('[data-testid="danger-row"]').addEventListener("click", () => {});
  </script>
</body></html>`;

/** fifth route: a LIGHT app with a full-viewport translucent modal backdrop
 *  (rgba(0,0,0,.55) over ≥60% of the screen). The backdrop out-covers the body
 *  but is NOT the page ground — the theme probe must skip non-opaque layers and
 *  still report "light", not be fooled "dark" by the overlay. */
const OVERLAY = `<!doctype html><html><head><meta charset="utf-8"><title>Lumon — Overlay</title><style>
  * { box-sizing:border-box; margin:0 }
  body { font-family:-apple-system,'Segoe UI',sans-serif; background:#fafaf7; color:#16161a }
  main { max-width:880px; margin:80px auto; padding:0 32px }
  #backdrop { position:fixed; inset:0; background:rgba(0,0,0,.55) }
  #modal { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
           background:#fff; border-radius:14px; padding:32px }
  #confirm { background:#2563eb; color:#fff; border:0; padding:14px 28px; border-radius:10px;
             font-weight:600; cursor:pointer }
</style></head><body>
  <main><h1>Your workspace is ready.</h1><p>One dashboard for every metric that matters.</p></main>
  <div id="backdrop"></div>
  <div id="modal"><h3>Confirm your plan</h3><button id="confirm">Continue</button></div>
</body></html>`;

/** SSRF-probe page for the request-gate wiring tests: fires a fetch() and a
 *  WebSocket at attacker-chosen targets from the query string — exactly the
 *  in-flight requests the guard must stop that no recipe URL check can see. */
const PROBE = `<!doctype html><html><head><meta charset="utf-8"><title>Lumon — Probe</title></head><body>
  <h1 id="t">probe page</h1><div id="status">pending</div>
  <script>
    const qs = new URLSearchParams(location.search);
    const out = { fetch: "skipped", ws: "skipped" };
    const tasks = [];
    const f = qs.get("fetch");
    if (f) tasks.push(fetch(f, { mode: "no-cors" }).then(() => { out.fetch = "ok"; }, () => { out.fetch = "blocked"; }));
    const w = qs.get("ws");
    if (w) tasks.push(new Promise((resolve) => {
      const sock = new WebSocket(w);
      sock.onopen = () => { out.ws = "open"; resolve(); };
      sock.onclose = (e) => { if (out.ws !== "open") out.ws = "closed:" + e.code; resolve(); };
      setTimeout(() => { if (out.ws === "skipped") { out.ws = "timeout"; resolve(); } }, 2500);
    }));
    Promise.all(tasks).then(() => { document.getElementById("status").textContent = JSON.stringify(out); });
  </script>
</body></html>`;

export interface DemoApp {
  url: string;
  close: () => Promise<void>;
}

export async function startDemoApp(port = 0): Promise<DemoApp> {
  const server: Server = createServer((req, res) => {
    const body = req.url?.startsWith("/dash") ? DASH
      : req.url?.startsWith("/panel") ? PANEL
      : req.url?.startsWith("/fleet") ? FLEET
      : req.url?.startsWith("/overlay") ? OVERLAY
      : req.url?.startsWith("/probe") ? PROBE
      : LANDING;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Run standalone: npx tsx test/fixtures/demo-app/server.ts
if (process.argv[1]?.endsWith("server.ts")) {
  startDemoApp(4173).then(({ url }) => console.log(`demo app: ${url}`));
}
