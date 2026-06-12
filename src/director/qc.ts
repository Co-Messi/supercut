/**
 * Stage 4: QC — two layers, one frozen patch surface.
 *
 *  (a) deterministic checks, zero API cost: failed scenes, dead air
 *  (b) vision checks on real captured frames at event moments
 *
 * Verdicts may ONLY: adjust hold_ms, adjust an action's zoom bbox, or cut a
 * scene. Selectors, actions, and scene order are immutable (the frozen patch
 * surface) — no flaky AI ever re-enters the deterministic path.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { EventLog, Recipe } from "../schema/index.js";
import { extractJson, type ChatPart, type LlmClient } from "./llm.js";
import type { RecordResult } from "../capture/executor.js";

const exec = promisify(execFile);

export const sceneVerdict = z.object({
  scene: z.string(),
  verdict: z.enum(["ok", "patch", "cut"]),
  reason: z.string().max(300),
  patch: z
    .object({
      hold_ms: z.number().int().min(0).max(3000).optional(),
      action_index: z.number().int().min(0).optional(),
      zoom: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    })
    .optional(),
});

export const qcReport = z.object({ verdicts: z.array(sceneVerdict) });
export type SceneVerdict = z.infer<typeof sceneVerdict>;

/** Layer (a): free checks straight off the record result + event log. */
export function deterministicChecks(result: RecordResult): SceneVerdict[] {
  const verdicts: SceneVerdict[] = [];
  for (const name of result.failedScenes) {
    verdicts.push({ scene: name, verdict: "cut", reason: "scene failed at capture (timeout/missing selector)" });
  }

  // dead air: >4s between consecutive interaction events inside a scene.
  // PR #2 review: this is INFORMATIONAL only (verdict "ok" + reason). hold_ms
  // adds time at the END of a scene — it cannot compress a MID-scene gap, so
  // patching it was a no-op that just lengthened the scene. Mid-scene dead air
  // comes from observed overrun on a slow app, and no frozen-surface lever
  // (hold/zoom/cut) fixes it, nor does re-recording. We surface it in the
  // report; the right lever is shorter scripted durations, owned upstream.
  const log = result.eventLog;
  const scenes = log.events.filter((e) => e.type === "scene");
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i]!;
    if (s.type !== "scene") continue;
    const end = i + 1 < scenes.length ? scenes[i + 1]!.t : Infinity;
    const inScene = log.events
      .filter((e) => e.type !== "scene" && e.type !== "cursor_path" && e.t >= s.t && e.t < end)
      .map((e) => e.t)
      .sort((a, b) => a - b);
    for (let j = 1; j < inScene.length; j++) {
      if (inScene[j]! - inScene[j - 1]! > 4000) {
        verdicts.push({
          scene: s.name,
          verdict: "ok",
          reason: `note: ${Math.round(inScene[j]! - inScene[j - 1]!)}ms dead air between events (slow app; not auto-fixable within the patch surface)`,
        });
        break;
      }
    }
  }
  return verdicts;
}

/** Find the captured frame closest to time t, downscaled to a vision-friendly jpeg. */
async function frameJpegB64(takeDir: string, t: number): Promise<string | null> {
  try {
    const index = JSON.parse(readFileSync(join(takeDir, "frames-index.json"), "utf8")) as {
      file: string;
      t_source: number;
    }[];
    if (index.length === 0) return null;
    let best = index[0]!;
    for (const e of index) {
      if (Math.abs(e.t_source - t) < Math.abs(best.t_source - t)) best = e;
    }
    // ffmpeg as an image scaler here (tooling, not the effects engine):
    // 4K PNG → 1024-wide jpeg keeps vision tokens sane
    const { stdout } = await exec(
      "ffmpeg",
      ["-i", join(takeDir, best.file), "-vf", "scale=1024:-1", "-f", "image2", "-vcodec", "mjpeg", "-q:v", "5", "pipe:1"],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 } as never,
    ) as unknown as { stdout: Buffer };
    return stdout.toString("base64");
  } catch {
    return null;
  }
}

const SYSTEM = `You are the quality judge for a cinematic product launch video. For each scene you get a captured frame at its key interaction moment. Judge ONLY:
- is the interaction's payoff visible (did something happen)?
- is there an error page, blank screen, overlay, or cookie banner ruining the shot?
- does the scene need a longer hold to land (slow content)?
Respond ONLY with JSON: { "verdicts": [{ "scene": string, "verdict": "ok"|"patch"|"cut", "reason": string, "patch": { "hold_ms"?: int } }] }
Rules: "cut" only for ruined shots (error/blank/banner). "patch" with hold_ms 400-2000 for shots that need breathing room. Otherwise "ok". One verdict per scene, scene names exactly as given.`;

/** Layer (b): vision QC on the event frame of each scene. */
export async function visionQc(
  llm: LlmClient,
  takeDir: string,
  log: EventLog,
): Promise<SceneVerdict[]> {
  const scenes = log.events.filter((e) => e.type === "scene");
  const parts: ChatPart[] = [];
  const sceneNames: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i]!;
    if (s.type !== "scene") continue;
    const end = i + 1 < scenes.length ? scenes[i + 1]!.t : Infinity;
    const firstInteraction = log.events.find(
      (e) => (e.type === "click" || e.type === "hover" || e.type === "type") && e.t >= s.t && e.t < end,
    );
    // judge the moment AFTER the payoff, not the moment of the click
    const judgeT = (firstInteraction?.t ?? s.t) + 800;
    const b64 = await frameJpegB64(takeDir, judgeT);
    if (!b64) continue;
    sceneNames.push(s.name);
    parts.push({ type: "text", text: `scene "${s.name}" at its key moment:` });
    parts.push({ type: "image", dataUrl: `data:image/jpeg;base64,${b64}` });
  }
  if (sceneNames.length === 0) return [];

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const user: ChatPart[] = feedback
      ? [...parts, { type: "text", text: `Invalid response: ${feedback}. JSON only.` }]
      : parts;
    const raw = await llm.chat({ system: SYSTEM, user, json: true });
    try {
      const report = qcReport.parse(extractJson(raw));
      // unknown scene names are dropped, not trusted
      return report.verdicts.filter((v) => sceneNames.includes(v.scene));
    } catch (err) {
      feedback = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
  }
  console.error("vision QC: model failed twice — proceeding without vision verdicts");
  return [];
}

export interface AppliedVerdicts {
  recipe: Recipe;
  changed: boolean;
  cut: string[];
}

/** Apply verdicts within the frozen patch surface. Cutting cascades to dependents. */
export function applyVerdicts(recipe: Recipe, verdicts: SceneVerdict[]): AppliedVerdicts {
  const cutSet = new Set(verdicts.filter((v) => v.verdict === "cut").map((v) => v.scene));
  // dependency cascade
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of recipe.scenes) {
      if (!cutSet.has(s.name) && s.depends_on.some((d) => cutSet.has(d))) {
        cutSet.add(s.name);
        grew = true;
      }
    }
  }

  let changed = cutSet.size > 0;
  const scenes = recipe.scenes
    .filter((s) => !cutSet.has(s.name))
    .map((s) => {
      const patches = verdicts.filter((v) => v.verdict === "patch" && v.scene === s.name && v.patch);
      if (patches.length === 0) return s;
      changed = true;
      let out = { ...s };
      for (const p of patches) {
        if (p.patch?.hold_ms !== undefined) out = { ...out, hold_ms: p.patch.hold_ms };
        if (p.patch?.zoom && p.patch.action_index !== undefined) {
          const actions = [...out.actions];
          const target = actions[p.patch.action_index];
          if (target) {
            actions[p.patch.action_index] = { ...target, zoom: p.patch.zoom };
            out = { ...out, actions };
          }
        }
      }
      return out;
    });

  if (scenes.length === 0) throw new Error("QC cut every scene — refusing to render an empty video");
  return { recipe: { ...recipe, scenes }, changed, cut: [...cutSet] };
}
