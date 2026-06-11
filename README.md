# supercut

> Point it at your app. Get the supercut.

Institutional-grade, max-60-second launch videos generated from your **real**
product — not an HTML mockup. A scripted browser performs your app on camera;
a cinematic renderer adds the Screen Studio look (spring zoom-to-cursor,
motion blur, padded background, music on the beat grid); an AI director writes
the script and quality-checks the footage.

**Status: pre-release, under active construction.** The design doc and build
plan are complete; stages are landing in order. Nothing to install yet.

```
 your app URL ──▶ ① analyze   pick the 3-4 money moments (LLM)
                  ② script    write the filming recipe, beat-aligned (LLM, schema-validated)
                  ③ record    a deterministic browser executor performs it (pure code)
                  ④ qc        vision checks the footage, refilms what's bad (bounded loop)
                  ⑤ render    cinematic compositing + music ──▶ launch.mp4 (≤60s, 1080p60)
```

- Real footage only — no fake UI renders, ever
- The event-log JSON between recorder and renderer is a public contract; any
  recorder can feed it
- Stages ③ and ⑤ run standalone with zero API key (`supercut record`,
  `supercut render`)
- MIT, CC0-only bundled music, macOS + Linux

## License

MIT
