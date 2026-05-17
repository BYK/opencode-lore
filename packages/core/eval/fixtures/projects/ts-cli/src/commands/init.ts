import { Command } from "commander";
import { loadConfig, writeConfig } from "../config";
import { ensureDir } from "../utils";

export const initCommand = new Command("init")
  .description("Initialize a new project")
  .option("-n, --name <name>", "Project name", "my-project")
  .action(async (opts) => {
    const dir = process.cwd();
    await ensureDir(`${dir}/src`);
    await ensureDir(`${dir}/tests`);
    writeConfig(dir, { name: opts.name, version: "0.1.0" });
    console.log(`Initialized project: ${opts.name}`);
  });
