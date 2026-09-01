import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function dockerBuildArguments({
  image = "cloudframe:local",
  platform = process.env.CLOUDFRAME_DOCKER_PLATFORM ?? "",
  containerTest = false,
} = {}) {
  const args = ["build"];
  const selectedPlatform = String(platform).trim();
  if (selectedPlatform) args.push("--platform", selectedPlatform);
  if (containerTest) args.push("--build-arg", "CLOUDFRAME_CONTAINER_TEST=1");
  args.push("-t", image, ".");
  return args;
}

export function runDockerBuild(options = {}) {
  const args = dockerBuildArguments(options);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolvePromise()
      : reject(new Error(`docker ${args.join(" ")} exited ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runDockerBuild();
}
