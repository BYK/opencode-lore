import { Command } from "commander";
import { initCommand } from "./commands/init";
import { buildCommand } from "./commands/build";

const program = new Command();

program.name("demo-cli").description("A demo CLI tool").version("0.1.0");

program.addCommand(initCommand);
program.addCommand(buildCommand);

program.parse();
