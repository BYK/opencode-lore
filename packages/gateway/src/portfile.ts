/**
 * Port file management — allows plugins to discover the gateway's actual port.
 *
 * When the gateway starts (especially on a fallback or random port), it writes
 * the actual port number to `~/.local/share/lore/gateway.port`. Plugins read
 * this file to locate the gateway without hardcoding a specific port.
 *
 * The file is removed on clean shutdown. Stale files (from crashes) are
 * harmless — plugins probe `/health` after reading the port and ignore
 * unresponsive ports.
 */
import { join } from "node:path";
import { writeFileSync, unlinkSync, readFileSync, mkdirSync } from "node:fs";
import { dataDir } from "@loreai/core";

const PORTFILE_NAME = "gateway.port";

function portfilePath(): string {
  return join(dataDir(), PORTFILE_NAME);
}

/** Write the actual port to disk so plugins can discover it. */
export function writePortFile(port: number): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(portfilePath(), String(port), "utf8");
}

/**
 * Remove the port file on shutdown — but only if it still contains the
 * port this instance wrote. This prevents a concurrent gateway instance
 * from losing its port file when a different instance shuts down.
 */
export function removePortFile(expectedPort: number): void {
  try {
    const current = readPortFile();
    if (current === expectedPort) {
      unlinkSync(portfilePath());
    }
  } catch {
    /* already gone or unreadable */
  }
}

/** Read the port file. Returns the port number or null if not found/invalid. */
export function readPortFile(): number | null {
  try {
    const content = readFileSync(portfilePath(), "utf8").trim();
    const port = Number.parseInt(content, 10);
    return port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}
