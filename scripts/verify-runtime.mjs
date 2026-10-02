import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lookup, resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, get } from "node:https";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

if (!isMainThread) {
  parentPort.postMessage(createHash("sha256").update("worker").digest("hex"));
} else {
  const [version, architecture, fixture] = process.argv.slice(2);
  assert.equal(process.version, `v${version}`);
  assert.equal(process.arch, architecture);
  assert.equal(process.platform, "linux");
  assert.equal(String(process.config.variables.node_shared), "false");
  assert.equal(String(process.config.variables.icu_small), "false");
  assert.equal(String(process.config.variables.node_use_node_snapshot), "true");
  const directory = await mkdtemp(join(fixture, "runtime-"));
  let worker, server, database;
  try {
    assert.equal(randomBytes(32).length, 32);
    assert.equal(scryptSync("password", "salt", 32).length, 32);
    assert.equal(
      Intl.DateTimeFormat.supportedLocalesOf(["zh-CN", "fr-FR"]).length,
      2,
    );
    assert.match(
      new Intl.DateTimeFormat("fr-FR", {
        month: "long",
        timeZone: "UTC",
      }).format(new Date("2026-02-01T00:00:00Z")),
      /f.vrier/,
    );
    await writeFile(join(directory, "file"), "runtime-data\n");
    assert.equal(
      await readFile(join(directory, "file"), "utf8"),
      "runtime-data\n",
    );
    const child = spawnSync(
      process.execPath,
      ["-e", 'process.stdout.write("child-ok")'],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "child-ok");
    worker = new Worker(new URL(import.meta.url));
    assert.equal(
      (await once(worker, "message"))[0],
      createHash("sha256").update("worker").digest("hex"),
    );
    await worker.terminate();
    worker = undefined;
    assert.ok((await lookup("localhost")).address);
    assert.ok((await lookup("nodejs.org")).address);
    assert.ok((await resolve4("nodejs.org")).length);
    const cert = await readFile(join(fixture, "tls-cert.pem"));
    server = createServer(
      { key: await readFile(join(fixture, "tls-key.pem")), cert },
      (request, response) => response.end("tls-ok"),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const body = await new Promise((resolve, reject) => {
      const request = get(
        `https://127.0.0.1:${server.address().port}`,
        { ca: cert },
        async (response) => {
          try {
            const parts = [];
            for await (const part of response) {
              parts.push(part);
            }
            resolve(Buffer.concat(parts).toString());
          } catch (error) {
            reject(error);
          }
        },
      );
      request.on("error", reject);
      request.setTimeout(30000, () =>
        request.destroy(new Error("TLS request timed out")),
      );
    });
    assert.equal(body, "tls-ok");
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
    database = new DatabaseSync(join(directory, "state.db"));
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE data(body TEXT); BEGIN; INSERT INTO data VALUES ('preserved'); COMMIT",
    );
    assert.equal(
      database.prepare("PRAGMA journal_mode").get().journal_mode,
      "wal",
    );
    database.close();
    database = new DatabaseSync(join(directory, "state.db"));
    assert.equal(
      database.prepare("SELECT body FROM data").get().body,
      "preserved",
    );
    assert.equal(
      database.prepare("PRAGMA quick_check").get().quick_check,
      "ok",
    );
    database.close();
    database = undefined;
    console.log(
      JSON.stringify({
        nodeVersion: version,
        architecture,
        icu: process.versions.icu,
        checks: [
          "static-config",
          "full-icu",
          "crypto",
          "filesystem",
          "child",
          "worker",
          "localhost-dns",
          "external-dns",
          "tls-with-ca",
          "sqlite-wal-reopen",
        ],
      }),
    );
  } finally {
    database?.close();
    if (worker) {
      await worker.terminate();
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
}
