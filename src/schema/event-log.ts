import { z } from "zod";

/**
 * Event-Log Schema v0 — the public contract.
 *
 * Emitted by any recorder (supercut's Playwright executor, or third-party)
 * alongside raw footage. The renderer consumes ONLY this file plus the video.
 *
 *   recorder ──▶ footage.raw + events.json ──▶ renderer ──▶ final.mp4
 *
 * Coordinates are CSS (logical) pixels in viewport space; the renderer
 * multiplies by `viewport.dpr` to sample raw frames.
 *
 * `t` is the SCHEDULED timestamp (ms since first frame, frame 0 = t 0) and is
 * deterministic by construction. `observed_t` is optional wall-clock metadata,
 * excluded from determinism comparisons.
 *
 * Unknown event types MUST be ignored by consumers (forward compatibility) —
 * use `parseEventLog`, which strips unknown-type events instead of failing.
 */

const bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]); // x, y, w, h
const point = z.tuple([z.number(), z.number()]);

const baseEvent = {
  t: z.number().nonnegative(),
  observed_t: z.number().nonnegative().optional(),
};

export const clickEvent = z.object({
  ...baseEvent,
  type: z.literal("click"),
  bbox,
  selector: z.string(),
  point,
});

export const typeEvent = z.object({
  ...baseEvent,
  type: z.literal("type"),
  bbox,
  selector: z.string(),
  textLen: z.number().int().nonnegative(),
});

export const scrollEvent = z.object({
  ...baseEvent,
  type: z.literal("scroll"),
  from: point,
  to: point,
});

export const hoverEvent = z.object({
  ...baseEvent,
  type: z.literal("hover"),
  bbox,
  selector: z.string(),
});

export const sceneEvent = z.object({
  ...baseEvent,
  type: z.literal("scene"),
  name: z.string(),
  priority: z.number().int().min(1),
});

export const cursorPathEvent = z.object({
  ...baseEvent,
  type: z.literal("cursor_path"),
  points: z.array(z.tuple([z.number(), z.number(), z.number()])), // [t, x, y]
});

export const knownEvent = z.discriminatedUnion("type", [
  clickEvent,
  typeEvent,
  scrollEvent,
  hoverEvent,
  sceneEvent,
  cursorPathEvent,
]);

export const eventLog = z.object({
  version: z.literal(0),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    dpr: z.number().positive(),
  }),
  fps: z.number().int().positive(),
  events: z.array(knownEvent),
});

export type EventLog = z.infer<typeof eventLog>;
export type KnownEvent = z.infer<typeof knownEvent>;

const KNOWN_EVENT_TYPES = new Set([
  "click",
  "type",
  "scroll",
  "hover",
  "scene",
  "cursor_path",
]);

/**
 * Parse an event log from untrusted JSON. Unknown event types are silently
 * dropped (forward compatibility); malformed KNOWN events still fail loudly.
 */
export function parseEventLog(raw: unknown): EventLog {
  const envelope = z
    .object({ events: z.array(z.object({ type: z.string() }).passthrough()) })
    .passthrough()
    .parse(raw);

  const filtered = {
    ...envelope,
    events: envelope.events.filter((e) => KNOWN_EVENT_TYPES.has(e.type)),
  };

  return eventLog.parse(filtered);
}
