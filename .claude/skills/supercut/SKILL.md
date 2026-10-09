---
name: supercut
description: Film the user's own running web app into a cinematic launch video, with you (the coding agent) acting as the director. No LLM API key needed. Use when the user asks for a launch video, product demo video, or "supercut" of an app they are developing.
---

# supercut: you are the director

supercut films a real web app with a real browser and renders a cinematic video (camera moves, motion blur, music). Normally an LLM director writes the filming script. Here you write it yourself, so the user needs no API key.

The pipeline is: you write `recipe.json`, then `supercut record` films it, then `supercut render` produces `final.mp4`. Both commands are keyless and deterministic.

## Safety rules (read first)

1. Film a staging or local dev instance only. supercut performs real clicks and typing in the app. Never point it at production or at an app holding real customer data.
2. Never include destructive controls in the recipe: Delete, Remove, Pay, Buy, Send, Publish, Cancel subscription, Log out, anything that mutates data you cannot reset. If a moment needs one, leave it out.
3. Only type harmless sample text (for example `ada@example.com`). Never type real credentials or secrets.
4. Before running record, show the user the list of actions (each selector and each typed string) and the app URL, and wait for a yes. Skipping this is the one thing the user will not forgive.
5. Do not kill processes you did not start. If the port is taken, pick another one.

## Steps

### 1. Check the toolchain

```bash
npx @co-messi/supercut doctor
```

It needs Node 20 or newer, `ffmpeg` on PATH, and Playwright's Chromium. Fix whatever it reports, using the exact command it prints: the Chromium command names supercut's own Playwright version (`npx playwright@<version> install chromium`). A bare `npx playwright install chromium` run inside an app that has its own Playwright installs a browser supercut cannot use.

### 2. Make sure the app is running

Ask the user for the URL, or find the dev command in `package.json`. Confirm it answers:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

Start the dev server in the background if it is not running, and stop only the process you started when you are done. Make sure the port belongs to this app and not to something else.

### 3. Read the app

Work out what the product is and which 2 to 4 moments sell it.

- Read the source: routes and pages (`app/`, `pages/`, `src/routes/`, a router file), and the components behind the main flows. Look for the real selectors: `id`, `data-testid`, stable class names, `aria-label`.
- Open the live pages (curl the HTML, or use a browser tool if you have one) and confirm each selector you plan to use exists on the page where you will use it.
- Pick moments that show a result, not a landing page: type a query and frame the results, open a detail panel, flip a toggle and show the chart change. Prefer moments where the result appears on screen after the action.

### 4. Write recipe.json

Write it next to the app or under `out/`. It must satisfy this schema (the real parser is `parseRecipe` in `src/schema/recipe.ts`):

```text
recipe: {
  version: 0,                      // literal 0
  app_url: "http://localhost:3000",// http or https only
  music_track: "pulse"|"daybreak"|"midnight"|"momentum"|"off",
  scenes: Scene[]                  // at least 1
}
Scene: {
  name: string,                    // unique, kebab-case
  priority: int >= 1,              // 1 = most important
  entry: { url: string, prelude: [] },  // page this scene starts on
  depends_on: string[],            // names of EARLIER scenes, usually []
  actions: Action[],               // at least 1
  hold_ms: int >= 0                // extra hold on the final frame
}
Action: {
  kind: "click"|"type"|"hover"|"scroll"|"wait"|"goto",
  selector: string,                // required for click, type, hover
  text: string,                    // required for type
  submit: boolean,                 // type only: press Enter after typing
  url: string,                     // required for goto
  focus_selector: string,          // optional: the RESULT region the camera should frame
  duration_ms: int >= 200,
  zoom: [x, y, w, h]               // optional camera box in CSS px, rarely needed
}
```

Rules that make a recipe fail validation:

- Unknown fields are rejected (the schema is strict).
- The estimated video length must stay at or under 60 seconds: the sum of every `duration_ms` and `hold_ms`, plus 1000 ms, plus 1500 ms per scene after the first, plus 1700 ms. A good launch video is 20 to 40 seconds, so aim for 3 to 6 actions in total.
- Each scene must be independently reachable from its `entry.url`. Do not rely on typed text, filters or other page state left behind by an earlier scene, and give a scene on the same URL as the previous one a different starting point or accept that it may continue from the same page.

Minimal valid example (this exact JSON is validated by the repo's tests):

```json
{
  "version": 0,
  "app_url": "http://localhost:3000",
  "music_track": "daybreak",
  "scenes": [
    {
      "name": "search-and-results",
      "priority": 1,
      "entry": { "url": "http://localhost:3000/", "prelude": [] },
      "depends_on": [],
      "actions": [
        { "kind": "type", "selector": "#search", "text": "quarterly report", "submit": true, "focus_selector": "#results", "duration_ms": 2200 },
        { "kind": "hover", "selector": "#results li:first-child", "duration_ms": 1400 }
      ],
      "hold_ms": 1000
    }
  ]
}
```

Tips for a good take:

- Use `focus_selector` on the action that produces the payoff, so the camera holds on the result and not on the button.
- Give typing 1500 to 2500 ms and clicks 1000 to 1600 ms. Longer is slower and calmer.
- Pick `music_track` to match the look: `pulse` for sleek dev tools, `daybreak` for bright consumer apps, `midnight` for dark data products, `momentum` for fast action-heavy apps, `off` for silence.
- Use selectors that exist exactly once. A selector that matches nothing fails its scene.

### 5. Confirm with the user, then record

Show the actions list and get a yes (safety rule 4). Then:

```bash
npx @co-messi/supercut record --recipe recipe.json --out out/take
```

`record` exits nonzero if any scene failed, and prints which. A failed scene usually means a wrong selector, a wrong URL, or another app on that port. Fix the recipe and record again. Do not render a partial take unless the user agrees.

### 6. Render

```bash
npx @co-messi/supercut render --take out/take --out out/final.mp4
```

Optional: `--bg cobalt|glacier|sunrise|daydream|magenta|coral|lavender|aurora|midnight|dusk|paper` for the backdrop, and `--music` to override the track.

### 7. Look at it before you report

Make a contact sheet and view it with your image-reading tool:

```bash
ffmpeg -y -i out/final.mp4 -vf "fps=1/3,scale=480:-1,tile=4x3" -frames:v 1 out/contact.png
```

Check that the cursor lands on the intended controls, the camera frames the result, no frame shows an error page or a blank screen, and nothing sensitive is on screen. If something is wrong, adjust the recipe and repeat from step 5.

Report the path of `out/final.mp4`, the scenes you filmed, and anything you noticed that the user might want changed. Do not claim the video looks good unless you actually looked at the contact sheet.
