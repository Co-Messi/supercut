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
  // Informational only: hold_ms adds time at the END of a scene and cannot
  // compress a MID-scene gap, so
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

const SYSTEM = `You are the quality judge for a cinematic product launch video. For each scene you get SEVERAL captured frames sampled across the scene (its key interaction moment, a mid point, and its final hold). Judge the scene across ALL of its frames. Judge ONLY:
- is the interaction's payoff visible (did something happen)?
- is there an error page, blank screen, overlay, or cookie banner ruining the shot — in ANY of the frames?
- does the scene need a longer hold to land (slow content)?
Respond ONLY with JSON: { "verdicts": [{ "scene": string, "verdict": "ok"|"patch"|"cut", "reason": string, "patch": { "hold_ms"?: int } }] }
Rules: if ANY sampled frame is an error page, blank/empty screen, or shows a banner ruining the shot, prefer "cut" (a late error still ruins the clip). "patch" with hold_ms 400-2000 for shots that need breathing room. Otherwise "ok". One verdict per scene, scene names exactly as given.`;

/** Layer (b): vision QC on multiple frames per scene. */
export async function visionQc(
  llm: LlmClient,
  takeDir: string,
  log: EventLog,
): Promise<SceneVerdict[]> {
  const scenes = log.events.filter((e) => e.type === "scene");
  const parts: ChatPart[] = [];
  const sceneNames: string[] = [];

  // the take's last CAPTURED frame time. Capture keeps emitting frames through
  // hold_ms without emitting any event, so the final scene's hold must be
  // sampled against the last frame, not the last event (else a late blank/error
  // during a closing hold is missed). Fall back to event time if no index.
  let lastFrameT = 0;
  try {
    const idx = JSON.parse(readFileSync(join(takeDir, "frames-index.json"), "utf8")) as { t_source: number }[];
    lastFrameT = idx.reduce((m, e) => Math.max(m, e.t_source), 0);
  } catch {
    /* no frame index — final scene falls back to last event time below */
  }

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i]!;
    if (s.type !== "scene") continue;
    const end = i + 1 < scenes.length ? scenes[i + 1]!.t : Infinity;
    const firstInteraction = log.events.find(
      (e) => (e.type === "click" || e.type === "hover" || e.type === "type") && e.t >= s.t && e.t < end,
    );
    // B6 (review): one frame per scene let LATE errors (a result that errors out
    // after the click, a modal that pops during the hold) pass QC. Sample up to
    // 3 frames per scene — the key moment (after the payoff), a mid frame, and
    // the scene's final hold frame — so a late blank/error is caught. Capped at
    // 3 to bound vision token cost.
    const keyT = (firstInteraction?.t ?? s.t) + 800;
    // the last frame we can attribute to this scene; for the final scene `end`
    // is Infinity, so fall back to the take's last captured frame time.
    const lastEventT = log.events.reduce((m, e) => Math.max(m, e.t), s.t);
    // final scene: end at the last captured FRAME (covers the hold), not the
    // last event — see lastFrameT note above.
    const sceneEndT = end === Infinity ? Math.max(lastFrameT, lastEventT) : end;
    const holdT = Math.max(keyT, sceneEndT - 200); // just inside the final hold
    const midT = (keyT + holdT) / 2;
    // de-dupe near-identical sample times (short scenes collapse to one frame)
    const sampleTs = [keyT, midT, holdT].filter(
      (t, idx, arr) => arr.findIndex((u) => Math.abs(u - t) < 200) === idx,
    );

    const labels = ["its key moment", "mid-scene", "its final hold"];
    const sceneParts: ChatPart[] = [];
    for (let k = 0; k < sampleTs.length; k++) {
      const b64 = await frameJpegB64(takeDir, sampleTs[k]!);
      if (!b64) continue;
      const label = sampleTs.length === 1 ? "its key moment" : (labels[k] ?? "another moment");
      sceneParts.push({ type: "text", text: `scene "${s.name}" — ${label}:` });
      sceneParts.push({ type: "image", dataUrl: `data:image/jpeg;base64,${b64}` });
    }
    // need at least one real frame to judge the scene at all
    if (sceneParts.length === 0) continue;
    sceneNames.push(s.name);
    parts.push(...sceneParts);
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
