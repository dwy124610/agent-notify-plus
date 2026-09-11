declare module "*grok-build/grok-build-agent-notify.mjs" {
  export interface GrokBuildConfig {
    serverUrl: string;
    token: string;
    timeoutMs: number;
    debugLogPath?: string;
  }
  export function parseGrokBuildConfig(raw: Record<string, unknown>): GrokBuildConfig;
  export function normalizeGrokBuildHookEvent(raw: unknown): string | undefined;
  export function getGrokBuildSessionId(raw: unknown): string | undefined;
  export function shouldForwardGrokBuildEvent(raw: unknown): boolean;
  export function enrichGrokBuildRaw(raw: unknown): unknown;
  export function handleGrokBuildEvent(
    config: GrokBuildConfig,
    raw: unknown,
    deps?: {
      fetchImpl?: typeof fetch;
      now?: Date;
      statePath?: string;
    },
  ): Promise<Record<string, unknown>>;
}
