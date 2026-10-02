import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recipe = JSON.parse(
  readFileSync(join(repositoryRoot, "component.json"), "utf8"),
);
export const targets = { amd64: "x64", arm64: "arm64" };
export const componentVersion = `node-v${recipe.node.version}-r${recipe.recipeRevision}`;
export const archiveName = (architecture) =>
  `${componentVersion}-linux-${architecture}.tar.gz`;
export const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

function output(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

function verifyArchive(archive, architecture, temporary) {
  const extracted = join(temporary, "verify");
  mkdirSync(extracted);
  run("tar", ["-xzf", archive, "-C", extracted]);
  const runtime = join(extracted, "runtime");
  const executable = join(runtime, "bin/node");
  const machine =
    architecture === "amd64"
      ? /Machine:\s+Advanced Micro Devices X86-64/
      : /Machine:\s+AArch64/;
  assert.match(output("readelf", ["-W", "-h", executable]), machine);
  assert.doesNotMatch(
    output("readelf", ["-W", "-l", executable]),
    /INTERP/,
    "Runtime has an ELF interpreter",
  );
  assert.doesNotMatch(
    output("readelf", ["-W", "-d", executable]),
    /NEEDED/,
    "Runtime has dynamic library dependencies",
  );
  for (const file of [
    "LICENSE",
    "licenses/musl-COPYRIGHT",
    "build-config.gypi",
    "build-packages.txt",
    "build.json",
  ]) {
    assert.ok(
      statSync(join(runtime, file)).size > 0,
      `Missing runtime file: ${file}`,
    );
  }
  run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(temporary, "tls-key.pem"),
      "-out",
      join(temporary, "tls-cert.pem"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  run(
    executable,
    [
      join(repositoryRoot, "scripts/verify-runtime.mjs"),
      recipe.node.version,
      targets[architecture],
      temporary,
    ],
    { timeout: 120000 },
  );
}

function build(architecture, destination) {
  assert.equal(process.platform, "linux", "Build on Linux");
  assert.equal(
    process.arch,
    targets[architecture],
    "Use a native runner for the requested architecture",
  );
  const relativeOutput = relative(repositoryRoot, destination);
  if (relativeOutput === "" || !relativeOutput.startsWith(`..${sep}`)) {
    throw new Error(
      "Place build output outside the checkout, for example /var/tmp/node-static-output",
    );
  }
  if (existsSync(destination)) {
    throw new Error(
      `Output already exists; choose an unused directory: ${destination}`,
    );
  }
  const gitOptions = { cwd: repositoryRoot };
  if (output("git", ["status", "--porcelain"], gitOptions)) {
    throw new Error("Commit source changes before building a component");
  }
  const sourceCommit = output("git", ["rev-parse", "HEAD"], gitOptions);
  const dockerArchitecture = output("docker", [
    "info",
    "--format",
    "{{.Architecture}}",
  ]);
  const accepted =
    architecture === "amd64" ? ["x86_64", "amd64"] : ["aarch64", "arm64"];
  assert.ok(
    accepted.includes(dockerArchitecture),
    "Docker must run on the requested native architecture",
  );
  const temporary = mkdtempSync("/var/tmp/node-static-build-");
  try {
    const context = join(temporary, "context");
    const built = join(temporary, "built");
    for (const file of [
      "Dockerfile",
      "packages.txt",
      "scripts/build-node.sh",
    ]) {
      mkdirSync(dirname(join(context, file)), { recursive: true });
      cpSync(join(repositoryRoot, file), join(context, file));
    }
    const argumentsByName = {
      ALPINE: recipe.alpine,
      NODE_ARCH: targets[architecture],
      NODE_URL: recipe.node.url,
      NODE_SHA256: recipe.node.sha256,
      MUSL_URL: recipe.muslCopyright.url,
      MUSL_SHA256: recipe.muslCopyright.sha256,
    };
    const proxyArguments = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]
      .filter((name) => process.env[name])
      .flatMap((name) => ["--build-arg", name]);
    console.log(
      `Building ${componentVersion} for ${architecture} from ${sourceCommit}`,
    );
    run("docker", [
      "buildx",
      "build",
      "--progress=plain",
      "--platform",
      `linux/${architecture}`,
      ...Object.entries(argumentsByName).flatMap(([name, value]) => [
        "--build-arg",
        `${name}=${value}`,
      ]),
      ...proxyArguments,
      "--output",
      `type=local,dest=${built}`,
      context,
    ]);
    const record = {
      nodeVersion: recipe.node.version,
      recipeRevision: recipe.recipeRevision,
      architecture,
      sourceCommit,
      nodeSourceSha256: recipe.node.sha256,
      alpineImage: recipe.alpine,
    };
    writeFileSync(
      join(built, "runtime/build.json"),
      JSON.stringify(record, null, 2) + "\n",
    );
    mkdirSync(destination, { recursive: true });
    const archive = join(destination, archiveName(architecture));
    run("tar", ["-czf", archive, "-C", built, "runtime"]);
    verifyArchive(archive, architecture, temporary);
    const handoff = {
      architecture,
      version: componentVersion,
      sourceCommit,
      sha256: sha256(archive),
    };
    writeFileSync(
      join(destination, `${architecture}.json`),
      JSON.stringify(handoff, null, 2) + "\n",
    );
    console.log(`Validated archive: ${archive}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [architecture, destination, extra] = process.argv.slice(2);
  if (!Object.hasOwn(targets, architecture) || !destination || extra) {
    throw new Error(
      "Usage: node scripts/build.mjs amd64|arm64 OUTPUT_DIRECTORY",
    );
  }
  build(architecture, resolve(destination));
}
