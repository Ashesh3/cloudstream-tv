export interface ContainerSmokeCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ContainerSmokeHttpResult {
  status: number;
  headers: Headers | Record<string, string>;
  json?: unknown;
  bytes?: Uint8Array;
  text?: string;
}

export interface ContainerSmokeDependencies {
  run?(command: string, args: string[]): Promise<ContainerSmokeCommandResult>;
  http?(input: { baseUrl: string; path: string; method?: string; headers?: Record<string, string>; json?: unknown }): Promise<ContainerSmokeHttpResult>;
  randomSuffix?(): string;
  tempDirectory?(): Promise<string>;
  wait?(milliseconds: number): Promise<void>;
  keep?: boolean;
}

export function runContainerSmoke(dependencies?: ContainerSmokeDependencies): Promise<void>;
