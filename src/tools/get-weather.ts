import { z } from "zod";
import type { AgentTool, ToolContext } from "./tool.js";
import { reason, toolRequestSignal } from "./tool.js";

const Args = z.object({
  location: z.string().min(1),
});

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 10_000;

interface GeoResult {
  latitude: number;
  longitude: number;
  name: string;
  country?: string;
}

interface Current {
  temperature_2m: number;
  apparent_temperature: number;
  relative_humidity_2m: number;
  weather_code: number;
  wind_speed_10m: number;
}

/** Current weather for a place, via the free two-step Open-Meteo API (geocode →
 *  forecast). No API key. fetchFn is injectable so tests stay offline. */
export function createGetWeatherTool(fetchFn: typeof fetch = fetch): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "get_weather",
        description:
          "Current weather for a city or place. Use for \"what's the weather in X\" questions.",
        parameters: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description:
                "City or place name in English or its local Latin spelling. Translate " +
                "names given in other scripts to Latin script, e.g. Korean \"취리히\" → " +
                "\"Zurich\", \"서울\" → \"Seoul\".",
            },
          },
          required: ["location"],
        },
      },
    },

    async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
      const { location } = Args.parse(rawArgs);
      try {
        const place = await geocode(fetchFn, location, ctx.signal);
        if (!place) return `get_weather failed: unknown location "${location}"`;
        const current = await forecast(fetchFn, place, ctx.signal);
        return render(place, current);
      } catch (err) {
        if (ctx.signal?.aborted) throw ctx.signal.reason;
        ctx.log.warn("get_weather failed", { location, error: reason(err) });
        return `get_weather failed: ${reason(err)}`;
      }
    },
  };
}

async function geocode(
  fetchFn: typeof fetch,
  name: string,
  signal?: AbortSignal,
): Promise<GeoResult | null> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetchFn(url, { signal: toolRequestSignal(signal, TIMEOUT_MS) });
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
  const body = (await res.json()) as { results?: GeoResult[] };
  return body.results?.[0] ?? null;
}

async function forecast(
  fetchFn: typeof fetch,
  place: GeoResult,
  signal?: AbortSignal,
): Promise<Current> {
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current:
      "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
    timezone: "auto",
  });
  const res = await fetchFn(`${FORECAST_URL}?${params.toString()}`, {
    signal: toolRequestSignal(signal, TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
  const body = (await res.json()) as { current?: Current };
  if (!body.current) throw new Error("forecast returned no current conditions");
  return body.current;
}

function render(place: GeoResult, c: Current): string {
  const where = place.country ? `${place.name}, ${place.country}` : place.name;
  return (
    `${where}: ${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C), ` +
    `${describe(c.weather_code)}, humidity ${Math.round(c.relative_humidity_2m)}%, ` +
    `wind ${Math.round(c.wind_speed_10m)} km/h`
  );
}

/** WMO weather interpretation codes → short English phrase. */
function describe(code: number): string {
  if (code === 0) return "clear sky";
  if (code >= 1 && code <= 3) return "partly cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95 && code <= 99) return "thunderstorm";
  return `code ${code}`;
}
