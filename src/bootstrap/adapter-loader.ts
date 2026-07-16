import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContainerOverrides } from "./container.js";
import type { Env } from "./env.js";

type AdapterFactory = (env: Env) => ContainerOverrides | Promise<ContainerOverrides>;
type ModuleImporter = (specifier: string) => Promise<unknown>;

function runtimeSpecifier(configured: string): string {
  if (configured.startsWith("file:")) return configured;
  if (configured.startsWith(".") || isAbsolute(configured)) {
    return pathToFileURL(resolve(configured)).href;
  }
  return configured;
}

/**
 * Load deployment-owned adapters without coupling the Agent to a vendor SDK.
 * A module may export `createAdapters` (preferred) or a default factory.
 */
export async function loadAdapterOverrides(
  env: Env,
  importer: ModuleImporter = (specifier) => import(specifier),
): Promise<ContainerOverrides> {
  if (!env.OPOD_ADAPTER_MODULE) return {};

  const configured = env.OPOD_ADAPTER_MODULE;
  const loaded = await importer(runtimeSpecifier(configured));
  if ((typeof loaded !== "object" && typeof loaded !== "function") || loaded === null) {
    throw new Error(`Adapter module "${configured}" did not export a factory.`);
  }

  const exports = loaded as { createAdapters?: unknown; default?: unknown };
  const factory = exports.createAdapters ?? exports.default;
  if (typeof factory !== "function") {
    throw new Error(
      `Adapter module "${configured}" must export createAdapters(env) or a default factory.`,
    );
  }

  const overrides = await (factory as AdapterFactory)(env);
  if (typeof overrides !== "object" || overrides === null) {
    throw new Error(`Adapter module "${configured}" returned an invalid adapter object.`);
  }
  return overrides;
}
