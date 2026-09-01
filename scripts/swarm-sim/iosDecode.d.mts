// Types for the plain-JS iOS decoder simulation (iosDecode.mjs), so the swarm
// scenario test imports it with real signatures instead of a blanket
// `@ts-expect-error` that silently covered whatever else the import got wrong.

/** A value as it can appear in `content_json` over the wire. */
export type RawJSON =
  | string
  | number
  | boolean
  | null
  | RawJSON[]
  | { [key: string]: RawJSON };

/**
 * Model `SwarmService.swift`'s `rawDictionary`: returns the decoded dictionary,
 * or `null` when it flattens to empty (Swift returns nil ⇒ the key is dropped).
 */
export function rawDictionary(
  obj: Record<string, RawJSON>,
): Record<string, RawJSON> | null;

/** Model `SwarmService.swift`'s `rawArray`: null elements keep their slot. */
export function rawArray(arr: RawJSON[]): RawJSON[];

/** Fields `TripContent`'s Swift models require; each string is one problem found. */
export function decodeWouldFail(content: RawJSON): string[];

/** Deep diff of keys/elements lost between the server JSON and the client dict. */
export function lostPaths(before: RawJSON, after: RawJSON, path?: string): string[];
