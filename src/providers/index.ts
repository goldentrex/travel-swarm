/** Barrel exports for the provider abstraction layer. */
export type { FlightProvider } from "./interfaces/FlightProvider";
export type { HotelProvider } from "./interfaces/HotelProvider";
export type { ActivityProvider } from "./interfaces/ActivityProvider";
export type {
  EventDisruptionContextProvider,
  WeatherContextProvider,
} from "./interfaces/ContextProviders";
export type {
  ActivityOption,
  ActivitySearchQuery,
  ActivitySearchResult,
  ActivitySetting,
  AirportCode,
  AlternativeFlightsResult,
  BookingConfirmation,
  BookingStatus,
  CurrencyCode,
  EventDisruptionInfo,
  EventDisruptionQuery,
  EventDisruptionResult,
  FareDifference,
  FareDirection,
  FlightOption,
  FlightRouteContext,
  HotelPolicies,
  HotelRoomOption,
  HotelRoomSearchQuery,
  HotelRoomSearchResult,
  IsoTimestamp,
  RainForecastResult,
  RainWindow,
} from "./interfaces/types";

export { AtlasFlightProvider } from "./atlas/AtlasFlightProvider";
export type { AtlasFlightProviderConfig } from "./atlas/AtlasFlightProvider";

export {
  RapidApiHotelProvider,
  RapidApiError,
  rapidApiHotelConfigured,
} from "./rapidapi/RapidApiHotelProvider";
export type {
  RapidApiErrorKind,
  RapidApiHotelProviderConfig,
} from "./rapidapi/RapidApiHotelProvider";

export {
  ViatorActivityProvider,
  tagActivitySetting,
  viatorEdgeConfigured,
} from "./viator/ViatorActivityProvider";
export type { ViatorActivityProviderConfig } from "./viator/ViatorActivityProvider";

export {
  OpenWeatherProvider,
  WeatherApiError,
  openWeatherConfigured,
} from "./openweathermap/OpenWeatherProvider";
export type {
  OpenWeatherProviderConfig,
  WeatherApiErrorKind,
} from "./openweathermap/OpenWeatherProvider";

export {
  PredictHQProvider,
  PredictHQError,
  predictHQConfigured,
} from "./predicthq/PredictHQProvider";
export type { PredictHQErrorKind, PredictHQProviderConfig } from "./predicthq/PredictHQProvider";
