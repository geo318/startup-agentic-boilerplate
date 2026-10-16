#!/usr/bin/env node
import { context, keyOf, load, touch, update } from "./state.mjs";
import { identity } from "./processes.mjs";
import { begin } from "./git.mjs";
import { borrow, finish, run, sweep } from "./runtime.mjs";

function parse(argv) {
  const [command = "status", ...args] = argv;
  const options = {};
  let child = [];
  const booleans = new Set(["json", "isolate", "foreground", "release-retained"]);
  const values = new Set(["root", "session", "turn", "intent", "reason", "ref", "remote", "label", "pid", "owner-pid", "retain"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") { child = args.slice(i + 1); break; }
    const name = args[i].slice(2);
    if (!args[i].startsWith("--") || (!booleans.has(name) && !values.has(name))) throw new Error(`unknown-argument: ${args[i]}`);
    const key = name === "owner-pid" ? "ownerPid" : name === "release-retained" ? "releaseRetained" : name;
    if (booleans.has(name)) options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing-value: ${name}`);
      options[key] = value;
    }
  }
  for (const key of ["pid", "ownerPid", "retain"]) if (options[key] !== undefined) {
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || (key === "retain" && options[key] > 86400)) throw new Error(`invalid-${key}`);
  }
  if (options.ownerPid) { options.ownerIdentity = identity(options.ownerPid); if (!options.ownerIdentity) throw new Error("owner-not-running"); }
  return { command, options, child };
}

async function main() {
  const { command, options, child } = parse(process.argv.slice(2));
  const ctx = context(options.root);
  let result;
  switch (command) {
    case "begin": await sweep(ctx); result = await begin(ctx, options); break;
    case "run": result = await run(ctx, options, child, (text) => (options.json ? process.stderr : process.stdout).write(text)); break;
    case "borrow": result = await borrow(ctx, options); break;
    case "finish": result = await finish(ctx, options, { retained: !options.releaseRetained }); break;
    case "sweep": result = await sweep(ctx); break;
    case "touch":
      if (!options.session) throw new Error("session-id-required");
      result = await update(ctx, (state) => {
        const item = state.sessions[keyOf(options.session)];
        if (!item?.initialized || (options.turn && options.turn !== item.turn)) throw new Error("begin-required");
        touch(state, item, options.turn);
        return { version: 1, code: "renewed", session: item.id, turn: item.turn };
      });
      break;
    case "status": {
      const recovery = await sweep(ctx);
      result = { ...recovery, state: load(ctx) };
      // Tokens are runtime control details, not part of the inspection output.
      for (const resource of Object.values(result.state.resources)) delete resource.token;
      break;
    }
    default: throw new Error(`unknown-command: ${command}`);
  }
  if (options.json) console.log(JSON.stringify(result));
  else if (result.git) console.log(`Session ${result.session}; turn ${result.turn}; ${result.git.code}: ${result.git.reason}\nCheckout: ${result.checkout}`);
  else console.log(`${result.code}; ${result.resource ? `resource ${result.resource}` : `${result.resources ?? 0} recorded resources`}${result.listeners?.length ? `; ${result.listeners.join(", ")}` : ""}`);
  if (result.code === "cleanup-incomplete") process.exitCode = 1;
  if (result.exitCode) process.exitCode = result.exitCode;
}

main().catch((error) => { console.error(`session: ${error.message}`); process.exitCode = 1; });
