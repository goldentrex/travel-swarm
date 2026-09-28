/**
 * The ground layer: how a traveller covers the distance between two items of
 * their itinerary when the way they planned to has gone.
 */
export {
  GroundLink,
  describeGround,
  humanDuration,
  latestDeparture,
  viableOptions,
  type GroundLinkConfig,
  type GroundOption,
  type GroundPoint,
} from "./groundLink";
export {
  groundHeadline,
  isGroundMission,
  modesWorthAsking,
  namesAirport,
  nextGroundCommitment,
  type GroundCommitment,
  type GroundCommitmentOptions,
} from "./groundPlan";
