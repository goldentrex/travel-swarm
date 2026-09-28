// Benchmark runs must never contact suppliers or read local credentials.
// Individual tests replace fetch with fixtures; unstubbing returns to this guard.
for (const key of [
  "GEMINI_API_KEY",
  "ATLAS_API_KEY",
  "RAPIDAPI_KEY",
  "RAPIDAPI_HOST",
  "VIATOR_API_KEY",
  "OPENWEATHER_API_KEY",
  "PREDICTHQ_API_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
])
  delete process.env[key];

globalThis.fetch = async () => {
  throw new Error("Offline benchmark blocked an unmocked network request");
};
