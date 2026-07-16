import { describe, it, expect, vi } from "vitest";
import { createGetWeatherTool } from "./get-weather.js";
import { noopLogger } from "../bootstrap/logger.js";
import type { ToolContext } from "./tool.js";

const ctx: ToolContext = { log: noopLogger };

const geoBody = {
  results: [{ latitude: 47.37, longitude: 8.55, name: "Zurich", country: "Switzerland" }],
};
const forecastBody = {
  current: {
    temperature_2m: 24.3,
    apparent_temperature: 25.1,
    relative_humidity_2m: 48,
    weather_code: 2,
    wind_speed_10m: 11,
  },
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe("createGetWeatherTool", () => {
  it("geocodes then fetches the forecast and renders one compact line", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(geoBody))
      .mockResolvedValueOnce(json(forecastBody));
    const tool = createGetWeatherTool(fetchFn as unknown as typeof fetch);

    const out = await tool.execute({ location: "Zurich" }, ctx);

    expect(out).toBe(
      "Zurich, Switzerland: 24°C (feels 25°C), partly cloudy, humidity 48%, wind 11 km/h",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const geoUrl = String(fetchFn.mock.calls[0]![0]);
    expect(geoUrl).toContain("geocoding-api.open-meteo.com");
    expect(geoUrl).toContain("name=Zurich");
  });

  it("instructs the model to use Latin-script names Open-Meteo can resolve", async () => {
    const tool = createGetWeatherTool();
    const description = tool.definition.function.parameters?.properties as
      | { location?: { description?: string } }
      | undefined;
    const text = description?.location?.description ?? "";
    // Must steer non-Latin scripts (e.g. Korean) to a translatable Latin name,
    // not the failing "in any language" guidance.
    expect(text).not.toContain("in any language");
    expect(text).toMatch(/Latin/);
    expect(text).toContain("Zurich");
  });

  it("returns an error string for an unknown location", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ results: [] }));
    const tool = createGetWeatherTool(fetchFn as unknown as typeof fetch);

    const out = await tool.execute({ location: "Nowheresville" }, ctx);

    expect(out).toContain("get_weather failed");
    expect(out).toContain("Nowheresville");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns an error string on a non-2xx forecast response", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(geoBody))
      .mockResolvedValueOnce(json({}, 500));
    const tool = createGetWeatherTool(fetchFn as unknown as typeof fetch);

    const out = await tool.execute({ location: "Zurich" }, ctx);

    expect(out).toContain("get_weather failed");
    expect(out).toContain("500");
  });
});
