/**
 * `lore run [command...]` — start gateway + launch an AI agent.
 *
 * If a command is given, launches it with gateway env vars injected.
 * If no command is given, auto-detects installed agents and either
 * uses the sole one found or prompts the user to pick.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { startGateway, type StartOptions } from "./start";
import { detectAgents, AGENTS, type DetectedAgent } from "./agents";

// ---------------------------------------------------------------------------
// Interactive agent picker (TTY only)
// ---------------------------------------------------------------------------

async function promptAgent(agents: DetectedAgent[]): Promise<DetectedAgent> {
  console.error("\n[lore] Multiple AI agents detected:\n");
  for (let i = 0; i < agents.length; i++) {
    console.error(`  ${i + 1}) ${agents[i].def.displayName} (${agents[i].path})`);
  }
  console.error();

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  return new Promise<DetectedAgent>((resolve) => {
    const ask = () => {
      rl.question("Choose an agent [1]: ", (answer) => {
        const trimmed = answer.trim();
        const idx = trimmed === "" ? 0 : Number.parseInt(trimmed, 10) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < agents.length) {
          rl.close();
          resolve(agents[idx]);
        } else {
          console.error(`  Invalid choice. Enter 1–${agents.length}.`);
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
): Promise<LaunchTarget | null> {
  // --- Explicit command given: inject all known env vars ---
  if (cmdArgs.length > 0) {
    const env: Record<string, string> = {};
    for (const agent of AGENTS) {
      Object.assign(env, agent.envVars(gatewayUrl));
    }
    return { command: cmdArgs[0], args: cmdArgs.slice(1), env };
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
    console.error(`[lore] Detected ${agent.def.displayName} at ${agent.path}`);
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
    args: [],
    env: agent.def.envVars(gatewayUrl),
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
): Promise<void> {
  // 1. Start gateway
  const { config, port, shutdown } = startGateway(opts);
  const gatewayUrl = `http://${config.host}:${port}`;

  console.error(`[lore] Gateway listening on ${gatewayUrl}`);

  // 2. Resolve what to launch
  const target = await resolveLaunchTarget(gatewayUrl, cmdArgs);

  if (!target) {
    // No agent found / non-interactive — fall back to server-only mode
    console.error("[lore] Running in server-only mode. Point your agent at the gateway manually.");
    console.error(`[lore]   export ANTHROPIC_BASE_URL=${gatewayUrl}`);

    const onSignal = async () => {
      await shutdown();
      process.exit(0);
    };
    process.on("SIGINT", () => onSignal());
    process.on("SIGTERM", () => onSignal());

    // Block forever
    return new Promise(() => {});
  }

  // 3. Launch agent child process
  console.error(`[lore] Launching: ${target.command} ${target.args.join(" ")}`.trimEnd());

  const child = launchChild(target);

  // Forward signals to child
  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  // Wait for child to exit, then tear down gateway
  return new Promise<void>((resolve) => {
    child.on("exit", async (code, signal) => {
      await shutdown();
      // Exit with the child's code (or 128 + signal number for signal deaths)
      if (signal) {
        const SIGNAL_CODES: Record<string, number> = {
          SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15,
        };
        process.exit(128 + (SIGNAL_CODES[signal] ?? 1));
      }
      process.exit(code ?? 0);
    });

    child.on("error", async (err) => {
      console.error(`[lore] Failed to launch ${target.command}: ${err.message}`);
      await shutdown();
      process.exit(1);
    });
  });
}
