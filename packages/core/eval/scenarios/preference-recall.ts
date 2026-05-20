/**
 * Dimension 3: User Preference Recall
 *
 * Tests whether Lore learns and consistently applies user preferences
 * expressed during conversations. Covers explicit statements (PR-1),
 * implicit behavioral patterns (PR-2), and preference evolution (PR-3).
 */
import type {
  ScenarioDefinition,
  SessionTranscript,
  EvalQuestion,
  ConversationTurn,
} from "../types";
import { RUBRICS } from "../judge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let toolCallId = 0;
function nextToolId(): string {
  return `toolu_eval_pr_${String(++toolCallId).padStart(4, "0")}`;
}

function userText(text: string, timestamp?: number): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function assistantText(text: string, timestamp?: number): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function assistantToolUse(
  name: string,
  input: unknown,
  timestamp?: number,
): { turn: ConversationTurn; id: string } {
  const id = nextToolId();
  return {
    id,
    turn: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
      timestamp,
    },
  };
}

function userToolResult(
  toolUseId: string,
  content: string,
  timestamp?: number,
  isError?: boolean,
): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    timestamp,
  };
}

// Base timestamps: sessions are hours/days apart
const T0 = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// PR-1: Explicit Preference Statements
// ---------------------------------------------------------------------------

const pr1Session1Turns: ConversationTurn[] = (() => {
  const base = T0;
  const turns: ConversationTurn[] = [];

  // Turn 1: User asks to set up a new React + TypeScript project
  turns.push(
    userText(
      "I need to scaffold a new React project with TypeScript for our dashboard app. Can you set it up?",
      base,
    ),
  );

  // Turn 2: Assistant suggests using npm init
  turns.push(
    assistantText(
      "Sure! Let me create the project structure. I'll start by initializing with npm:\n\n```bash\nnpm init -y\nnpm install react react-dom typescript @types/react @types/react-dom\n```\n\nShall I proceed?",
      base + 1 * MINUTE,
    ),
  );

  // Turn 3: User corrects — pnpm preference (PREFERENCE 1)
  turns.push(
    userText(
      "Hold on — can you use pnpm for that? I always use pnpm, not npm or yarn. It's faster and handles the node_modules better.",
      base + 2 * MINUTE,
    ),
  );

  // Turn 4: Assistant acknowledges and runs pnpm
  const t4 = assistantToolUse(
    "bash",
    { command: "pnpm init && pnpm add react react-dom typescript @types/react @types/react-dom" },
    base + 3 * MINUTE,
  );
  turns.push(t4.turn);

  // Turn 5: Tool result
  turns.push(
    userToolResult(
      t4.id,
      "Packages: +5\n+++++\nProgress: resolved 5, reused 3, downloaded 2, added 5, done",
      base + 3.5 * MINUTE,
    ),
  );

  // Turn 6: Assistant creates tsconfig with non-strict mode
  const t6 = assistantToolUse(
    "write",
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            module: "ESNext",
            jsx: "react-jsx",
            outDir: "./dist",
            rootDir: "./src",
          },
        },
        null,
        2,
      ),
    },
    base + 4 * MINUTE,
  );
  turns.push(t6.turn);

  // Turn 7: Tool result
  turns.push(
    userToolResult(t6.id, "File written: tsconfig.json", base + 4.5 * MINUTE),
  );

  // Turn 8: User corrects — TypeScript strict mode (PREFERENCE 2)
  turns.push(
    userText(
      "You need to enable strict mode in tsconfig. Always use TypeScript strict mode — I never allow `any` types in my codebase. Add `strict: true` and `noImplicitAny: true`.",
      base + 5 * MINUTE,
    ),
  );

  // Turn 9: Assistant fixes tsconfig
  const t9 = assistantToolUse(
    "write",
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            module: "ESNext",
            jsx: "react-jsx",
            strict: true,
            noImplicitAny: true,
            outDir: "./dist",
            rootDir: "./src",
          },
        },
        null,
        2,
      ),
    },
    base + 6 * MINUTE,
  );
  turns.push(t9.turn);

  // Turn 10: Tool result
  turns.push(
    userToolResult(t9.id, "File written: tsconfig.json", base + 6.5 * MINUTE),
  );

  // Turn 11: Assistant starts writing a class component
  turns.push(
    assistantText(
      "Great, now let me create the main Dashboard component:\n\n```tsx\nimport React, { Component } from 'react';\n\ninterface DashboardProps {\n  title: string;\n}\n\ninterface DashboardState {\n  isLoading: boolean;\n}\n\nexport default class Dashboard extends Component<DashboardProps, DashboardState> {\n  state: DashboardState = { isLoading: true };\n\n  render() {\n    return <div>{this.props.title}</div>;\n  }\n}\n```\n\nShall I write this to `src/components/dashboard.tsx`?",
      base + 8 * MINUTE,
    ),
  );

  // Turn 12: User rejects class component — functional preference (PREFERENCE 3)
  turns.push(
    userText(
      "No, please rewrite that as a functional component. I prefer functional components over class components in React — they're simpler and hooks are more composable.",
      base + 9 * MINUTE,
    ),
  );

  // Turn 13: Assistant rewrites as functional + uses default export
  const t13 = assistantToolUse(
    "write",
    {
      path: "src/components/dashboard.tsx",
      content: `import { useState } from 'react';

interface DashboardProps {
  title: string;
}

export default function Dashboard({ title }: DashboardProps) {
  const [isLoading, setIsLoading] = useState(true);

  return <div>{title}</div>;
}
`,
    },
    base + 10 * MINUTE,
  );
  turns.push(t13.turn);

  // Turn 14: Tool result
  turns.push(
    userToolResult(
      t13.id,
      "File written: src/components/dashboard.tsx",
      base + 10.5 * MINUTE,
    ),
  );

  // Turn 15: User corrects export style (PREFERENCE 4)
  turns.push(
    userText(
      "One thing — prefer named exports over default exports. I use named exports everywhere so the imports are explicit and refactor-friendly. Can you fix that?",
      base + 11 * MINUTE,
    ),
  );

  // Turn 16: Assistant fixes to named export
  const t16 = assistantToolUse(
    "write",
    {
      path: "src/components/dashboard.tsx",
      content: `import { useState } from 'react';

interface DashboardProps {
  title: string;
}

export function Dashboard({ title }: DashboardProps) {
  const [isLoading, setIsLoading] = useState(true);

  return <div>{title}</div>;
}
`,
    },
    base + 12 * MINUTE,
  );
  turns.push(t16.turn);

  // Turn 17: Tool result
  turns.push(
    userToolResult(
      t16.id,
      "File written: src/components/dashboard.tsx",
      base + 12.5 * MINUTE,
    ),
  );

  // Turn 18: User asks about file naming, states kebab-case preference (PREFERENCE 5)
  turns.push(
    userText(
      "Also, I noticed the file is named `dashboard.tsx` — that's fine. I use kebab-case for file names. So `user-profile.tsx`, `data-table.tsx`, etc. Please keep that convention going forward.",
      base + 14 * MINUTE,
    ),
  );

  // Turn 19: Assistant acknowledges and creates another component
  const t19 = assistantToolUse(
    "write",
    {
      path: "src/components/sidebar-nav.tsx",
      content: `export interface SidebarNavProps {
  items: Array<{ label: string; href: string }>;
}

export function SidebarNav({ items }: SidebarNavProps) {
  return (
    <nav>
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <a href={item.href}>{item.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
`,
    },
    base + 15 * MINUTE,
  );
  turns.push(t19.turn);

  // Turn 20: Tool result
  turns.push(
    userToolResult(
      t19.id,
      "File written: src/components/sidebar-nav.tsx",
      base + 15.5 * MINUTE,
    ),
  );

  // Turn 21: User wants to commit, states git workflow preference (PREFERENCE 6)
  turns.push(
    userText(
      "This looks good. Let's commit this. But never push directly to main — always create a branch and open a PR. Can you create a feature branch and commit?",
      base + 17 * MINUTE,
    ),
  );

  // Turn 22: Assistant creates branch and commits
  const t22 = assistantToolUse(
    "bash",
    { command: "git checkout -b feat/dashboard-scaffold && git add -A && git commit -m 'feat: scaffold dashboard with React + TypeScript'" },
    base + 18 * MINUTE,
  );
  turns.push(t22.turn);

  // Turn 23: Tool result
  turns.push(
    userToolResult(
      t22.id,
      "[feat/dashboard-scaffold abc1234] feat: scaffold dashboard with React + TypeScript\n 5 files changed, 87 insertions(+)",
      base + 18.5 * MINUTE,
    ),
  );

  // Turn 24: User wraps up
  turns.push(
    userText(
      "Perfect, that's exactly right. Push the branch and open a PR when you're ready.",
      base + 19 * MINUTE,
    ),
  );

  // Turn 25: Assistant pushes and opens PR
  const t25 = assistantToolUse(
    "bash",
    { command: "git push -u origin feat/dashboard-scaffold" },
    base + 20 * MINUTE,
  );
  turns.push(t25.turn);

  // Turn 26: Tool result
  turns.push(
    userToolResult(
      t25.id,
      "To github.com:acme/dashboard.git\n * [new branch]  feat/dashboard-scaffold -> feat/dashboard-scaffold\nBranch 'feat/dashboard-scaffold' set up to track remote branch 'feat/dashboard-scaffold' from 'origin'.",
      base + 20.5 * MINUTE,
    ),
  );

  // Turn 27: Assistant confirms
  turns.push(
    assistantText(
      "Branch pushed! I'll open a PR now. The scaffold includes:\n- React + TypeScript with strict mode\n- Dashboard and SidebarNav functional components with named exports\n- kebab-case file naming convention\n\nAll set up with pnpm as the package manager.",
      base + 21 * MINUTE,
    ),
  );

  return turns;
})();

const pr1Session2Turns: ConversationTurn[] = (() => {
  const base = T0 + 2 * DAY; // 2 days later
  const turns: ConversationTurn[] = [];

  // Turn 1: User starts a new task
  turns.push(
    userText(
      "I need to add a data table component to the dashboard. It should support sorting, pagination, and filtering. Let's start with the basic structure.",
      base,
    ),
  );

  // Turn 2: Assistant begins implementation (tests: uses functional component, named export, kebab-case)
  const t2 = assistantToolUse(
    "write",
    {
      path: "src/components/data-table.tsx",
      content: `import { useState, useMemo } from 'react';

export interface Column<T> {
  key: keyof T;
  label: string;
  sortable?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  pageSize?: number;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  pageSize = 10,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<keyof T | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(
    () => data.filter((row) =>
      Object.values(row).some((v) =>
        String(v).toLowerCase().includes(filter.toLowerCase())
      )
    ),
    [data, filter],
  );

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const aVal = String(a[sortKey]);
      const bVal = String(b[sortKey]);
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
  }, [filtered, sortKey, sortDir]);

  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.ceil(sorted.length / pageSize);

  return (
    <div>
      <input
        type="text"
        placeholder="Filter..."
        value={filter}
        onChange={(e) => { setFilter(e.target.value); setPage(0); }}
      />
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={String(col.key)}
                onClick={() => {
                  if (col.sortable) {
                    setSortKey(col.key);
                    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                  }
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paged.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td key={String(col.key)}>{String(row[col.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <span>Page {page + 1} of {totalPages}</span>
        <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}
`,
    },
    base + 2 * MINUTE,
  );
  turns.push(t2.turn);

  // Turn 3: Tool result
  turns.push(
    userToolResult(
      t2.id,
      "File written: src/components/data-table.tsx",
      base + 2.5 * MINUTE,
    ),
  );

  // Turn 4: User wants to install dependencies
  turns.push(
    userText(
      "Nice. I want to add a testing library too. Can you add vitest and @testing-library/react?",
      base + 4 * MINUTE,
    ),
  );

  // Turn 5: Assistant uses pnpm (tests: package manager recall)
  const t5 = assistantToolUse(
    "bash",
    { command: "pnpm add -D vitest @testing-library/react @testing-library/jest-dom" },
    base + 5 * MINUTE,
  );
  turns.push(t5.turn);

  // Turn 6: Tool result
  turns.push(
    userToolResult(
      t5.id,
      "Packages: +3\n+++\nProgress: resolved 8, reused 5, downloaded 3, added 3, done",
      base + 5.5 * MINUTE,
    ),
  );

  // Turn 7: User asks for a test file
  turns.push(
    userText(
      "Write a test for the DataTable component — sorting and pagination at minimum.",
      base + 7 * MINUTE,
    ),
  );

  // Turn 8: Assistant writes test (tests: kebab-case filename)
  const t8 = assistantToolUse(
    "write",
    {
      path: "src/components/__tests__/data-table.test.tsx",
      content: `import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DataTable } from '../data-table';

const TEST_DATA = [
  { name: 'Alice', age: 30 },
  { name: 'Bob', age: 25 },
  { name: 'Charlie', age: 35 },
];

const COLUMNS = [
  { key: 'name' as const, label: 'Name', sortable: true },
  { key: 'age' as const, label: 'Age', sortable: true },
];

describe('DataTable', () => {
  it('renders all rows', () => {
    render(<DataTable columns={COLUMNS} data={TEST_DATA} />);
    expect(screen.getByText('Alice')).toBeDefined();
    expect(screen.getByText('Bob')).toBeDefined();
    expect(screen.getByText('Charlie')).toBeDefined();
  });

  it('sorts by column on header click', () => {
    render(<DataTable columns={COLUMNS} data={TEST_DATA} />);
    fireEvent.click(screen.getByText('Name'));
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Alice');
    expect(rows[3]).toHaveTextContent('Charlie');
  });

  it('paginates with pageSize', () => {
    render(<DataTable columns={COLUMNS} data={TEST_DATA} pageSize={2} />);
    expect(screen.getByText('Alice')).toBeDefined();
    expect(screen.getByText('Bob')).toBeDefined();
    expect(screen.queryByText('Charlie')).toBeNull();

    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Charlie')).toBeDefined();
    expect(screen.queryByText('Alice')).toBeNull();
  });
});
`,
    },
    base + 9 * MINUTE,
  );
  turns.push(t8.turn);

  // Turn 9: Tool result
  turns.push(
    userToolResult(
      t8.id,
      "File written: src/components/__tests__/data-table.test.tsx",
      base + 9.5 * MINUTE,
    ),
  );

  // Turn 10: User wants to commit
  turns.push(
    userText(
      "Great, let's commit this. Same workflow as before.",
      base + 11 * MINUTE,
    ),
  );

  // Turn 11: Assistant creates branch (tests: never push to main)
  const t11 = assistantToolUse(
    "bash",
    { command: "git checkout -b feat/data-table && git add -A && git commit -m 'feat: add DataTable component with sorting, pagination, and filtering'" },
    base + 12 * MINUTE,
  );
  turns.push(t11.turn);

  // Turn 12: Tool result
  turns.push(
    userToolResult(
      t11.id,
      "[feat/data-table def5678] feat: add DataTable component with sorting, pagination, and filtering\n 3 files changed, 142 insertions(+)",
      base + 12.5 * MINUTE,
    ),
  );

  // Turn 13: Assistant pushes
  const t13 = assistantToolUse(
    "bash",
    { command: "git push -u origin feat/data-table" },
    base + 13 * MINUTE,
  );
  turns.push(t13.turn);

  // Turn 14: Tool result
  turns.push(
    userToolResult(
      t13.id,
      "To github.com:acme/dashboard.git\n * [new branch]  feat/data-table -> feat/data-table",
      base + 13.5 * MINUTE,
    ),
  );

  // Turn 15: Assistant summary
  turns.push(
    assistantText(
      "Done! Created branch `feat/data-table` and pushed. The DataTable component uses:\n- Functional component with named export\n- Strict TypeScript (no `any`)\n- kebab-case file naming\n- Tests written with vitest\n\nReady for PR review.",
      base + 14 * MINUTE,
    ),
  );

  return turns;
})();

const pr1Session1: SessionTranscript = {
  id: "pr1-session1-establish",
  label: "PR-1 Session 1: Establish explicit preferences",
  projectPath: "/tmp/eval-project-pr1",
  turns: pr1Session1Turns,
  metadata: {
    totalTokens: 8_000,
    description:
      "Coding session where user naturally states preferences: pnpm, strict TypeScript, " +
      "functional components, named exports, kebab-case files, never push to main.",
  },
};

const pr1Session2: SessionTranscript = {
  id: "pr1-session2-test",
  label: "PR-1 Session 2: Test preference adherence",
  projectPath: "/tmp/eval-project-pr1",
  turns: pr1Session2Turns,
  metadata: {
    totalTokens: 6_000,
    description:
      "New coding task testing whether previously stated preferences are recalled and applied.",
  },
};

const pr1Questions: EvalQuestion[] = [
  // --- Direct recall questions (5) ---
  {
    id: "pr1-q1",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session1-establish",
    question: "What is the user's preferred package manager?",
    referenceAnswer:
      "The user prefers pnpm. They explicitly stated 'I always use pnpm, not npm or yarn' and corrected the assistant when it initially suggested npm.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      turnIndex: 2,
      difficulty: "easy",
      tags: ["preference", "package-manager", "direct-recall"],
    },
  },
  {
    id: "pr1-q2",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session1-establish",
    question: "What is the user's policy on pushing to the main branch?",
    referenceAnswer:
      "The user said to never push directly to main — always create a branch and open a PR. This is a strong directive using the word 'never'.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      turnIndex: 20,
      difficulty: "easy",
      tags: ["preference", "git-workflow", "direct-recall"],
    },
  },
  {
    id: "pr1-q3",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session1-establish",
    question: "What file naming convention does the user prefer?",
    referenceAnswer:
      "The user prefers kebab-case for file names. They gave examples: 'user-profile.tsx', 'data-table.tsx' and said to keep that convention going forward.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      turnIndex: 17,
      difficulty: "easy",
      tags: ["preference", "naming-convention", "direct-recall"],
    },
  },
  {
    id: "pr1-q4",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session1-establish",
    question: "What is the user's stance on TypeScript's `any` type?",
    referenceAnswer:
      "The user never allows `any` types. They said 'Always use TypeScript strict mode' and 'I never allow `any` types in my codebase'. They required both `strict: true` and `noImplicitAny: true` in tsconfig.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      turnIndex: 7,
      difficulty: "easy",
      tags: ["preference", "typescript", "direct-recall"],
    },
  },
  {
    id: "pr1-q5",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session1-establish",
    question: "What export style does the user prefer for modules?",
    referenceAnswer:
      "The user prefers named exports over default exports. They said 'I use named exports everywhere so the imports are explicit and refactor-friendly'.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      turnIndex: 14,
      difficulty: "easy",
      tags: ["preference", "exports", "direct-recall"],
    },
  },
  // --- Application questions (5) ---
  {
    id: "pr1-q6",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session2-test",
    question:
      "If the user asks to create a new React component called UserProfile, what conventions should be followed based on their stated preferences?",
    referenceAnswer:
      "The component should be: (1) a functional component, not a class component, (2) exported as a named export (`export function UserProfile`), (3) placed in a file named with kebab-case (`user-profile.tsx`), (4) written in strict TypeScript with no `any` types.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      difficulty: "medium",
      tags: ["preference", "application", "component-creation"],
    },
  },
  {
    id: "pr1-q7",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session2-test",
    question:
      "If the user asks to add a new dependency, which command should be used?",
    referenceAnswer:
      "Use `pnpm add <package>` (or `pnpm add -D <package>` for dev dependencies). The user explicitly prefers pnpm over npm and yarn.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      difficulty: "medium",
      tags: ["preference", "application", "package-manager"],
    },
  },
  {
    id: "pr1-q8",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session2-test",
    question:
      "After making changes, what git workflow should be followed to commit and share the work?",
    referenceAnswer:
      "Create a feature branch first (e.g., `git checkout -b feat/<feature-name>`), commit to that branch, push the branch to origin, and open a PR. Never push directly to main.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      difficulty: "medium",
      tags: ["preference", "application", "git-workflow"],
    },
  },
  {
    id: "pr1-q9",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session2-test",
    question:
      "If generating a TypeScript interface, should `any` be used for unknown field types?",
    referenceAnswer:
      "No. The user never allows `any` types. Use `unknown`, a specific type, or a generic instead. The user insists on strict TypeScript with `noImplicitAny: true`.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      difficulty: "medium",
      tags: ["preference", "application", "typescript"],
    },
  },
  {
    id: "pr1-q10",
    dimension: "preferences",
    scenario: "pr-1-explicit",
    sessionRef: "pr1-session2-test",
    question:
      "What kind of React component should be generated — class-based or functional?",
    referenceAnswer:
      "Always functional components. The user explicitly said 'I prefer functional components over class components in React' and rejected a class component, asking for it to be rewritten as functional.",
    rubric: RUBRICS.explicitPreference,
    metadata: {
      difficulty: "medium",
      tags: ["preference", "application", "react"],
    },
  },
];

// ---------------------------------------------------------------------------
// PR-2: Implicit Preference Detection
// ---------------------------------------------------------------------------

const pr2Session1Turns: ConversationTurn[] = (() => {
  const base = T0 + 1 * DAY;
  const turns: ConversationTurn[] = [];

  // Turn 1: User asks to implement a REST endpoint
  turns.push(
    userText(
      "I need to implement a REST endpoint for creating users in our Express app. It should validate the input and store to PostgreSQL.",
      base,
    ),
  );

  // Turn 2: Assistant writes initial code with `let`
  const t2 = assistantToolUse(
    "write",
    {
      path: "src/routes/users.ts",
      content: `import { Router } from 'express';
import { pool } from '../db';

let router = Router();

router.post('/users', async (req, res) => {
  let { name, email, role } = req.body;
  let result = await pool.query(
    'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *',
    [name, email, role]
  );
  res.status(201).json(result.rows[0]);
});

export { router as userRouter };
`,
    },
    base + 2 * MINUTE,
  );
  turns.push(t2.turn);

  // Turn 3: Tool result
  turns.push(
    userToolResult(t2.id, "File written: src/routes/users.ts", base + 2.5 * MINUTE),
  );

  // Turn 4: User corrects let → const (IMPLICIT PATTERN: const preference, occurrence 1)
  turns.push(
    userText(
      "Change `let router` to `const router` — it's never reassigned. Same for the destructuring, use `const` there too.",
      base + 3 * MINUTE,
    ),
  );

  // Turn 5: Assistant fixes
  const t5 = assistantToolUse(
    "write",
    {
      path: "src/routes/users.ts",
      content: `import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.post('/users', async (req, res) => {
  const { name, email, role } = req.body;
  const result = await pool.query(
    'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *',
    [name, email, role]
  );
  res.status(201).json(result.rows[0]);
});

export { router as userRouter };
`,
    },
    base + 4 * MINUTE,
  );
  turns.push(t5.turn);

  // Turn 6: Tool result
  turns.push(
    userToolResult(t5.id, "File written: src/routes/users.ts", base + 4.5 * MINUTE),
  );

  // Turn 7: User asks for validation
  turns.push(
    userText(
      "Good. Now add input validation — name and email are required, email must be a valid format.",
      base + 6 * MINUTE,
    ),
  );

  // Turn 8: Assistant writes validation with `let`
  const t8 = assistantToolUse(
    "write",
    {
      path: "src/routes/users.ts",
      content: `import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.post('/users', async (req, res) => {
  const { name, email, role } = req.body;

  let errors = [];
  if (!name) errors.push('name is required');
  if (!email) errors.push('email is required');
  let emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  if (email && !emailRegex.test(email)) errors.push('invalid email format');

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  const result = await pool.query(
    'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *',
    [name, email, role]
  );
  res.status(201).json(result.rows[0]);
});

export { router as userRouter };
`,
    },
    base + 8 * MINUTE,
  );
  turns.push(t8.turn);

  // Turn 9: Tool result
  turns.push(
    userToolResult(t9_id(), "File written: src/routes/users.ts", base + 8.5 * MINUTE),
  );
  // Patch: we need the actual id from t8
  turns[turns.length - 1] = userToolResult(
    (t8.turn.content[0] as { id: string }).id,
    "File written: src/routes/users.ts",
    base + 8.5 * MINUTE,
  );

  // Turn 10: User corrects let → const again (occurrence 2)
  turns.push(
    userText(
      "The `errors` array and `emailRegex` should be `const`, not `let`. We push into the array but never reassign the variable itself.",
      base + 9 * MINUTE,
    ),
  );

  // Turn 11: Assistant suggests using an ORM
  turns.push(
    assistantText(
      "Got it, I'll fix those. By the way, would you like me to set up Prisma or TypeORM for the database layer? It would give us automatic migrations and type safety.",
      base + 10 * MINUTE,
    ),
  );

  // Turn 12: User rejects ORM — raw SQL preference (IMPLICIT PATTERN: no ORMs)
  turns.push(
    userText(
      "No thanks. I don't like ORMs — they add too much abstraction and make debugging queries harder. Let's stick with raw SQL using pg. I always prefer knowing exactly what queries are running.",
      base + 11 * MINUTE,
    ),
  );

  // Turn 13: User asks for more endpoints
  turns.push(
    userText(
      "Now add a GET /users/:id endpoint to fetch a single user.",
      base + 13 * MINUTE,
    ),
  );

  // Turn 14: Assistant writes the endpoint — no error handling
  const t14 = assistantToolUse(
    "write",
    {
      path: "src/routes/users.ts",
      content: `import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.post('/users', async (req, res) => {
  const { name, email, role } = req.body;
  const errors: string[] = [];
  if (!name) errors.push('name is required');
  if (!email) errors.push('email is required');
  const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  if (email && !emailRegex.test(email)) errors.push('invalid email format');
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }
  const result = await pool.query(
    'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *',
    [name, email, role]
  );
  res.status(201).json(result.rows[0]);
});

router.get('/users/:id', async (req, res) => {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  res.json(result.rows[0]);
});

export { router as userRouter };
`,
    },
    base + 15 * MINUTE,
  );
  turns.push(t14.turn);

  // Turn 15: Tool result
  turns.push(
    userToolResult(
      (t14.turn.content[0] as { id: string }).id,
      "File written: src/routes/users.ts",
      base + 15.5 * MINUTE,
    ),
  );

  // Turn 16: User adds error handling (IMPLICIT PATTERN: always add error handling)
  turns.push(
    userText(
      "You're missing error handling on the GET endpoint. What if the user doesn't exist? What if the DB query throws? Always wrap DB calls in try/catch and return appropriate status codes.",
      base + 16 * MINUTE,
    ),
  );

  // Turn 17: Assistant fixes with error handling
  const t17 = assistantToolUse(
    "write",
    {
      path: "src/routes/users.ts",
      content: `import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.post('/users', async (req, res) => {
  try {
    const { name, email, role } = req.body;
    const errors: string[] = [];
    if (!name) errors.push('name is required');
    if (!email) errors.push('email is required');
    const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
    if (email && !emailRegex.test(email)) errors.push('invalid email format');
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }
    const result = await pool.query(
      'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *',
      [name, email, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Failed to create user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Failed to fetch user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as userRouter };
`,
    },
    base + 18 * MINUTE,
  );
  turns.push(t17.turn);

  // Turn 18: Tool result
  turns.push(
    userToolResult(
      (t17.turn.content[0] as { id: string }).id,
      "File written: src/routes/users.ts",
      base + 18.5 * MINUTE,
    ),
  );

  // Turn 19: User immediately asks for tests (IMPLICIT PATTERN: always wants tests)
  turns.push(
    userText(
      "Good, now write the tests for both endpoints before we move on.",
      base + 19 * MINUTE,
    ),
  );

  // Turn 20: Assistant writes tests with `let`
  const t20 = assistantToolUse(
    "write",
    {
      path: "src/routes/__tests__/users.test.ts",
      content: `import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app } from '../../app';
import { pool } from '../../db';

describe('POST /users', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM users WHERE email LIKE $1', ['%test%']);
  });

  it('creates a user with valid input', async () => {
    let response = await request(app)
      .post('/users')
      .send({ name: 'Test User', email: 'test@example.com', role: 'viewer' });
    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Test User');
  });

  it('returns 400 for missing name', async () => {
    let response = await request(app)
      .post('/users')
      .send({ email: 'test@example.com' });
    expect(response.status).toBe(400);
    expect(response.body.errors).toContain('name is required');
  });

  it('returns 400 for invalid email', async () => {
    let response = await request(app)
      .post('/users')
      .send({ name: 'Test', email: 'not-an-email' });
    expect(response.status).toBe(400);
    expect(response.body.errors).toContain('invalid email format');
  });
});

describe('GET /users/:id', () => {
  it('returns a user by id', async () => {
    let created = await pool.query(
      "INSERT INTO users (name, email) VALUES ('Test', 'get-test@example.com') RETURNING *"
    );
    let response = await request(app).get(\`/users/\${created.rows[0].id}\`);
    expect(response.status).toBe(200);
    expect(response.body.email).toBe('get-test@example.com');
  });

  it('returns 404 for non-existent user', async () => {
    let response = await request(app).get('/users/99999');
    expect(response.status).toBe(404);
  });
});
`,
    },
    base + 22 * MINUTE,
  );
  turns.push(t20.turn);

  // Turn 21: Tool result
  turns.push(
    userToolResult(
      (t20.turn.content[0] as { id: string }).id,
      "File written: src/routes/__tests__/users.test.ts",
      base + 22.5 * MINUTE,
    ),
  );

  // Turn 22: User corrects let → const again (occurrence 3)
  turns.push(
    userText(
      "Please change all those `let response` and `let created` to `const`. You keep using `let` when there's no reassignment.",
      base + 23 * MINUTE,
    ),
  );

  // Turn 23: Assistant acknowledges
  turns.push(
    assistantText(
      "You're right, I apologize for the repeated mistake. I've updated all variable declarations to use `const` since none of them are reassigned. I'll be more careful about this going forward.",
      base + 24 * MINUTE,
    ),
  );

  // Turn 24: User asks for a DELETE endpoint (no tests yet — will they ask?)
  turns.push(
    userText(
      "Add a DELETE /users/:id endpoint as well.",
      base + 26 * MINUTE,
    ),
  );

  // Turn 25: Assistant implements DELETE
  const t25 = assistantToolUse(
    "write",
    {
      path: "src/routes/users.ts",
      content: `// ... (previous code) ...

router.delete('/users/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error('Failed to delete user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
`,
    },
    base + 28 * MINUTE,
  );
  turns.push(t25.turn);

  // Turn 26: Tool result
  turns.push(
    userToolResult(
      (t25.turn.content[0] as { id: string }).id,
      "File written: src/routes/users.ts",
      base + 28.5 * MINUTE,
    ),
  );

  // Turn 27: User immediately asks for tests (IMPLICIT PATTERN: always wants tests, occurrence 2)
  turns.push(
    userText(
      "And the tests for DELETE? Don't forget those.",
      base + 29 * MINUTE,
    ),
  );

  // Turn 28: Assistant writes DELETE tests
  const t28 = assistantToolUse(
    "write",
    {
      path: "src/routes/__tests__/users.test.ts",
      content: `// ... (previous tests) ...

describe('DELETE /users/:id', () => {
  it('deletes an existing user', async () => {
    const created = await pool.query(
      "INSERT INTO users (name, email) VALUES ('ToDelete', 'del@example.com') RETURNING *"
    );
    const response = await request(app).delete(\`/users/\${created.rows[0].id}\`);
    expect(response.status).toBe(204);
  });

  it('returns 404 for non-existent user', async () => {
    const response = await request(app).delete('/users/99999');
    expect(response.status).toBe(404);
  });
});
`,
    },
    base + 31 * MINUTE,
  );
  turns.push(t28.turn);

  // Turn 29: Tool result
  turns.push(
    userToolResult(
      (t28.turn.content[0] as { id: string }).id,
      "File written: src/routes/__tests__/users.test.ts",
      base + 31.5 * MINUTE,
    ),
  );

  return turns;

  // Helper for the inline id reference that was incorrectly used
  function t9_id(): string {
    return (t8.turn.content[0] as { id: string }).id;
  }
})();

const pr2Session2Turns: ConversationTurn[] = (() => {
  const base = T0 + 3 * DAY;
  const turns: ConversationTurn[] = [];

  // Turn 1: New task — different context to test implicit recall
  turns.push(
    userText(
      "I need to build a product catalog API. Let's start with the list and detail endpoints.",
      base,
    ),
  );

  // Turn 2: Assistant implementation (testing: uses const, raw SQL, error handling, no ORM)
  const t2 = assistantToolUse(
    "write",
    {
      path: "src/routes/products.ts",
      content: `import { Router } from 'express';
import { pool } from '../db';

const router = Router();

router.get('/products', async (req, res) => {
  try {
    const { category, minPrice, maxPrice } = req.query;
    let query = 'SELECT * FROM products WHERE 1=1';
    const params: unknown[] = [];

    if (category) {
      params.push(category);
      query += \` AND category = $\${params.length}\`;
    }
    if (minPrice) {
      params.push(Number(minPrice));
      query += \` AND price >= $\${params.length}\`;
    }
    if (maxPrice) {
      params.push(Number(maxPrice));
      query += \` AND price <= $\${params.length}\`;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to list products:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/products/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Failed to fetch product:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as productRouter };
`,
    },
    base + 3 * MINUTE,
  );
  turns.push(t2.turn);

  // Turn 3: Tool result
  turns.push(
    userToolResult(
      (t2.turn.content[0] as { id: string }).id,
      "File written: src/routes/products.ts",
      base + 3.5 * MINUTE,
    ),
  );

  // Turn 4: User continues naturally
  turns.push(
    userText(
      "Looks good. Now add a POST endpoint for creating products.",
      base + 5 * MINUTE,
    ),
  );

  // Turn 5: Assistant adds POST
  turns.push(
    assistantText(
      "I'll add a POST /products endpoint with validation and error handling:\n\n```typescript\nrouter.post('/products', async (req, res) => {\n  try {\n    const { name, category, price, description } = req.body;\n    const errors: string[] = [];\n    if (!name) errors.push('name is required');\n    if (!price || price <= 0) errors.push('price must be positive');\n    if (errors.length > 0) return res.status(400).json({ errors });\n\n    const result = await pool.query(\n      'INSERT INTO products (name, category, price, description) VALUES ($1, $2, $3, $4) RETURNING *',\n      [name, category, price, description]\n    );\n    res.status(201).json(result.rows[0]);\n  } catch (err) {\n    console.error('Failed to create product:', err);\n    res.status(500).json({ error: 'Internal server error' });\n  }\n});\n```\n\nShall I write this and then add the tests?",
      base + 7 * MINUTE,
    ),
  );

  // Turn 6: User confirms (IMPLICIT PATTERN: expects tests alongside implementation)
  turns.push(
    userText(
      "Yes, write it and the tests together please.",
      base + 8 * MINUTE,
    ),
  );

  // Turn 7-8: Implementation + tests written (omitted for brevity, assistant complies)
  turns.push(
    assistantText(
      "Done — I've written the POST endpoint and 4 test cases covering valid creation, missing name, invalid price, and server error handling. All using `const`, raw SQL with `pg`, and proper try/catch blocks.",
      base + 12 * MINUTE,
    ),
  );

  return turns;
})();

const pr2Session1: SessionTranscript = {
  id: "pr2-session1-implicit",
  label: "PR-2 Session 1: Implicit preference establishment",
  projectPath: "/tmp/eval-project-pr2",
  turns: pr2Session1Turns,
  metadata: {
    totalTokens: 10_000,
    description:
      "Coding session where user shows preferences through behavior: corrects let→const 3 times, " +
      "rejects ORM in favor of raw SQL, insists on error handling, always asks for tests.",
  },
};

const pr2Session2: SessionTranscript = {
  id: "pr2-session2-test",
  label: "PR-2 Session 2: Test implicit preference recall",
  projectPath: "/tmp/eval-project-pr2",
  turns: pr2Session2Turns,
  metadata: {
    totalTokens: 5_000,
    description:
      "New coding task testing whether implicit preferences (const, raw SQL, error handling, tests) are recalled.",
  },
};

const pr2Questions: EvalQuestion[] = [
  {
    id: "pr2-q1",
    dimension: "preferences",
    scenario: "pr-2-implicit",
    sessionRef: "pr2-session1-implicit",
    question:
      "Does the user prefer `const` or `let` for variable declarations?",
    referenceAnswer:
      "The user strongly prefers `const` over `let`. They corrected the assistant three separate times for using `let` when variables were not reassigned, saying things like 'Change let to const' and 'You keep using let when there's no reassignment'.",
    rubric: RUBRICS.implicitPreference,
    metadata: {
      difficulty: "easy",
      tags: ["implicit-preference", "const-vs-let", "repeated-correction"],
    },
  },
  {
    id: "pr2-q2",
    dimension: "preferences",
    scenario: "pr-2-implicit",
    sessionRef: "pr2-session1-implicit",
    question: "What is the user's stance on ORMs?",
    referenceAnswer:
      "The user doesn't like ORMs. When the assistant suggested Prisma or TypeORM, the user said 'I don't like ORMs — they add too much abstraction and make debugging queries harder' and prefers raw SQL using the pg library so they know exactly what queries are running.",
    rubric: RUBRICS.implicitPreference,
    metadata: {
      turnIndex: 11,
      difficulty: "easy",
      tags: ["implicit-preference", "orm", "database"],
    },
  },
  {
    id: "pr2-q3",
    dimension: "preferences",
    scenario: "pr-2-implicit",
    sessionRef: "pr2-session1-implicit",
    question: "Does the user expect tests to be written alongside implementation?",
    referenceAnswer:
      "Yes. The user consistently asked for tests immediately after implementation was done. They said 'write the tests for both endpoints before we move on' and 'And the tests for DELETE? Don't forget those.' This is a clear behavioral pattern — they always want tests alongside new code.",
    rubric: RUBRICS.implicitPreference,
    metadata: {
      difficulty: "medium",
      tags: ["implicit-preference", "testing", "behavioral-pattern"],
    },
  },
  {
    id: "pr2-q4",
    dimension: "preferences",
    scenario: "pr-2-implicit",
    sessionRef: "pr2-session1-implicit",
    question: "What does the user expect for error handling in API endpoints?",
    referenceAnswer:
      "The user expects comprehensive error handling: try/catch blocks around database calls, appropriate HTTP status codes (404 for not found, 400 for validation errors, 500 for server errors), and console.error logging. They corrected the assistant for missing error handling on the GET endpoint.",
    rubric: RUBRICS.implicitPreference,
    metadata: {
      turnIndex: 15,
      difficulty: "medium",
      tags: ["implicit-preference", "error-handling", "correction"],
    },
  },
  {
    id: "pr2-q5",
    dimension: "preferences",
    scenario: "pr-2-implicit",
    sessionRef: "pr2-session2-test",
    question:
      "If building a new database query for an API endpoint, should an ORM be used?",
    referenceAnswer:
      "No. The user prefers raw SQL using the pg library directly (pool.query). They explicitly rejected Prisma/TypeORM because ORMs add too much abstraction and make debugging harder.",
    rubric: RUBRICS.implicitPreference,
    metadata: {
      difficulty: "easy",
      tags: ["implicit-preference", "application", "database"],
    },
  },
  {
    id: "pr2-q6",
    dimension: "preferences",
    scenario: "pr-2-implicit",
    sessionRef: "pr2-session2-test",
    question:
      "When generating new code, should `let` be used for variables that are not reassigned?",
    referenceAnswer:
      "No. Always use `const` for variables that are not reassigned. The user corrected this three times and expressed frustration ('You keep using let when there's no reassignment'). Only use `let` when the variable will actually be reassigned.",
    rubric: RUBRICS.implicitPreference,
    metadata: {
      difficulty: "easy",
      tags: ["implicit-preference", "application", "const-vs-let"],
    },
  },
  {
    id: "pr2-q7",
    dimension: "preferences",
    scenario: "pr-2-implicit",
    sessionRef: "pr2-session2-test",
    question:
      "After implementing a new API endpoint, what should be done before moving on?",
    referenceAnswer:
      "Tests should be written. The user consistently asked for tests immediately after each endpoint was implemented and reminded the assistant when tests were not included ('Don't forget those'). Tests should be written alongside the implementation, not deferred.",
    rubric: RUBRICS.implicitPreference,
    metadata: {
      difficulty: "medium",
      tags: ["implicit-preference", "application", "testing"],
    },
  },
  {
    id: "pr2-q8",
    dimension: "preferences",
    scenario: "pr-2-implicit",
    sessionRef: "pr2-session2-test",
    question:
      "When writing a new route handler, what error handling pattern should be followed?",
    referenceAnswer:
      "Wrap the handler body in try/catch, return 404 for missing resources, 400 for validation errors, 500 for unexpected errors, and log errors with console.error. The user insisted on this pattern after the assistant omitted error handling on the GET /users/:id endpoint.",
    rubric: RUBRICS.implicitPreference,
    metadata: {
      difficulty: "medium",
      tags: ["implicit-preference", "application", "error-handling"],
    },
  },
];

// ---------------------------------------------------------------------------
// PR-3: Preference Evolution
// ---------------------------------------------------------------------------

const pr3Session1Turns: ConversationTurn[] = (() => {
  const base = T0;
  const turns: ConversationTurn[] = [];

  // Turn 1: User sets up a testing pipeline
  turns.push(
    userText(
      "I need to set up a testing framework for this Node.js project. What do you recommend?",
      base,
    ),
  );

  // Turn 2: Assistant suggests options
  turns.push(
    assistantText(
      "There are several good options for Node.js testing:\n\n1. **Mocha** — flexible, mature, pairs with Chai for assertions\n2. **Jest** — all-in-one with built-in mocking and assertions\n3. **Vitest** — fast, Vite-native, Jest-compatible API\n\nWhat's your preference?",
      base + 1 * MINUTE,
    ),
  );

  // Turn 3: User picks Mocha (INITIAL PREFERENCE)
  turns.push(
    userText(
      "I prefer Mocha for testing. It's what I've used for years and I like the flexibility of choosing my own assertion library. Let's set up Mocha with Chai.",
      base + 2 * MINUTE,
    ),
  );

  // Turn 4: Assistant sets up Mocha
  const t4 = assistantToolUse(
    "bash",
    { command: "pnpm add -D mocha chai @types/mocha @types/chai ts-node" },
    base + 3 * MINUTE,
  );
  turns.push(t4.turn);

  // Turn 5: Tool result
  turns.push(
    userToolResult(
      t4.id,
      "Packages: +6\nProgress: resolved 12, reused 8, downloaded 4, added 6, done",
      base + 3.5 * MINUTE,
    ),
  );

  // Turn 6: Assistant creates mocha config
  const t6 = assistantToolUse(
    "write",
    {
      path: ".mocharc.yml",
      content: `require: ts-node/register\nspec: 'tests/**/*.test.ts'\ntimeout: 5000\n`,
    },
    base + 4 * MINUTE,
  );
  turns.push(t6.turn);

  // Turn 7: Tool result
  turns.push(
    userToolResult(t6.id, "File written: .mocharc.yml", base + 4.5 * MINUTE),
  );

  // Turn 8: Assistant writes a sample test
  const t8 = assistantToolUse(
    "write",
    {
      path: "tests/example.test.ts",
      content: `import { expect } from 'chai';

describe('Example', () => {
  it('should add numbers correctly', () => {
    expect(1 + 1).to.equal(2);
  });

  it('should handle string concatenation', () => {
    expect('hello' + ' ' + 'world').to.equal('hello world');
  });
});
`,
    },
    base + 5 * MINUTE,
  );
  turns.push(t8.turn);

  // Turn 9: Tool result
  turns.push(
    userToolResult(
      t8.id,
      "File written: tests/example.test.ts",
      base + 5.5 * MINUTE,
    ),
  );

  // Turn 10: Run tests
  const t10 = assistantToolUse(
    "bash",
    { command: "npx mocha" },
    base + 6 * MINUTE,
  );
  turns.push(t10.turn);

  // Turn 11: Tool result
  turns.push(
    userToolResult(
      t10.id,
      "  Example\n    ✓ should add numbers correctly\n    ✓ should handle string concatenation\n\n  2 passing (45ms)",
      base + 6.5 * MINUTE,
    ),
  );

  // Turn 12: User is satisfied
  turns.push(
    userText(
      "Great, Mocha is working. Let's keep building out the test suite from here.",
      base + 7 * MINUTE,
    ),
  );

  return turns;
})();

const pr3Session2Turns: ConversationTurn[] = (() => {
  const base = T0 + 5 * DAY; // 5 days later
  const turns: ConversationTurn[] = [];

  // Turn 1: User brings up testing again with a change of mind
  turns.push(
    userText(
      "Hey, I've been thinking about our test setup. The Mocha + Chai + ts-node combination is getting slow as the test suite grows. Takes almost 30 seconds to start up.",
      base,
    ),
  );

  // Turn 2: Assistant acknowledges
  turns.push(
    assistantText(
      "Yes, the ts-node transpilation step adds startup overhead. For larger suites that can become painful. Would you like to explore some alternatives, or try to optimize the current setup?",
      base + 1 * MINUTE,
    ),
  );

  // Turn 3: User decides to switch to Vitest (PREFERENCE EVOLUTION with rationale)
  turns.push(
    userText(
      "Actually, let's switch to Vitest — it's faster because it uses Vite's transform pipeline instead of ts-node, and it has a Jest-compatible API so migration should be straightforward. I've been reading good things about it.",
      base + 2 * MINUTE,
    ),
  );

  // Turn 4: Assistant starts migration
  const t4 = assistantToolUse(
    "bash",
    { command: "pnpm remove mocha chai @types/mocha @types/chai ts-node && pnpm add -D vitest" },
    base + 3 * MINUTE,
  );
  turns.push(t4.turn);

  // Turn 5: Tool result
  turns.push(
    userToolResult(
      t4.id,
      "Packages: -5 +1\nProgress: resolved 8, reused 7, downloaded 1, added 1, done",
      base + 3.5 * MINUTE,
    ),
  );

  // Turn 6: Assistant creates vitest config
  const t6 = assistantToolUse(
    "write",
    {
      path: "vitest.config.ts",
      content: `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    testTimeout: 5000,
  },
});
`,
    },
    base + 4 * MINUTE,
  );
  turns.push(t6.turn);

  // Turn 7: Tool result
  turns.push(
    userToolResult(t6.id, "File written: vitest.config.ts", base + 4.5 * MINUTE),
  );

  // Turn 8: Assistant migrates the test file
  const t8 = assistantToolUse(
    "write",
    {
      path: "tests/example.test.ts",
      content: `import { describe, it, expect } from 'vitest';

describe('Example', () => {
  it('should add numbers correctly', () => {
    expect(1 + 1).toBe(2);
  });

  it('should handle string concatenation', () => {
    expect('hello' + ' ' + 'world').toBe('hello world');
  });
});
`,
    },
    base + 5 * MINUTE,
  );
  turns.push(t8.turn);

  // Turn 9: Tool result
  turns.push(
    userToolResult(
      t8.id,
      "File written: tests/example.test.ts",
      base + 5.5 * MINUTE,
    ),
  );

  // Turn 10: Run with vitest
  const t10 = assistantToolUse(
    "bash",
    { command: "npx vitest run" },
    base + 6 * MINUTE,
  );
  turns.push(t10.turn);

  // Turn 11: Tool result — much faster
  turns.push(
    userToolResult(
      t10.id,
      " ✓ tests/example.test.ts (2)\n   ✓ Example > should add numbers correctly\n   ✓ Example > should handle string concatenation\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Start at  14:22:01\n   Duration  312ms",
      base + 6.5 * MINUTE,
    ),
  );

  // Turn 12: User confirms satisfaction with the switch
  turns.push(
    userText(
      "312ms vs 30 seconds — that's a huge improvement. Let's use Vitest going forward and migrate the rest of the tests.",
      base + 7 * MINUTE,
    ),
  );

  return turns;
})();

const pr3Session3Turns: ConversationTurn[] = (() => {
  const base = T0 + 6 * DAY; // next day
  const turns: ConversationTurn[] = [];

  // Turn 1: User asks about adding a new test
  turns.push(
    userText(
      "I need to add integration tests for the authentication module. Can you set that up?",
      base,
    ),
  );

  // Turn 2: Assistant sets up test (should use Vitest, not Mocha)
  turns.push(
    assistantText(
      "I'll create the integration test file using Vitest. We'll need a test database and some setup/teardown hooks:\n\n```typescript\nimport { describe, it, expect, beforeAll, afterAll } from 'vitest';\n```\n\nShall I proceed with the full test file?",
      base + 1 * MINUTE,
    ),
  );

  // Turn 3: User confirms
  turns.push(
    userText("Yes, go ahead.", base + 2 * MINUTE),
  );

  // Turn 4: Assistant writes the test
  const t4 = assistantToolUse(
    "write",
    {
      path: "tests/auth.integration.test.ts",
      content: `import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDB, destroyTestDB } from './helpers/db';
import { AuthService } from '../src/services/auth';

describe('Auth Integration', () => {
  let db: Awaited<ReturnType<typeof createTestDB>>;
  let authService: AuthService;

  beforeAll(async () => {
    db = await createTestDB();
    authService = new AuthService(db.pool);
  });

  afterAll(async () => {
    await destroyTestDB(db);
  });

  it('registers a new user', async () => {
    const user = await authService.register('test@example.com', 'password123');
    expect(user.email).toBe('test@example.com');
    expect(user.id).toBeDefined();
  });

  it('authenticates with correct credentials', async () => {
    const token = await authService.login('test@example.com', 'password123');
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
  });

  it('rejects invalid credentials', async () => {
    await expect(
      authService.login('test@example.com', 'wrong-password')
    ).rejects.toThrow('Invalid credentials');
  });
});
`,
    },
    base + 4 * MINUTE,
  );
  turns.push(t4.turn);

  // Turn 5: Tool result
  turns.push(
    userToolResult(
      t4.id,
      "File written: tests/auth.integration.test.ts",
      base + 4.5 * MINUTE,
    ),
  );

  // Turn 6: User is happy
  turns.push(
    userText(
      "Looks good. Run the tests.",
      base + 5 * MINUTE,
    ),
  );

  // Turn 7: Assistant runs vitest
  const t7 = assistantToolUse(
    "bash",
    { command: "npx vitest run tests/auth.integration.test.ts" },
    base + 6 * MINUTE,
  );
  turns.push(t7.turn);

  // Turn 8: Tool result
  turns.push(
    userToolResult(
      t7.id,
      " ✓ tests/auth.integration.test.ts (3)\n   ✓ Auth Integration > registers a new user\n   ✓ Auth Integration > authenticates with correct credentials\n   ✓ Auth Integration > rejects invalid credentials\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Start at  09:15:33\n   Duration  856ms",
      base + 7 * MINUTE,
    ),
  );

  return turns;
})();

const pr3Session1: SessionTranscript = {
  id: "pr3-session1-mocha",
  label: "PR-3 Session 1: Establish Mocha preference",
  projectPath: "/tmp/eval-project-pr3",
  turns: pr3Session1Turns,
  metadata: {
    totalTokens: 4_000,
    description:
      "User sets up testing with Mocha + Chai, expressing it as their preferred framework.",
  },
};

const pr3Session2: SessionTranscript = {
  id: "pr3-session2-switch",
  label: "PR-3 Session 2: Switch to Vitest",
  projectPath: "/tmp/eval-project-pr3",
  turns: pr3Session2Turns,
  metadata: {
    totalTokens: 4_000,
    description:
      "User switches from Mocha to Vitest citing performance (312ms vs 30s startup). " +
      "Preference explicitly superseded with rationale.",
  },
};

const pr3Session3: SessionTranscript = {
  id: "pr3-session3-test",
  label: "PR-3 Session 3: Test evolved preference",
  projectPath: "/tmp/eval-project-pr3",
  turns: pr3Session3Turns,
  metadata: {
    totalTokens: 3_000,
    description:
      "New coding task — tests whether the assistant uses Vitest (current) not Mocha (stale).",
  },
};

const pr3Questions: EvalQuestion[] = [
  {
    id: "pr3-q1",
    dimension: "preferences",
    scenario: "pr-3-evolution",
    sessionRef: "pr3-session3-test",
    question: "What testing framework does the user currently prefer?",
    referenceAnswer:
      "The user currently prefers Vitest. They initially used Mocha but explicitly switched to Vitest in a later session. The current preference is Vitest, not Mocha.",
    rubric: RUBRICS.preferenceEvolution,
    metadata: {
      difficulty: "medium",
      tags: ["preference-evolution", "testing-framework", "currency"],
    },
  },
  {
    id: "pr3-q2",
    dimension: "preferences",
    scenario: "pr-3-evolution",
    sessionRef: "pr3-session3-test",
    question:
      "Why did the user switch testing frameworks?",
    referenceAnswer:
      "The user switched from Mocha to Vitest because Vitest is faster — it uses Vite's transform pipeline instead of ts-node, which reduced test startup from ~30 seconds to ~312ms. They also noted Vitest has a Jest-compatible API making migration straightforward.",
    rubric: RUBRICS.preferenceEvolution,
    metadata: {
      difficulty: "medium",
      tags: ["preference-evolution", "rationale", "performance"],
    },
  },
  {
    id: "pr3-q3",
    dimension: "preferences",
    scenario: "pr-3-evolution",
    sessionRef: "pr3-session3-test",
    question:
      "What testing framework did the user use before their current preference?",
    referenceAnswer:
      "The user previously used Mocha (with Chai for assertions and ts-node for TypeScript). They explicitly switched away from it to Vitest due to slow startup times.",
    rubric: RUBRICS.preferenceEvolution,
    metadata: {
      difficulty: "easy",
      tags: ["preference-evolution", "historical", "testing-framework"],
    },
  },
  {
    id: "pr3-q4",
    dimension: "preferences",
    scenario: "pr-3-evolution",
    sessionRef: "pr3-session3-test",
    question:
      "If asked to set up tests for a new module, which testing framework and assertion style should be used?",
    referenceAnswer:
      "Use Vitest with its built-in assertions (expect(...).toBe(), expect(...).toBeDefined(), etc.). Do not use Mocha or Chai — the user switched away from those. Import describe/it/expect from 'vitest'.",
    rubric: RUBRICS.preferenceEvolution,
    metadata: {
      difficulty: "hard",
      tags: ["preference-evolution", "application", "current-preference"],
    },
  },
];

// ---------------------------------------------------------------------------
// Exported scenarios
// ---------------------------------------------------------------------------

const APPLICABLE_BASELINES = [
  "lore",
  "lore-memory-only",
  "tail-window",
] as const;

export const scenarios: ScenarioDefinition[] = [
  {
    id: "pr-1-explicit",
    name: "Explicit Preference Statements",
    dimension: "preferences",
    applicableBaselines: [...APPLICABLE_BASELINES],
    sessions: [pr1Session1, pr1Session2],
    questions: pr1Questions,
  },
  {
    id: "pr-2-implicit",
    name: "Implicit Preference Detection",
    dimension: "preferences",
    applicableBaselines: [...APPLICABLE_BASELINES],
    sessions: [pr2Session1, pr2Session2],
    questions: pr2Questions,
  },
  {
    id: "pr-3-evolution",
    name: "Preference Evolution",
    dimension: "preferences",
    applicableBaselines: [...APPLICABLE_BASELINES],
    sessions: [pr3Session1, pr3Session2, pr3Session3],
    questions: pr3Questions,
  },
];
