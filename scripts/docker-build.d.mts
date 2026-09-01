export interface DockerBuildOptions {
  image?: string;
  platform?: string;
  containerTest?: boolean;
}

export function dockerBuildArguments(options?: DockerBuildOptions): string[];
export function runDockerBuild(options?: DockerBuildOptions): Promise<void>;
