/**
 * Provider registry — maintains a list of all known agent history providers.
 *
 * Providers register themselves at import time. The detection orchestrator
 * iterates over all registered providers to scan for conversation history.
 */
import type { AgentHistoryProvider } from "../types";

const providers: AgentHistoryProvider[] = [];

/** Register a provider. Called at module load time by each provider module. */
export function registerProvider(provider: AgentHistoryProvider): void {
  providers.push(provider);
}

/** Get all registered providers. */
export function getProviders(): readonly AgentHistoryProvider[] {
  return providers;
}

/** Get a provider by internal name. */
export function getProvider(name: string): AgentHistoryProvider | undefined {
  return providers.find((p) => p.name === name);
}

/**
 * Clear all registered providers.
 * Test-only — allows resetting the registry between test runs.
 */
export function clearProviders(): void {
  providers.length = 0;
}
