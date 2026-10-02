import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { archiveName, componentVersion, sha256, targets } from "./build.mjs";

const repository = "Azure99/node-static-builds";

function ghJson(args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
}

function gh(args) {
  execFileSync("gh", args, { stdio: "inherit" });
}

function targetState() {
  const query = `query($tag:String!,$ref:String!) {
    repository(owner:"Azure99",name:"node-static-builds") {
      release(tagName:$tag) { databaseId isDraft url }
      ref(qualifiedName:$ref) { name }
    }
  }`;
  const result = ghJson([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `tag=${componentVersion}`,
    "-f",
    `ref=refs/tags/${componentVersion}`,
  ]);
  return result.data.repository;
}

function preflight() {
  const state = targetState();
  if (state.release?.isDraft) {
    throw new Error(
      `Resolve the existing draft before building ${componentVersion}`,
    );
  }
  if (state.release) {
    console.log(`Using published component: ${state.release.url}`);
    return false;
  }
  if (state.ref) {
    throw new Error(
      `Tag ${componentVersion} exists without a release; resolve it before building`,
    );
  }
  console.log(`Ready to build ${componentVersion}`);
  return true;
}

function publish(directory) {
  const sourceCommit = process.env.GITHUB_SHA;
  assert.match(
    sourceCommit ?? "",
    /^[0-9a-f]{40}$/,
    "GITHUB_SHA must identify the workflow source",
  );
  const sums = new Map();
  for (const architecture of Object.keys(targets)) {
    const handoff = JSON.parse(
      readFileSync(join(directory, `${architecture}.json`), "utf8"),
    );
    assert.equal(
      handoff.architecture,
      architecture,
      "Artifact target mismatch",
    );
    assert.equal(
      handoff.version,
      componentVersion,
      "Artifact version mismatch",
    );
    assert.equal(
      handoff.sourceCommit,
      sourceCommit,
      "Artifact source commit mismatch",
    );
    const name = archiveName(architecture);
    assert.equal(
      sha256(join(directory, name)),
      handoff.sha256,
      `Artifact checksum mismatch: ${name}`,
    );
    sums.set(name, handoff.sha256);
  }
  const checksumFile = join(directory, "SHA256SUMS");
  writeFileSync(
    checksumFile,
    [...sums].map(([name, sum]) => `${sum}  ${name}`).join("\n") + "\n",
  );
  sums.set("SHA256SUMS", sha256(checksumFile));
  const state = targetState();
  if (state.release || state.ref) {
    throw new Error(
      `Target ${componentVersion} already exists; published assets are kept intact`,
    );
  }
  gh([
    "release",
    "create",
    componentVersion,
    "--repo",
    repository,
    "--target",
    sourceCommit,
    "--draft",
    "--title",
    componentVersion,
    "--notes",
    `Static musl Node.js for Linux amd64 and arm64, with full ICU. Build source: ${sourceCommit}.`,
  ]);
  gh([
    "release",
    "upload",
    componentVersion,
    "--repo",
    repository,
    ...[...sums.keys()].map((name) => join(directory, name)),
  ]);
  const { assets } = ghJson([
    "release",
    "view",
    componentVersion,
    "--repo",
    repository,
    "--json",
    "assets",
  ]);
  assert.deepEqual(
    assets.map((asset) => asset.name).sort(),
    [...sums.keys()].sort(),
    "Release assets are incomplete",
  );
  for (const asset of assets) {
    assert.equal(
      asset.state,
      "uploaded",
      `Incomplete release asset: ${asset.name}`,
    );
    assert.equal(
      asset.size,
      statSync(join(directory, asset.name)).size,
      `Release asset size mismatch: ${asset.name}`,
    );
    assert.equal(
      asset.digest,
      `sha256:${sums.get(asset.name)}`,
      `Release asset checksum mismatch: ${asset.name}`,
    );
  }
  gh([
    "release",
    "edit",
    componentVersion,
    "--repo",
    repository,
    "--draft=false",
  ]);
}

const [command, directory, extra] = process.argv.slice(2);
if (command === "preflight" && !directory) {
  const shouldBuild = preflight();
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `build=${shouldBuild}\n`);
  }
} else if (command === "publish" && directory && !extra) {
  publish(resolve(directory));
} else {
  throw new Error(
    "Usage: node scripts/release.mjs preflight | publish ARTIFACT_DIRECTORY",
  );
}
