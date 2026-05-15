/**
 * `lore run [command...]` — start gateway + launch an AI agent.
 *
 * If a command is given, launches it with gateway env vars injected.
 * If no command is given, auto-detects installed agents and either
 * uses the sole one found or prompts the user to pick.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { startGateway, probeGateway, type StartOptions } from "./start";
import { loadConfig } from "../config";
import { detectAgents, AGENTS, type DetectedAgent } from "./agents";
import { safeExit } from "./exit";
import { maybeAutoImport } from "./import-auto";

// ---------------------------------------------------------------------------
// Interactive agent picker (TTY only)
// ---------------------------------------------------------------------------

async function promptAgent(agents: DetectedAgent[]): Promise<DetectedAgent> {
  console.log("\n[lore] Multiple AI agents detected:\n");
  for (let i = 0; i < agents.length; i++) {
    console.log(`  ${i + 1}) ${agents[i].def.displayName} (${agents[i].path})`);
  }
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<DetectedAgent>((resolve) => {
    const ask = () => {
      rl.question("Choose an agent [1]: ", (answer) => {
        const trimmed = answer.trim();
        const idx = trimmed === "" ? 0 : Number.parseInt(trimmed, 10) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < agents.length) {
          rl.close();
          resolve(agents[idx]);
        } else {
          console.log(`  Invalid choice. Enter 1–${agents.length}.`);
          ask();
        }
      });
    };
    ask();
  });
}

// ---------------------------------------------------------------------------
// Resolve what to launch
// ---------------------------------------------------------------------------

interface LaunchTarget {
  command: string;
  args: string[];
  env: Record<string, string>;
}

async function resolveLaunchTarget(
  gatewayUrl: string,
  cmdArgs: string[],
  extraArgs: string[],
): Promise<LaunchTarget | null> {
  // --- Explicit command given: inject all known env vars ---
  if (cmdArgs.length > 0) {
    const cwd = process.cwd();
    const env: Record<string, string> = {};
    for (const agent of AGENTS) {
      Object.assign(env, agent.envVars(gatewayUrl, cwd));
    }
    return { command: cmdArgs[0], args: [...cmdArgs.slice(1), ...extraArgs], env };
  }

  // --- No command: auto-detect agents ---
  const detected = detectAgents();

  if (detected.length === 0) {
    console.error("[lore] No known AI agents found on PATH.");
    console.error("[lore] Install one of: Claude Code (claude), Codex (codex), Pi (pi), OpenCode (opencode)");
    console.error(`[lore] Or run with an explicit command: lore run <command>`);
    return null;
  }

  let agent: DetectedAgent;

  if (detected.length === 1) {
    agent = detected[0];
    console.log(`[lore] Detected ${agent.def.displayName} at ${agent.path}`);
  } else if (process.stdin.isTTY) {
    agent = await promptAgent(detected);
  } else {
    // Non-TTY with multiple agents — can't prompt
    console.error("[lore] Multiple agents detected but stdin is not a TTY.");
    console.error("[lore] Specify which agent to run: lore run <command>");
    for (const a of detected) {
      console.error(`  - ${a.def.displayName}: lore run ${a.def.binary}`);
    }
    return null;
  }

  return {
    command: agent.def.binary,
    args: [...extraArgs],
    env: agent.def.envVars(gatewayUrl, process.cwd()),
  };
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

function launchChild(target: LaunchTarget): ChildProcess {
  const env = { ...process.env, ...target.env };

  const child = spawn(target.command, target.args, {
    env,
    stdio: "inherit",
  });

  return child;
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function commandRun(
  opts: StartOptions,
  cmdArgs: string[],
  extraArgs: string[] = [],
): Promise<void> {
  // 1. Start gateway (or delegate to a remote one)
  const config = loadConfig();
  let gatewayUrl: string;
  let owned: boolean;
  let shutdown: () => Promise<void>;

  if (opts.remoteUrl || config.remoteUrl) {
    // Remote mode: delegate to an existing remote gateway.
    // The local CLI still runs on the developer's machine, so it can
    // safely compute the git remote and inject it as a header.
    const remoteUrl = opts.remoteUrl ?? config.remoteUrl!;
    const alive = await probeGateway(remoteUrl);
    if (!alive) {
      console.error(`[lore] Remote gateway at ${remoteUrl} is not reachable.`);
      console.error(`[lore] Check LORE_REMOTE_URL and ensure the gateway is running.`);
      return safeExit(1);
    }
    gatewayUrl = remoteUrl;
    owned = false;
    shutdown = async () => {};
    console.log(`[lore] Using remote gateway at ${gatewayUrl}`);
  } else {
    // Local mode: start (or reuse) a local gateway.
    const handle = await startGateway(opts);
    gatewayUrl = `http://${handle.config.hosts[0]}:${handle.port}`;
    owned = handle.owned;
    shutdown = handle.shutdown;

    if (owned) {
      console.log(`[lore] Gateway listening on ${gatewayUrl}`);
    } else {
      console.log(`[lore] Reusing existing gateway at ${gatewayUrl}`);
    }
  }
  console.log(`[lore] Dashboard: ${gatewayUrl}/ui`);

  // 2. Auto-detect prior conversations (first run only)
  if (owned) {
    await maybeAutoImport(config);
  }

  // 3. Resolve what to launch
  const target = await resolveLaunchTarget(gatewayUrl, cmdArgs, extraArgs);

  if (!target) {
    // No agent found — start server without launching an agent
    console.log("[lore] No agent detected. Point your agent at the gateway manually.");
    console.log(`[lore]   export ANTHROPIC_BASE_URL=${gatewayUrl}`);

    if (owned) {
      let shuttingDown = false;
      const onSignal = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        await shutdown();
        safeExit(0);
      };
      process.on("SIGINT", () => onSignal());
      process.on("SIGTERM", () => onSignal());
    }

    // Block forever
    return new Promise(() => {});
  }

  // 4. Launch agent child process
  console.log(`[lore] Launching: ${target.command} ${target.args.join(" ")}`.trimEnd());

  const child = launchChild(target);

  // Forward signals to child
  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  // Wait for child to exit, then tear down gateway (only if we own it)
  return new Promise<void>((resolve) => {
    child.on("exit", async (code, signal) => {
      if (owned) await shutdown();
      // Exit with the child's code (or 128 + signal number for signal deaths)
      if (signal) {
        const SIGNAL_CODES: Record<string, number> = {
          SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15,
        };
        safeExit(128 + (SIGNAL_CODES[signal] ?? 1));
      }
      safeExit(code ?? 0);
    });

    child.on("error", async (err) => {
      console.error(`[lore] Failed to launch ${target.command}: ${err.message}`);
      if (owned) await shutdown();
      safeExit(1);
    });
  });
}
