import { createServer, type Server } from "node:http";

/**
 * Capture fixture: small pages that report how the recorder operated them.
 * Every page POSTs what it observes to /log, so a test can assert on events
 * inside the filmed browser after record() has closed it.
 *
 *   /form       a search box with keyup-driven suggestions (autocomplete
 *               style); ?prefill= seeds its value. Logs load, focus (with
 *               the value the field held when focused), every key event, and
 *               the submitted value.
 *   /spa        links and buttons for every kind of page change: pushState
 *               to a new or the same path, hash change, 204, download,
 *               server redirect, JS redirect, a gate-style redirect
 *   /still      a static page that also reports DOM mutations and the
 *               root's child count (a beacon must add neither)
 *   /slow-from  a static page linking to /slow-paint, whose body arrives
 *               700ms after its document committed
 *   /stall      a button whose click blocks the main thread for 800ms
 *   anything else: 404
 */

const BASE_STYLE = `<style>
  * { box-sizing:border-box; margin:0 }
  body { font:18px -apple-system,'Segoe UI',sans-serif; background:#fafaf7; color:#16161a; padding:48px }
  a, button { display:inline-block; margin:8px 12px 8px 0; padding:12px 20px; font-size:16px;
              border:1px solid #ccc; border-radius:8px; background:#fff; color:inherit; text-decoration:none }
  input { font-size:20px; padding:10px 14px; width:420px }
  #sugg li { padding:6px 0 }
</style>`;

const SEND = `<script>
  window.send = (o) => fetch("/log", { method: "POST", keepalive: true,
    body: JSON.stringify({ ...o, path: location.pathname }) }).catch(() => {});
</script>`;

const FORM = (prefill: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Form</title>${BASE_STYLE}${SEND}</head><body>
  <h1>Find a service</h1>
  <form id="f" autocomplete="off">
    <input id="q" value="${prefill.replace(/[&"<>]/g, "")}">
    <button id="go" type="submit">Search</button>
  </form>
  <ul id="sugg"></ul>
  <script>
    const WORDS = ["payments", "payouts", "pager", "auth-gateway"];
    const q = document.getElementById("q");
    const sugg = document.getElementById("sugg");
    const keys = { down: [], press: [], up: [], input: [] };
    send({ ev: "load" });
    q.addEventListener("focus", () => send({ ev: "focus", value: q.value }));
    q.addEventListener("keydown", (e) => keys.down.push(e.key));
    q.addEventListener("keypress", (e) => keys.press.push(e.key));
    q.addEventListener("input", (e) => keys.input.push([e.inputType, e.data]));
    // autocomplete driven ONLY by keyup: insertText-only typing never fires it
    q.addEventListener("keyup", (e) => {
      keys.up.push(e.key);
      const v = q.value;
      sugg.innerHTML = v ? WORDS.filter((w) => w.startsWith(v)).map((w) => "<li>" + w + "</li>").join("") : "";
    });
    document.getElementById("f").addEventListener("submit", (e) => {
      e.preventDefault();
      send({ ev: "submit", value: q.value, suggestions: sugg.children.length, keys });
    });
  </script>
</body></html>`;

const SPA = `<!doctype html><html><head><meta charset="utf-8"><title>SPA</title>${BASE_STYLE}</head><body>
  <h1 id="title">Overview</h1>
  <div>
    <button id="push-new" onclick="history.pushState({}, '', '/spa/reports'); document.getElementById('title').textContent = 'Reports'">Reports</button>
    <button id="push-same" onclick="history.pushState({}, '', location.pathname + '?tab=' + Math.random().toString(36).slice(2))">Filter</button>
    <button id="hash" onclick="location.hash = 'section-' + Math.random().toString(36).slice(2)">Jump</button>
    <button id="push-twice" onclick="history.pushState({}, '', '/spa/a'); setTimeout(() => history.pushState({}, '', '/spa/b'), 100)">Two hops</button>
  </div>
  <div>
    <a id="no-content" href="/no-content">Ping</a>
    <a id="download" href="/download">Export CSV</a>
    <a id="server-redirect" href="/redirect?to=/form">Server redirect</a>
    <a id="js-redirect" href="/bounce">JS redirect</a>
    <a id="to-form" href="/form">Form</a>
  </div>
</body></html>`;

/** loads, then immediately replaces itself: two document commits, one page change */
const BOUNCE = `<!doctype html><html><head><meta charset="utf-8"><title>Bounce</title></head><body>
  <script>location.replace("/form")</script>
</body></html>`;

const STILL = `<!doctype html><html><head><meta charset="utf-8"><title>Still</title>${BASE_STYLE}${SEND}</head><body>
  <h1>Nothing moves here</h1>
  <p id="p">A static page. Its frames must not change while it is filmed.</p>
  <script>
    let mutations = 0;
    // from DOMContentLoaded: the parser's own insertions are not mutations
    // anyone filmed the page for
    addEventListener("DOMContentLoaded", () => {
      new MutationObserver((records) => { mutations += records.length; })
        .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    setInterval(() => send({
      ev: "still", mutations, rootChildren: document.documentElement.children.length,
      bodyChildren: document.body.children.length,
    }), 500);
  </script>
</body></html>`;

const SLOW_FROM = `<!doctype html><html><head><meta charset="utf-8"><title>Before</title>${BASE_STYLE}</head><body>
  <h1>Old page</h1>
  <a id="go" href="/slow-paint">Open the slow page</a>
</body></html>`;

const SLOW_HEAD = `<!doctype html><html><head><meta charset="utf-8"><title>Slow</title>${BASE_STYLE}</head>`;
const SLOW_BODY = `<body style="background:#1d3b8f;color:#fff"><h1>New page, painted late</h1></body></html>`;

const STALL = `<!doctype html><html><head><meta charset="utf-8"><title>Stall</title>${BASE_STYLE}</head><body>
  <h1>Heavy page</h1>
  <button id="run">Run query</button>
  <p id="out"></p>
  <script>
    document.getElementById("run").addEventListener("click", () => {
      const end = performance.now() + 800;
      while (performance.now() < end) { /* a long task: chart layout, say */ }
      document.getElementById("out").textContent = "done";
    });
  </script>
</body></html>`;

/** a target that moves while the cursor travels to it: 150ms after the first
 *  pointer move, a banner pushes it down and a decoy takes its old place */
const MOVING = `<!doctype html><html><head><meta charset="utf-8"><title>Moving</title>${BASE_STYLE}${SEND}
<style>#banner{display:none;height:240px;background:#fde68a} #decoy{position:absolute;left:48px;top:120px;width:220px;height:56px;display:none}
#target{width:220px;height:56px}</style></head><body>
  <h1>Pick one</h1>
  <div id="banner">New: something shifted the layout</div>
  <button id="target">Open report</button>
  <button id="decoy">Not this one</button>
  <script>
    let armed = false;
    addEventListener("mousemove", () => {
      if (armed) return;
      armed = true;
      setTimeout(() => {
        document.getElementById("banner").style.display = "block";
        const d = document.getElementById("decoy");
        const r = document.getElementById("target").getBoundingClientRect();
        d.style.display = "block";
        d.style.top = (r.top - 240 + scrollY) + "px";
      }, 150);
    });
    for (const id of ["target", "decoy"]) {
      document.getElementById(id).addEventListener("mousedown", () => send({ ev: "down", id }));
      document.getElementById(id).addEventListener("click", () => send({ ev: "click", id }));
    }
  </script>
</body></html>`;

/** a target that an overlay covers while the cursor travels to it, and keeps
 *  covering: the press must never happen */
const COVERED = `<!doctype html><html><head><meta charset="utf-8"><title>Covered</title>${BASE_STYLE}${SEND}
<style>#overlay{display:none;position:fixed;inset:0;background:rgba(20,20,20,.35);z-index:10}
#overlay button{position:absolute;left:40%;top:40%}</style></head><body>
  <h1>Covered</h1>
  <button id="target">Open report</button>
  <div id="overlay"><button id="undo">Undo delete</button></div>
  <script>
    let armed = false;
    addEventListener("mousemove", () => {
      if (armed) return;
      armed = true;
      setTimeout(() => { document.getElementById("overlay").style.display = "block"; }, 150);
    });
    for (const id of ["target", "overlay", "undo"]) {
      document.getElementById(id).addEventListener("mousedown", (e) => { e.stopPropagation(); send({ ev: "down", id }); });
      document.getElementById(id).addEventListener("click", (e) => { e.stopPropagation(); send({ ev: "click", id }); });
    }
  </script>
</body></html>`;

export interface CaptureApp {
  url: string;
  /** bodies POSTed to /log, oldest first */
  logs: Record<string, unknown>[];
  /** GET count per path (query stripped) */
  hits: Map<string, number>;
  close: () => Promise<void>;
}

export async function startCaptureApp(): Promise<CaptureApp> {
  const logs: Record<string, unknown>[] = [];
  const hits = new Map<string, number>();
  const html = (res: import("node:http").ServerResponse, body: string, status = 200) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    if (req.method === "GET") hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    if (url.pathname === "/log" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try { logs.push(JSON.parse(body)); } catch { /* ignore */ }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    switch (url.pathname) {
      case "/form": return html(res, FORM(url.searchParams.get("prefill") ?? ""));
      case "/spa": case "/spa/reports": case "/spa/a": case "/spa/b": return html(res, SPA);
      case "/bounce": return html(res, BOUNCE);
      case "/still": return html(res, STILL);
      case "/slow-from": return html(res, SLOW_FROM);
      case "/stall": return html(res, STALL);
      case "/moving": return html(res, MOVING);
      case "/covered": return html(res, COVERED);
      case "/slow-paint": {
        // the document commits on the first bytes; its first paint waits for the body
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.write(SLOW_HEAD);
        setTimeout(() => res.end(SLOW_BODY), 700);
        return;
      }
      case "/no-content":
        res.writeHead(204);
        return res.end();
      case "/download":
        res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="export.csv"' });
        return res.end("a,b\n1,2\n");
      case "/redirect":
        res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
        return res.end();
      default:
        return html(res, "<!doctype html><title>Not found</title><h1>404</h1>", 404);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
