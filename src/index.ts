/**
 * Library entry point: the same stages the `supercut` CLI drives.
 *
 *   import { generate, record, renderTake, parseRecipe } from "@co-messi/supercut";
 */
export * from "./capture/index.js";
export * from "./director/index.js";
export * from "./render/index.js";
export * from "./schema/index.js";
