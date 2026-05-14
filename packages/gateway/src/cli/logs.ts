/**
 * `lore logs` — view the persistent activity log.
 *
 * Usage:
 *   lore logs              Print last 50 lines and exit
 *   lore logs -f           Follow log output in real-time
 *   lore logs -n 100       Print last 100 lines
 *   lore logs --path       Print the log file path and exit
 */
import {
  readFileSync,
  statSync,
  watchFile,
  unwatchFile,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { log } from "@loreai/core";
import { safeExit } from "./exit";

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function commandLogs(
  _positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const path = log.logFilePath();

  // --path: just print the path and exit
  if (values.path) {
    if (path) {
      console.log(path);
    } else {
      console.error("Log file path could not be resolved.");
      process.exit(1);
    }
    return;
  }

  if (!path) {
    console.error("Log file path could not be resolved.");
    process.exit(1);
  }

  // Check the file exists
  try {
    statSync(path);
  } catch {
    console.error(`No log file found at ${path}`);
    console.error("Logs are created when lore starts processing requests.");
    process.exit(1);
  }

  const follow = !!(values.follow || values.f);
  const lines = Number(values.n || values.lines) || 50;

  // Read the file and print the last N lines.
  // Max file size is 5 MB so reading entirely is fine.
  const content = readFileSync(path, "utf-8");
  const allLines = content.split("\n").filter(Boolean);
  const tail = allLines.slice(-lines);

  for (const line of tail) {
    console.log(line);
  }

  if (!follow) return;

  // Follow mode: poll for changes and print new content
  let lastSize = statSync(path).size;

  watchFile(path, { interval: 300 }, (curr) => {
    if (curr.size > lastSize) {
      // Read only the new bytes
      const bytesToRead = curr.size - lastSize;
      const fd = openSync(path, "r");
      const buf = Buffer.alloc(bytesToRead);
      readSync(fd, buf, 0, bytesToRead, lastSize);
      closeSync(fd);

      const newContent = buf.toString("utf-8");
      const newLines = newContent.split("\n").filter(Boolean);
      for (const line of newLines) {
        console.log(line);
      }
      lastSize = curr.size;
    } else if (curr.size < lastSize) {
      // File was rotated — reset to read from the beginning
      lastSize = 0;
    }
  });

  // Clean up on signal
  const cleanup = () => {
    unwatchFile(path);
    safeExit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Block forever
  return new Promise(() => {});
}
