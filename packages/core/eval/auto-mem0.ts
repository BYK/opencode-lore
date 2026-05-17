/**
 * auto-mem0 integration for the Lore eval suite.
 *
 * Runs auto-mem0 (https://github.com/seyeong-han/auto-mem0) as a Python
 * sidecar for external memory baseline comparison. auto-mem0 is a
 * dependency-free Python memory layer that stores and retrieves memories
 * via embeddings.
 *
 * This module spawns a persistent Python subprocess that communicates
 * via JSON-over-stdin/stdout.
 */
import { spawn, type Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutoMem0Config {
  /** Path to the Python interpreter. */
  python?: string;
  /** Model to use for embeddings. */
  model?: string;
}

interface MemoryResult {
  text: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Python bridge script
// ---------------------------------------------------------------------------

/**
 * Inline Python script that wraps auto-mem0 and communicates via JSON lines.
 * Each input line is a JSON command; each output line is a JSON response.
 */
const BRIDGE_SCRIPT = `
import sys
import json

try:
    from auto_memory import AutoMemory
except ImportError:
    print(json.dumps({"error": "auto-memory not installed. Run: pip install auto-memory"}))
    sys.stdout.flush()
    sys.exit(1)

mem = AutoMemory()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        cmd = json.loads(line)
        action = cmd.get("action")

        if action == "add":
            text = cmd["text"]
            session_id = cmd.get("session_id", "default")
            mem.save(text, metadata={"session_id": session_id})
            print(json.dumps({"ok": True}))

        elif action == "search":
            query = cmd["query"]
            limit = cmd.get("limit", 5)
            results = mem.search(query, top_k=limit)
            items = []
            for r in results:
                if hasattr(r, 'payload'):
                    items.append({"text": r.payload.get("text", str(r)), "score": float(getattr(r, 'score', 0))})
                elif isinstance(r, dict):
                    items.append({"text": r.get("text", str(r)), "score": float(r.get("score", 0))})
                else:
                    items.append({"text": str(r), "score": 0.0})
            print(json.dumps({"results": items}))

        elif action == "clear":
            mem = AutoMemory()
            print(json.dumps({"ok": True}))

        elif action == "ping":
            print(json.dumps({"ok": True, "version": "auto-mem0"}))

        else:
            print(json.dumps({"error": f"Unknown action: {action}"}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))

    sys.stdout.flush()
`;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AutoMem0Client {
  private proc: Subprocess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buffer = "";
  private pending: Array<{
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }> = [];
  private ready = false;

  constructor(private config: AutoMem0Config = {}) {}

  /**
   * Start the Python sidecar process.
   */
  async start(): Promise<void> {
    const python = this.config.python ?? "python3";

    this.proc = spawn([python, "-u", "-c", BRIDGE_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.writer = this.proc.stdin.getWriter();

    // Read stdout line by line
    this.readLoop();

    // Verify the process started successfully
    const pingResult = await this.send({ action: "ping" });
    if ((pingResult as { error?: string }).error) {
      throw new Error(
        `auto-mem0 failed to start: ${(pingResult as { error: string }).error}`,
      );
    }
    this.ready = true;
  }

  private async readLoop(): Promise<void> {
    if (!this.proc) return;

    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const waiter = this.pending.shift();
            if (waiter) waiter.resolve(data);
          } catch {
            // malformed JSON — skip
          }
        }
      }
    } catch {
      // process exited
    }
  }

  private async send(cmd: Record<string, unknown>): Promise<unknown> {
    if (!this.writer) throw new Error("auto-mem0 not started");

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      // Timeout after 30s
      setTimeout(() => reject(new Error("auto-mem0 timeout")), 30_000);
    });

    const line = JSON.stringify(cmd) + "\n";
    await this.writer.write(new TextEncoder().encode(line));

    return promise;
  }

  /**
   * Add a memory from a conversation session.
   */
  async addMemory(text: string, sessionId?: string): Promise<void> {
    const result = (await this.send({
      action: "add",
      text,
      session_id: sessionId,
    })) as { ok?: boolean; error?: string };

    if (result.error) {
      throw new Error(`auto-mem0 addMemory failed: ${result.error}`);
    }
  }

  /**
   * Search memories for relevant context.
   */
  async searchMemory(
    query: string,
    limit = 5,
  ): Promise<MemoryResult[]> {
    const result = (await this.send({
      action: "search",
      query,
      limit,
    })) as { results?: MemoryResult[]; error?: string };

    if (result.error) {
      throw new Error(`auto-mem0 searchMemory failed: ${result.error}`);
    }

    return result.results ?? [];
  }

  /**
   * Clear all stored memories (reset for next scenario).
   */
  async clear(): Promise<void> {
    const result = (await this.send({ action: "clear" })) as {
      ok?: boolean;
      error?: string;
    };
    if (result.error) {
      throw new Error(`auto-mem0 clear failed: ${result.error}`);
    }
  }

  /**
   * Stop the Python process.
   */
  async stop(): Promise<void> {
    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        // ignore
      }
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.ready = false;
    this.pending = [];
  }

  get isReady(): boolean {
    return this.ready;
  }
}

// ---------------------------------------------------------------------------
// Convenience: format memories as context string
// ---------------------------------------------------------------------------

/**
 * Search auto-mem0 and format results as a context block for QA.
 */
export async function getAutoMem0Context(
  client: AutoMem0Client,
  question: string,
  limit = 10,
): Promise<string> {
  const memories = await client.searchMemory(question, limit);

  if (memories.length === 0) {
    return "[No relevant memories found in auto-mem0]";
  }

  const lines = memories.map(
    (m, i) => `${i + 1}. [score: ${m.score.toFixed(3)}] ${m.text}`,
  );

  return `## Relevant Memories (auto-mem0)\n\n${lines.join("\n")}`;
}

/**
 * Check if auto-mem0 is available (Python + package installed).
 */
export async function isAutoMem0Available(): Promise<boolean> {
  try {
    const proc = spawn(["python3", "-c", "import auto_memory; print('ok')"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    return output.trim() === "ok";
  } catch {
    return false;
  }
}
