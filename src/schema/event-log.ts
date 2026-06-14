import { z } from "zod";

/**
 * Event-Log Schema v0 — the public contract.
 */

export const MAX_EVENTS = 5_000;
export const MAX_CURSOR_POINTS = 20_000;

const finite = z.number().finite();
const bbox = z.tuple([finite, finite, finite.positive(), finite.positive()]); // x, y, w, h
const point = z.tuple([finite, finite]);

const baseEvent = {
  t: finite.nonnegative(),
  observed_t: finite.nonnegative().optional(),
};

/** Optional camera target: the result region this action produced (a graph, a
 *  results panel). When present, the renderer frames THIS instead of the
 *  interaction bbox — the cursor stays on the control, the camera holds on the
 *  payoff. Resolved at capture time, so it reflects the post-action layout. */
const focusBbox = { focus_bbox: bbox.optional() };

export const clickEvent = z.object({
  ...baseEvent,
  type: z.literal("click"),
  bbox,
  ...focusBbox,
  selector: z.string(),
  point,
}).strict();

export const typeEvent = z.object({
  ...baseEvent,
  type: z.literal("type"),
  bbox,
  ...focusBbox,
  selector: z.string(),
  textLen: z.number().int().nonnegative(),
}).strict();

export const scrollEvent = z.object({
  ...baseEvent,
  type: z.literal("scroll"),
  from: point,
  to: point,
}).strict();

export const hoverEvent = z.object({
  ...baseEvent,
  type: z.literal("hover"),
  bbox,
  ...focusBbox,
  selector: z.string(),
}).strict();

export const sceneEvent = z.object({
  ...baseEvent,
  type: z.literal("scene"),
  name: z.string(),
  priority: z.number().int().min(1),
}).strict();

export const cursorPathEvent = z.object({
  ...baseEvent,
  type: z.literal("cursor_path"),
  points: z.array(z.tuple([finite.nonnegative(), finite, finite])).max(MAX_CURSOR_POINTS, "too many cursor points"),
}).strict();

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
    dpr: finite.positive(),
  }).strict(),
  fps: z.number().int().positive().max(240),
  events: z.array(knownEvent).max(MAX_EVENTS, "too many events"),
}).strict();

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

function enforceMonotonic(events: KnownEvent[]): void {
  let prev = -1;
  for (const e of events) {
    // cursor_path is global metadata emitted at t=0 after all scene/action
    // events by the built-in recorder; validate its internal point timeline but
    // do not make the container event participate in event-order monotonicity.
    if (e.type !== "cursor_path") {
      if (e.t < prev) throw new Error(`event timestamps must be monotonic; ${e.type} at ${e.t} came after ${prev}`);
      prev = e.t;
    }
    if (e.type === "cursor_path") {
      let pointPrev = -1;
      for (const [t] of e.points) {
        if (t < pointPrev) throw new Error("cursor_path points must be monotonic");
        pointPrev = t;
      }
    }
  }
}

/**
 * Parse an event log from untrusted JSON. Unknown event types are silently
 * dropped (forward compatibility); malformed KNOWN events still fail loudly.
 */
export function parseEventLog(raw: unknown): EventLog {
  const envelope = z
    .object({ events: z.array(z.object({ type: z.string() }).passthrough()).max(MAX_EVENTS, "too many events") })
    .passthrough()
    .parse(raw);

  const filtered = {
    ...envelope,
    events: envelope.events.filter((e) => KNOWN_EVENT_TYPES.has(e.type)),
  };

  const parsed = eventLog.parse(filtered);
  enforceMonotonic(parsed.events);
  return parsed;
}
