// Faithful simulation of the iOS ApproveResponse raw-JSON decoder
// (SwarmService.swift rawDictionary / rawArray) so we can see exactly what
// survives the trip from the worker's `updated_content` into the app.
//
// Swift semantics being modelled:
//   rawDictionary: for each key, try String, Bool, Double, Int, object, array,
//                  then explicit null (kept as NSNull so re-encoding does not
//                  drop a key the server sent).
//                  An object that flattens to {} returns nil ⇒ key dropped.
//   rawArray:      same order per element; a null element keeps its SLOT, so
//                  indices never shift.

export function rawDictionary(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = value;
    else if (Array.isArray(value)) out[key] = rawArray(value);
    else if (value !== null && typeof value === "object") {
      const nested = rawDictionary(value);
      // Swift: `if let dict = rawDictionary(nested)` — nil when empty.
      if (nested !== null) out[key] = nested;
    } else if (value === null) out[key] = null; // preserved, not dropped
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function rawArray(arr) {
  const out = [];
  for (const value of arr) {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "boolean") out.push(value);
    else if (typeof value === "number") out.push(value);
    else if (Array.isArray(value)) out.push(rawArray(value));
    else if (value !== null && typeof value === "object") {
      const nested = rawDictionary(value);
      if (nested !== null) out.push(nested);
    } else if (value === null) out.push(null); // slot preserved
  }
  return out;
}

/** Fields TripContent's Swift models require (no default, no tolerant decoder). */
export function decodeWouldFail(content) {
  const problems = [];
  const legs = content?.transit_groups;
  if (Array.isArray(legs)) {
    legs.forEach((leg, i) => {
      // struct Transit has NO custom init(from:) — `let id: String` is required.
      if (leg === null || typeof leg !== "object") {
        problems.push(`transit_groups[${i}] is not an object`);
      } else if (typeof leg.id !== "string") {
        problems.push(`transit_groups[${i}].id missing ⇒ WHOLE TripContent decode returns nil`);
      }
    });
  }
  return problems;
}

/** Deep diff reporting keys/elements lost between server JSON and client dict. */
export function lostPaths(before, after, path = "") {
  const lost = [];
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) {
      lost.push(path);
      return lost;
    }
    if (before.length !== after.length) {
      lost.push(`${path} length ${before.length} → ${after.length}`);
    }
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      lost.push(...lostPaths(before[i], after[i], `${path}[${i}]`));
    }
    return lost;
  }
  if (before !== null && typeof before === "object") {
    if (after === undefined || after === null || typeof after !== "object") {
      lost.push(path);
      return lost;
    }
    for (const [k, v] of Object.entries(before)) {
      if (!(k in after)) lost.push(`${path}.${k}${v === null ? " (was null)" : ""}`);
      else lost.push(...lostPaths(v, after[k], `${path}.${k}`));
    }
    return lost;
  }
  return lost;
}
