#!/usr/bin/env node
/**
 * Minimal MCP client for smoke-testing the server over stdio.
 *
 * Speaks raw JSON-RPC down the same pipe a real client would use: initialize,
 * tools/list, then whatever tools/call requests are passed as argv. Exists so
 * the server can be exercised end to end without wiring up a full MCP host.
 *
 *   node test-stdio.mjs                       # handshake + list tools only
 *   node test-stdio.mjs check_credits         # ...then call a tool with no args
 *   node test-stdio.mjs lookup_company:shopify.com
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const calls = process.argv.slice(2);
const child = spawn("node", ["build/index.js"], {
  cwd: import.meta.dirname,
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("  [non-JSON on stdout]", line);
    return;
  }
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await send("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.0" },
});
console.log(
  `  initialize -> ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version} ` +
    `(protocol ${init.result?.protocolVersion})`,
);
notify("notifications/initialized", {});

const list = await send("tools/list", {});
console.log(`  tools/list -> ${list.result.tools.length} tools`);
for (const t of list.result.tools) {
  const required = t.inputSchema?.required ?? [];
  const props = Object.keys(t.inputSchema?.properties ?? {});
  console.log(`    - ${t.name}(${props.map((p) => (required.includes(p) ? p : p + "?")).join(", ")})`);
  // The directory rejects tools with no title or hints, and the only place
  // those show up is the wire, so check them here rather than in the source.
  const a = t.annotations ?? {};
  const hints = Object.entries(a)
    .filter(([k]) => k !== "title")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`        title: ${t.title ?? a.title ?? "MISSING"}`);
  console.log(`        hints: ${hints || "MISSING"}`);
}

for (const spec of calls) {
  const [name, ...rest] = spec.split(":");
  const value = rest.join(":");
  const args = !value
    ? {}
    : name === "lookup_technology"
      ? { technology: value }
      : name === "lookup_companies"
        ? { domains: value.split(",").map((d) => d.trim()).filter(Boolean) }
        : { domain: value };
  const res = await send("tools/call", { name, arguments: args });
  const body = res.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(res.error ?? res);
  console.log(`\n  tools/call ${name}(${JSON.stringify(args)}):`);
  console.log(
    body
      .split("\n")
      .map((l) => "    " + l)
      .join("\n"),
  );
}

child.kill();
