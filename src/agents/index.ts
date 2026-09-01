/** Barrel exports for the agent layer (orchestrator + specialists + trust layer). */
export {
  OrchestratorAgent,
  TRANSFER_REQUOTE_CHARGE,
  formatNewTime,
  MAX_PLANS_PER_CAROUSEL,
  applyConstraintsToCandidates,
  selectPlanCandidates,
} from "./orchestrator/OrchestratorAgent";
export type {
  DisruptionAssessment,
  DisruptionEvent,
  MultiPlanOutcome,
  OrchestrationOutcome,
} from "./orchestrator/OrchestratorAgent";

export { FlightAgent } from "./flight/FlightAgent";
export type {
  FlightAgentConfig,
  FlightRebookingAssessment,
  RebookingCandidate,
} from "./flight/FlightAgent";

export { PolicyAgent } from "./policy/PolicyAgent";
export type {
  FarePolicyRequest,
  FarePolicyVerdict,
  PolicyAgentConfig,
  PolicyReasoningHook,
} from "./policy/PolicyAgent";

export { HotelAgent } from "./hotel/HotelAgent";
export type { HotelAssessment, HotelImpactRequest } from "./hotel/HotelAgent";

export { ActivityAgent } from "./activity/ActivityAgent";
export type {
  ActivityRescheduleProposal,
  ActivityRescheduleRequest,
  ViatorSlotConsult,
} from "./activity/ActivityAgent";

export { DayReorganizer } from "./activity/DayReorganizer";
export type {
  DayActivityInput,
  DayReorganizationOutcome,
  DayReorgDecision,
  DayReorgRequest,
  DayReorganizerConfig,
} from "./activity/DayReorganizer";

export {
  GeminiLiaisonAgent,
  buildDeterministicTradeoffs,
  buildPreferenceTradeoffs,
  deriveConstraintsFromAnswers,
  normalizeLanguage,
} from "./liaison/GeminiLiaisonAgent";
export type {
  GeminiLiaisonConfig,
  ResolutionConstraints,
  TradeoffAnswer,
  TradeoffQuestion,
  TradeoffQuestionContext,
  TradeoffOption,
} from "./liaison/GeminiLiaisonAgent";

export {
  GEMINI_CALLS_PER_MISSION,
  GEMINI_QUOTA_RETRIES,
  GEMINI_RETRY_BACKOFF_MS,
} from "./geminiDegrade";
export type { GeminiCallResult, GeminiDegradeReason } from "./geminiDegrade";

export { resolutionPlanToJson, validateResolutionPlan } from "./finance/TrustLayer";
export type {
  FinancialDelta,
  HotelAdjustment,
  HotelAlternative,
  ImpactedNodes,
  Incident,
  OperationalSettlement,
  PolicyVerdictSummary,
  ProposedNewFlight,
  ProposedResolution,
  RescheduledActivityProposal,
  ResolutionPlan,
  ResolutionPresentation,
  TransferRequote,
  TrustLayerPlan,
} from "./finance/TrustLayer";
export { XY123_EXAMPLE_PLAN } from "./finance/exampleResolutionPlan";
