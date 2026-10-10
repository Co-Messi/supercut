/** The CSS viewport the recorder films at. The crawl uses the same one, so
 *  what the director sees (which controls exist, which are hidden, how big a
 *  region is) is the layout that is filmed, not a narrower breakpoint. */
export const CAPTURE_VIEWPORT = { width: 1920, height: 1080 } as const;
