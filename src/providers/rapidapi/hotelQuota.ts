/**
 * What the last REAL Booking.com call learned about the key.
 *
 * `/health` probes the RapidAPI gateway root to answer "is the hotel rail
 * usable?". That probe cannot see a quota problem: verified live on
 * 2026-09-01, the gateway answers `404 {"message":"Endpoint '/' does not
 * exist"}` to the root whatever the key's state, while a real endpoint on the
 * same key answered `429 {"message":"You have exceeded the MONTHLY quota for
 * Requests on your current plan, BASIC"}`. So health reported
 * `hotelAuthorized: true` while every single lookup in the app failed — the
 * one signal that exists to say "this rail is fine" said so when it was not.
 *
 * Probing a real endpoint instead would spend a request from the very budget
 * that is running out. So nothing extra is called: the real lookups already
 * learn the answer, and this records what they saw.
 *
 * Module state, like the Gemini cascade's cooldowns: a Worker isolate keeps it
 * between requests, and it is a fact about the KEY, not about one mission.
 */

/** How long a recorded exhaustion is trusted. A monthly cap will not clear
 *  inside it; a burst limit will, and the next real call re-records if not. */
const QUOTA_MEMORY_MS = 15 * 60_000;

let exhaustedAt: number | null = null;
/** The gateway's own words, so `/health` can say WHICH limit was hit. */
let exhaustedNote: string | null = null;

/** Record that a real call was refused for quota (HTTP 429). */
export function noteHotelQuotaExhausted(note?: string, now: number = Date.now()): void {
  exhaustedAt = now;
  exhaustedNote = note?.slice(0, 200) ?? null;
}

/** Record that a real call went through — the key is spending again. */
export function noteHotelQuotaHealthy(): void {
  exhaustedAt = null;
  exhaustedNote = null;
}

/** True when a recent real call was refused for quota. */
export function hotelQuotaExhausted(now: number = Date.now()): boolean {
  if (exhaustedAt === null) return false;
  if (now - exhaustedAt > QUOTA_MEMORY_MS) {
    exhaustedAt = null;
    exhaustedNote = null;
    return false;
  }
  return true;
}

/** The gateway's message for the refusal currently remembered, if any. */
export function hotelQuotaNote(now: number = Date.now()): string | null {
  return hotelQuotaExhausted(now) ? exhaustedNote : null;
}

/** Test seam. */
export function resetHotelQuota(): void {
  exhaustedAt = null;
  exhaustedNote = null;
}
