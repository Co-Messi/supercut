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
  <nav><div>Lumon <span>Metrics</span></div><div>Docs · Pricing</div></nav>
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

export interface DemoApp {
  url: string;
  close: () => Promise<void>;
}

export async function startDemoApp(port = 0): Promise<DemoApp> {
  const server: Server = createServer((req, res) => {
    const body = req.url?.startsWith("/dash") ? DASH : LANDING;
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
