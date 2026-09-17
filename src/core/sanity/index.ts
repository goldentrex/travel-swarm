/** Barrel exports for the common-sense invariant layer. */
export { AIRPORTS, airportInfo, crossesBorderControl } from "./airports";
export type { AirportInfo } from "./airports";
export {
  IMPORTANCE,
  SLEEP_WINDOW,
  DEFAULT_READY_IN_CITY_MINUTES,
  arrivalBuffer,
  classifyItem,
  describeDropReason,
  earliestAfterLanding,
  enforceMoveSanity,
  isNightActivity,
  isSensibleStart,
  isSleepingHour,
  mealPeriod,
  minutesOfDay,
  placeDisplacedItem,
  reasonableStartWindow,
  unstayedNights,
  utcDayIndex,
  yieldsTo,
} from "./invariants";
export {
  CRITIC_RESPONSE_SCHEMA,
  CRITIC_SYSTEM_INSTRUCTION,
  SemanticCritic,
  arrivalWindows,
  buildCriticPrompt,
  criticCategoryOf,
  deterministicCriticisms,
  mergeCriticisms,
  rulingsFor,
  sanitizeCriticisms,
} from "./semanticCritic";
export type {
  CriticAction,
  CriticContext,
  CriticIssueType,
  CriticItem,
  CriticRuling,
  CriticVerdict,
  Criticism,
  SemanticCriticConfig,
} from "./semanticCritic";
export type {
  ArrivalBuffer,
  DisplacedItem,
  DropReason,
  ItemCategory,
  MealPeriod,
  Placement,
  ProposedMove,
} from "./invariants";
