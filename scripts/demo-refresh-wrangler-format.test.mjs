import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseD1Response } from "./demo-refresh-execution.mjs";

// Actual installed CLI, but a loopback fake API and fake credentials. Never
// calls Cloudflare. API overrides remain forbidden in the refresh runner.
test(
  "installed Wrangler 4.156.2 remote-file stdout has raw spinner lines before the successful JSON import receipt",
  { timeout: 60000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "wrangler-import-format-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const requests = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({
        method: req.method,
        path: req.url,
        body: body ? JSON.parse(body) : null,
      });
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/import") && JSON.parse(body).action === "init")
        res.end(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: {
              success: true,
              status: "complete",
              messages: [],
              result: {
                num_queries: 750,
                final_bookmark: "synthetic-bookmark",
                meta: {
                  duration: 1,
                  rows_read: 730,
                  rows_written: 2,
                  size_after: 100000,
                },
              },
            },
          })
        );
      else {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 7000, message: "unexpected loopback request" }],
          })
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const config = join(dir, "wrangler.json"),
      sql = join(dir, "batch.sql"),
      empty = join(dir, "empty.env");
    writeFileSync(
      config,
      JSON.stringify({
        name: "isolated-format-test",
        compatibility_date: "2026-11-02",
        d1_databases: [
          {
            binding: "DB",
            database_name: "synthetic-only",
            database_id: "11111111-1111-4111-8111-111111111111",
          },
        ],
      })
    );
    writeFileSync(sql, "SELECT 1;");
    writeFileSync(empty, "");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../apps/api/node_modules/wrangler/bin/wrangler.js",
              import.meta.url
            )
          ),
          "d1",
          "execute",
          "DB",
          "--remote",
          "--config",
          config,
          "--env-file",
          empty,
          "--file",
          sql,
          "--json",
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: dir,
            USERPROFILE: dir,
            CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
            CLOUDFLARE_API_TOKEN: "synthetic-only-token",
            CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${server.address().port}/client/v4`,
            WRANGLER_SEND_METRICS: "false",
            NO_COLOR: "1",
          },
        }
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.throws(() => JSON.parse(result.stdout));
    assert.match(result.stdout, /Checking if file needs uploading/);
    const parsed = parseD1Response(result.stdout, "write.response", true);
    assert.equal(parsed[0].success, true);
    assert.equal(parsed[0].results[0]["Total queries executed"], 750);
    assert.equal(parsed[0].meta.rows_written, 2);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.action, "init");
    for (const output of [
      "├ Checking if file needs uploading\n│\n├ 🌌 Uploading synthetic-file.sql\n│ 🌌 Uploading complete.\n│\n" +
        JSON.stringify(parsed),
      JSON.stringify(parsed),
    ])
      assert.deepEqual(parseD1Response(output, "write.response", true), parsed);
  }
);
