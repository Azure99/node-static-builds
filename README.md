# node-static-builds

Static Linux Node.js runtimes built from the official Node.js source archive.

| Archive target | CPU baseline           | Runtime                      |
| -------------- | ---------------------- | ---------------------------- |
| linux-amd64    | x86-64, generic tuning | musl, fully static, full ICU |
| linux-arm64    | ARMv8-A                | musl, fully static, full ICU |

Each archive contains the Node executable, its license, the musl copyright notice, build configuration, installed toolchain versions, and a build record. The default V8 JIT and startup snapshot are retained. DNS resolution uses musl; applications requiring dynamically loaded native Node addons need a different runtime.

## Download

Choose a component version and architecture from [Releases](https://github.com/Azure99/node-static-builds/releases). Component versions combine the upstream Node version and a recipe revision, for example `node-v22.23.3-r1`.

```sh
(
set -eu
version=node-v22.23.3-r1
architecture=amd64
archive="$version-linux-$architecture.tar.gz"
base="https://github.com/Azure99/node-static-builds/releases/download/$version"
curl --fail --location --remote-name "$base/$archive"
curl --fail --location --remote-name "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf "$archive"
./runtime/bin/node --version
)
```

Build integrations pin the full release URL and archive SHA256. `runtime/build.json` identifies the Node source, recipe revision, target architecture, Alpine image, and build commit. Application source identity belongs to the consuming application.

## Build

Use a Linux host of the target architecture with Node.js 22.23.3 or newer, Docker BuildKit with `ADD --checksum` support, tar, readelf, and OpenSSL. Build inputs are defined in `component.json`, `packages.txt`, `Dockerfile`, and `scripts/build-node.sh`.

Specify an output directory outside the checkout:

```sh
node scripts/build.mjs amd64 /var/tmp/node-static-amd64
```

Use `arm64` on an ARM64 host. BuildKit downloads the fixed source archives, verifies their checksums, and reuses its download and build cache. The build command creates the runtime archive, then extracts it once to verify its ELF boundary and run the runtime checks. Compilation uses three make jobs; allow several GiB of memory and disk space for the source build.

`packages.txt` selects the direct toolchain dependencies. Actual installed versions are recorded in `runtime/build-packages.txt`; compiler configuration is in `runtime/build-config.gypi`.

For script changes, install the locked development dependencies and run ESLint, ShellCheck, and Prettier (ShellCheck must be available on the host):

```sh
npm ci
npm run lint
npm run format:check
```

## Release

Run the **Build and release** workflow manually from `main`. Native x64 and ARM64 jobs build and validate the final archives. The publish job checks their transferred checksums and source identities, then uploads both archives and one `SHA256SUMS` file. Temporary Actions artifacts transfer outputs between jobs and expire after one day.

Maintainers update `recipeRevision` when changing the build recipe for a Node version, and start at revision 1 for a new upstream Node version. A published target version is reused. A draft release or an existing tag without a release must be resolved before building that version. Published assets keep their original contents.

## License

Repository scripts are licensed under Apache-2.0. Runtime archives include the Node.js `LICENSE` and `runtime/licenses/musl-COPYRIGHT`.
