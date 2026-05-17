import { Command } from "commander";
import { loadConfig } from "../config";

export const buildCommand = new Command("build")
  .description("Build the project")
  .option("-o, --outdir <dir>", "Output directory", "dist")
  .action(async (opts) => {
    const config = loadConfig(process.cwd());
    if (!config) {
      console.error("No project config found. Run 'init' first.");
      process.exit(1);
    }
    console.log(`Building ${config.name} -> ${opts.outdir}/`);
    // Build logic here
  });
