/**
 * Dimension 4: Cross-Project Learning scenarios (CP-1, CP-2, CP-3).
 *
 * Tests whether knowledge gained in one project transfers to another:
 *   CP-1 — Gotcha discovered in Project A (Python) surfaces in Project B (TS)
 *   CP-2 — Architecture pattern from Project A informs Project B
 *   CP-3 — User preferences stated in Project A apply in Project B
 *
 * Each scenario uses TWO distinct project paths and session IDs.
 */
import type {
  ScenarioDefinition,
  SessionTranscript,
  EvalQuestion,
  ConversationTurn,
  BaselineMode,
} from "../types";
import { RUBRICS } from "../judge";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const PROJECT_A_PYTHON = "/tmp/eval-project-python-api";
const PROJECT_B_TS = "/tmp/eval-project-ts-cli";

const CROSS_PROJECT_BASELINES: BaselineMode[] = [
  "lore",
  "lore-memory-only",
  "auto-mem0",
];

// ---------------------------------------------------------------------------
// Helper: deterministic tool IDs
// ---------------------------------------------------------------------------

let toolCounter = 0;
function toolId(prefix: string): string {
  return `toolu_cp_${prefix}_${++toolCounter}`;
}

// Reset counter between scenarios so IDs are deterministic across runs
function resetToolIds(): void {
  toolCounter = 0;
}

// ---------------------------------------------------------------------------
// Helper: timestamp generator (minutes apart, realistic coding pace)
// ---------------------------------------------------------------------------

function makeTimestamps(
  startIso: string,
  count: number,
  gapMinutes = 2,
): number[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => start + i * gapMinutes * 60_000);
}

// =========================================================================
// CP-1: Gotcha Transfer
// =========================================================================

function buildCP1(): ScenarioDefinition {
  resetToolIds();

  // --- Session A: Python REST API — discover nested transaction gotcha ---

  const tsA = makeTimestamps("2025-05-12T09:00:00Z", 20);

  const sessionATurns: ConversationTurn[] = [
    // Turn 0 (user): Start working on order creation endpoint
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "I need to implement an order creation endpoint that creates an order and its line items in a single transaction. Let me show you the current models.",
        },
      ],
      tokens: 200,
      timestamp: tsA[0],
    },
    // Turn 1 (assistant): Read models.py
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Let me look at your current SQLAlchemy models to understand the schema.",
        },
        {
          type: "tool_use",
          id: toolId("a1"),
          name: "read",
          input: { path: `${PROJECT_A_PYTHON}/app/models.py` },
        },
      ],
      tokens: 300,
      timestamp: tsA[1],
    },
    // Turn 2 (user): tool result — models.py content
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_a1_1",
          content: `from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime\nfrom sqlalchemy.orm import relationship, Session\nfrom .db import Base\nimport datetime\n\nclass Order(Base):\n    __tablename__ = "orders"\n    id = Column(Integer, primary_key=True)\n    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=False)\n    status = Column(String(50), default="pending")\n    total = Column(Float, default=0.0)\n    created_at = Column(DateTime, default=datetime.datetime.utcnow)\n    line_items = relationship("LineItem", back_populates="order", cascade="all, delete-orphan")\n\nclass LineItem(Base):\n    __tablename__ = "line_items"\n    id = Column(Integer, primary_key=True)\n    order_id = Column(Integer, ForeignKey("orders.id"), nullable=False)\n    product_id = Column(Integer, ForeignKey("products.id"), nullable=False)\n    quantity = Column(Integer, nullable=False)\n    unit_price = Column(Float, nullable=False)\n    order = relationship("Order", back_populates="line_items")\n\nclass Customer(Base):\n    __tablename__ = "customers"\n    id = Column(Integer, primary_key=True)\n    name = Column(String(200), nullable=False)\n    email = Column(String(200), unique=True, nullable=False)`,
        },
      ],
      tokens: 1500,
      timestamp: tsA[2],
    },
    // Turn 3 (assistant): Write initial order creation route
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Good, I see the Order and LineItem models with proper relationships. Let me create the order endpoint with a nested transaction — we'll create the order first, then add line items within a savepoint so we can roll back just the line items if validation fails.",
        },
        {
          type: "tool_use",
          id: toolId("a2"),
          name: "write",
          input: {
            path: `${PROJECT_A_PYTHON}/app/routes/orders.py`,
            content: `from fastapi import APIRouter, Depends, HTTPException\nfrom sqlalchemy.orm import Session\nfrom ..db import get_db\nfrom ..models import Order, LineItem\nfrom pydantic import BaseModel\nfrom typing import List\n\nrouter = APIRouter(prefix="/orders", tags=["orders"])\n\nclass LineItemCreate(BaseModel):\n    product_id: int\n    quantity: int\n    unit_price: float\n\nclass OrderCreate(BaseModel):\n    customer_id: int\n    items: List[LineItemCreate]\n\n@router.post("/", status_code=201)\ndef create_order(payload: OrderCreate, db: Session = Depends(get_db)):\n    order = Order(customer_id=payload.customer_id)\n    db.add(order)\n    db.commit()  # Commit order first to get the ID\n    \n    try:\n        nested = db.begin_nested()  # Savepoint for line items\n        for item in payload.items:\n            line = LineItem(\n                order_id=order.id,\n                product_id=item.product_id,\n                quantity=item.quantity,\n                unit_price=item.unit_price,\n            )\n            db.add(line)\n        db.commit()  # Commit the nested transaction\n    except Exception as e:\n        nested.rollback()\n        raise HTTPException(status_code=400, detail=f"Failed to add items: {e}")\n    \n    order.total = sum(i.quantity * i.unit_price for i in payload.items)\n    db.commit()\n    return {"id": order.id, "status": order.status, "total": order.total}`,
          },
        },
      ],
      tokens: 2000,
      timestamp: tsA[3],
    },
    // Turn 4 (user): run tests
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Let me run the tests to see if this works.",
        },
      ],
      tokens: 100,
      timestamp: tsA[4],
    },
    // Turn 5 (assistant): run pytest
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("a3"),
          name: "bash",
          input: { command: `cd ${PROJECT_A_PYTHON} && python -m pytest tests/test_orders.py -v --tb=short` },
        },
      ],
      tokens: 200,
      timestamp: tsA[5],
    },
    // Turn 6 (user): test failure
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_a3_3",
          content: `tests/test_orders.py::test_create_order_with_items FAILED\n\nFAILED tests/test_orders.py::test_create_order_with_items - sqlalchemy.exc.InvalidRequestError: This session is in 'committed' state; no further SQL can be emitted within this transaction.\n\ntests/test_orders.py::test_create_order_empty_items PASSED\ntests/test_orders.py::test_create_order_invalid_customer PASSED\n\n2 passed, 1 failed`,
          is_error: false,
        },
      ],
      tokens: 800,
      timestamp: tsA[6],
    },
    // Turn 7 (assistant): analyze the error
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "The error `This session is in 'committed' state; no further SQL can be emitted within this transaction` is happening because we call `db.commit()` to persist the order, which ends the transaction. Then `db.begin_nested()` tries to create a savepoint but the session is already in a committed state.\n\nLet me look at the test to understand the exact setup.",
        },
        {
          type: "tool_use",
          id: toolId("a4"),
          name: "read",
          input: { path: `${PROJECT_A_PYTHON}/tests/test_orders.py` },
        },
      ],
      tokens: 600,
      timestamp: tsA[7],
    },
    // Turn 8 (user): test file content
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_a4_4",
          content: `import pytest\nfrom fastapi.testclient import TestClient\nfrom app.main import app\nfrom app.db import get_db, Base, engine\n\nclient = TestClient(app)\n\n@pytest.fixture(autouse=True)\ndef setup_db():\n    Base.metadata.create_all(bind=engine)\n    yield\n    Base.metadata.drop_all(bind=engine)\n\ndef test_create_order_with_items():\n    # Create a customer first\n    # ... (customer creation)\n    response = client.post("/orders/", json={\n        "customer_id": 1,\n        "items": [\n            {"product_id": 1, "quantity": 2, "unit_price": 29.99},\n            {"product_id": 2, "quantity": 1, "unit_price": 49.99}\n        ]\n    })\n    assert response.status_code == 201\n    data = response.json()\n    assert data["total"] == 109.97\n\ndef test_create_order_empty_items():\n    response = client.post("/orders/", json={"customer_id": 1, "items": []})\n    assert response.status_code == 201\n\ndef test_create_order_invalid_customer():\n    response = client.post("/orders/", json={"customer_id": 99999, "items": []})\n    assert response.status_code == 400`,
        },
      ],
      tokens: 1200,
      timestamp: tsA[8],
    },
    // Turn 9 (assistant): deeper investigation — check SQLAlchemy docs
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I see the issue now. After calling `db.commit()` on the order, the session's transaction is finalized. When we then call `db.begin_nested()`, SQLAlchemy raises an error because the session isn't in an active transaction state.\n\nLet me check the SQLAlchemy documentation on nested transactions.",
        },
        {
          type: "tool_use",
          id: toolId("a5"),
          name: "bash",
          input: { command: `cd ${PROJECT_A_PYTHON} && python -c "import sqlalchemy; help(sqlalchemy.orm.Session.begin_nested)" 2>&1 | head -30` },
        },
      ],
      tokens: 500,
      timestamp: tsA[9],
    },
    // Turn 10 (user): docs output
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_a5_5",
          content: `Help on method begin_nested in module sqlalchemy.orm.session:\n\nbegin_nested()\n    Begin a nested transaction (SAVEPOINT) and return a transaction handle.\n    \n    The returned object is an instance of NestedTransaction.\n    \n    Nested transactions require that the session is in an active transaction.\n    This is typically achieved by calling begin() first, or by using\n    the session within a with statement.\n    \n    NOTE: begin_nested() creates a SAVEPOINT within the current transaction.\n    It does NOT start a new outer transaction. If session.commit() has\n    been called, you must call session.begin() again before begin_nested().`,
        },
      ],
      tokens: 600,
      timestamp: tsA[10],
    },
    // Turn 11 (assistant): KEY GOTCHA DISCOVERY
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Found the root cause! This is a critical SQLAlchemy gotcha:\n\n**SQLAlchemy's `session.commit()` doesn't flush nested transactions — you must call `session.flush()` first.**\n\nThe fix is to use `session.flush()` instead of `session.commit()` when we need the order's auto-generated ID but want to stay within the same transaction. `flush()` sends the SQL to the database (so the ID gets generated) but does NOT end the transaction — the session stays active and we can still use `begin_nested()` for savepoints.\n\nHere's the corrected approach:\n1. `db.add(order)` then `db.flush()` — gets the order ID without committing\n2. Add line items within `begin_nested()` savepoint\n3. Single `db.commit()` at the end to persist everything atomically\n\nThis way the entire order + line items are in one transaction. If anything fails, everything rolls back cleanly.",
        },
      ],
      tokens: 800,
      timestamp: tsA[11],
    },
    // Turn 12 (user): makes sense, fix it
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "That makes sense! I've been bitten by this before in a different project with Django too — the ORM commits are confusing. Please fix the route.",
        },
      ],
      tokens: 200,
      timestamp: tsA[12],
    },
    // Turn 13 (assistant): write the fix
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Exactly — this is a common ORM gotcha that applies across ORMs. The pattern is: use `flush()` to get generated values (IDs, defaults) without ending the transaction, and only `commit()` once at the very end.",
        },
        {
          type: "tool_use",
          id: toolId("a6"),
          name: "write",
          input: {
            path: `${PROJECT_A_PYTHON}/app/routes/orders.py`,
            content: `from fastapi import APIRouter, Depends, HTTPException\nfrom sqlalchemy.orm import Session\nfrom ..db import get_db\nfrom ..models import Order, LineItem\nfrom pydantic import BaseModel\nfrom typing import List\n\nrouter = APIRouter(prefix="/orders", tags=["orders"])\n\nclass LineItemCreate(BaseModel):\n    product_id: int\n    quantity: int\n    unit_price: float\n\nclass OrderCreate(BaseModel):\n    customer_id: int\n    items: List[LineItemCreate]\n\n@router.post("/", status_code=201)\ndef create_order(payload: OrderCreate, db: Session = Depends(get_db)):\n    order = Order(customer_id=payload.customer_id)\n    db.add(order)\n    db.flush()  # Flush to get the order ID without ending the transaction\n    \n    try:\n        nested = db.begin_nested()  # Savepoint for line items\n        for item in payload.items:\n            line = LineItem(\n                order_id=order.id,\n                product_id=item.product_id,\n                quantity=item.quantity,\n                unit_price=item.unit_price,\n            )\n            db.add(line)\n        db.flush()  # Flush line items within the savepoint\n    except Exception as e:\n        nested.rollback()\n        raise HTTPException(status_code=400, detail=f"Failed to add items: {e}")\n    \n    order.total = sum(i.quantity * i.unit_price for i in payload.items)\n    db.commit()  # Single commit at the end — atomic\n    return {"id": order.id, "status": order.status, "total": order.total}`,
          },
        },
      ],
      tokens: 1800,
      timestamp: tsA[13],
    },
    // Turn 14 (user): run tests again
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Let's run the tests again.",
        },
      ],
      tokens: 50,
      timestamp: tsA[14],
    },
    // Turn 15 (assistant): run pytest
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("a7"),
          name: "bash",
          input: { command: `cd ${PROJECT_A_PYTHON} && python -m pytest tests/test_orders.py -v --tb=short` },
        },
      ],
      tokens: 200,
      timestamp: tsA[15],
    },
    // Turn 16 (user): tests pass
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_a7_7",
          content: `tests/test_orders.py::test_create_order_with_items PASSED\ntests/test_orders.py::test_create_order_empty_items PASSED\ntests/test_orders.py::test_create_order_invalid_customer PASSED\n\n3 passed in 1.24s`,
        },
      ],
      tokens: 400,
      timestamp: tsA[16],
    },
    // Turn 17 (assistant): confirm fix
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "All 3 tests pass now. The key takeaway: when working with nested transactions (savepoints) in SQLAlchemy, always use `session.flush()` instead of `session.commit()` to obtain generated values like auto-increment IDs. `commit()` ends the transaction, making `begin_nested()` fail. `flush()` sends SQL to the database but keeps the transaction open.",
        },
      ],
      tokens: 400,
      timestamp: tsA[17],
    },
    // Turn 18 (user): add more tests
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Great. Can you add a test for the rollback case — where one line item has an invalid product_id and the savepoint rolls back but the order stays?",
        },
      ],
      tokens: 200,
      timestamp: tsA[18],
    },
    // Turn 19 (assistant): write rollback test
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Good idea — testing the partial rollback behavior is important to verify the savepoint works correctly.",
        },
        {
          type: "tool_use",
          id: toolId("a8"),
          name: "bash",
          input: {
            command: `cd ${PROJECT_A_PYTHON} && cat >> tests/test_orders.py << 'EOF'\n\ndef test_create_order_partial_rollback():\n    """Line item failure rolls back items but order persists."""\n    response = client.post("/orders/", json={\n        "customer_id": 1,\n        "items": [\n            {"product_id": 1, "quantity": 2, "unit_price": 29.99},\n            {"product_id": -1, "quantity": 1, "unit_price": 49.99}  # invalid\n        ]\n    })\n    assert response.status_code == 400\nEOF`,
          },
        },
      ],
      tokens: 800,
      timestamp: tsA[19],
    },
  ];

  const sessionA: SessionTranscript = {
    id: "cp1-session-a-python-api",
    label: "CP-1 Project A: Python REST API — nested transaction gotcha",
    projectPath: PROJECT_A_PYTHON,
    turns: sessionATurns,
    metadata: {
      totalTokens: 10_350,
      description:
        "Discovers that SQLAlchemy session.commit() ends the transaction, " +
        "preventing begin_nested(). Fix: use session.flush() instead.",
    },
  };

  // --- Session B: TypeScript CLI — encounter nested transaction with Prisma ---

  const tsB = makeTimestamps("2025-05-13T14:00:00Z", 16);

  const sessionBTurns: ConversationTurn[] = [
    // Turn 0 (user): start Prisma work
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "I'm building a CLI tool that imports bulk data into our database. We use Prisma with PostgreSQL. I need to create a parent record and then insert child records, and if any child fails validation, roll back just the children but keep the parent.",
        },
      ],
      tokens: 300,
      timestamp: tsB[0],
    },
    // Turn 1 (assistant): read current schema
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Let me look at your Prisma schema to understand the data model.",
        },
        {
          type: "tool_use",
          id: toolId("b1"),
          name: "read",
          input: { path: `${PROJECT_B_TS}/prisma/schema.prisma` },
        },
      ],
      tokens: 200,
      timestamp: tsB[1],
    },
    // Turn 2 (user): schema content
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b1_9",
          content: `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel Import {\n  id        Int      @id @default(autoincrement())\n  filename  String\n  status    String   @default("pending")\n  createdAt DateTime @default(now())\n  rows      ImportRow[]\n}\n\nmodel ImportRow {\n  id        Int     @id @default(autoincrement())\n  importId  Int\n  data      Json\n  valid     Boolean @default(true)\n  error     String?\n  import    Import  @relation(fields: [importId], references: [id])\n}`,
        },
      ],
      tokens: 800,
      timestamp: tsB[2],
    },
    // Turn 3 (assistant): read existing import command
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I see — `Import` is the parent and `ImportRow` is the child. Let me check the existing import command.",
        },
        {
          type: "tool_use",
          id: toolId("b2"),
          name: "read",
          input: { path: `${PROJECT_B_TS}/src/commands/import.ts` },
        },
      ],
      tokens: 300,
      timestamp: tsB[3],
    },
    // Turn 4 (user): existing import command
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b2_10",
          content: `import { PrismaClient } from "@prisma/client";\nimport { readFileSync } from "fs";\nimport { parse } from "csv-parse/sync";\n\nconst prisma = new PrismaClient();\n\nexport async function importCommand(filePath: string): Promise<void> {\n  const csv = readFileSync(filePath, "utf-8");\n  const rows = parse(csv, { columns: true });\n  \n  // TODO: implement transactional import\n  // Need: create Import, then insert rows with validation\n  // If some rows fail, we want to keep the Import record\n  // but mark it as "partial"\n  \n  console.log(\`Parsed \${rows.length} rows from \${filePath}\`);\n}`,
        },
      ],
      tokens: 800,
      timestamp: tsB[4],
    },
    // Turn 5 (assistant): implement with nested transaction
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'll implement this using Prisma's interactive transactions with nested savepoints. We need to:\n1. Create the Import record and get its ID\n2. Inside a savepoint, insert the rows with validation\n3. If rows fail, roll back the savepoint but keep the Import\n\nHere's the implementation:",
        },
        {
          type: "tool_use",
          id: toolId("b3"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/src/commands/import.ts`,
            content: `import { PrismaClient, Prisma } from "@prisma/client";\nimport { readFileSync } from "fs";\nimport { parse } from "csv-parse/sync";\n\nconst prisma = new PrismaClient();\n\ninterface RowData {\n  [key: string]: string;\n}\n\nfunction validateRow(row: RowData): string | null {\n  if (!row.name || row.name.trim() === "") return "name is required";\n  if (!row.email || !row.email.includes("@")) return "invalid email";\n  return null;\n}\n\nexport async function importCommand(filePath: string): Promise<void> {\n  const csv = readFileSync(filePath, "utf-8");\n  const rows: RowData[] = parse(csv, { columns: true });\n  console.log(\`Parsed \${rows.length} rows from \${filePath}\`);\n\n  const result = await prisma.$transaction(async (tx) => {\n    // Create the parent Import record\n    const importRecord = await tx.import.create({\n      data: { filename: filePath, status: "processing" },\n    });\n\n    let validCount = 0;\n    let errorCount = 0;\n\n    for (const row of rows) {\n      const error = validateRow(row);\n      await tx.importRow.create({\n        data: {\n          importId: importRecord.id,\n          data: row as Prisma.JsonObject,\n          valid: error === null,\n          error,\n        },\n      });\n      if (error) errorCount++;\n      else validCount++;\n    }\n\n    // Update status based on results\n    const status = errorCount === 0 ? "complete" : errorCount === rows.length ? "failed" : "partial";\n    await tx.import.update({\n      where: { id: importRecord.id },\n      data: { status },\n    });\n\n    return { id: importRecord.id, status, validCount, errorCount };\n  });\n\n  console.log(\`Import #\${result.id}: \${result.status} (\${result.validCount} valid, \${result.errorCount} errors)\`);\n}`,
          },
        },
      ],
      tokens: 2000,
      timestamp: tsB[5],
    },
    // Turn 6 (user): test it
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "But wait — I don't want the entire import to roll back if one batch of rows fails. I want to use savepoints so I can commit the Import record and valid rows even if some rows cause database errors. Right now if `importRow.create` throws (e.g., constraint violation), the whole `$transaction` rolls back including the Import record.",
        },
      ],
      tokens: 400,
      timestamp: tsB[6],
    },
    // Turn 7 (assistant): discuss nested transaction pattern
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "You're right — this is the nested transaction / savepoint pattern. In Prisma, you can use nested `$transaction` calls or the `$executeRaw` approach with SAVEPOINTs. However, there's an important gotcha I've encountered before with ORMs and nested transactions.\n\nIn SQLAlchemy (a Python ORM), I learned that calling `commit()` before starting a nested transaction (savepoint) breaks the session state — you need to use `flush()` instead of `commit()` to get generated IDs without ending the transaction. The same principle applies here with Prisma.\n\nWith Prisma's interactive transactions, the outer `$transaction` callback manages the transaction lifecycle. You should NOT manually commit within it. Instead, the pattern is:\n1. Create the Import record inside the transaction (Prisma auto-flushes)\n2. Use a try/catch per row to handle individual failures\n3. The auto-generated ID is available immediately after `create()` — Prisma flushes the INSERT\n4. Let the outer transaction commit everything at the end\n\nFor true savepoint semantics, you'd use raw SQL `SAVEPOINT`/`RELEASE SAVEPOINT`/`ROLLBACK TO SAVEPOINT` within the interactive transaction.",
        },
      ],
      tokens: 1000,
      timestamp: tsB[7],
    },
    // Turn 8 (user): update the implementation
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "That's really helpful! So the flush vs commit distinction applies to Prisma too in a way — you shouldn't try to commit mid-transaction. Let me update the code to handle per-row errors with try/catch and use raw savepoints for the batch.",
        },
      ],
      tokens: 200,
      timestamp: tsB[8],
    },
    // Turn 9 (assistant): write updated implementation
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Exactly. The core principle is the same across ORMs: don't commit mid-transaction when you need nested transactions. Here's the updated implementation with per-row error handling:",
        },
        {
          type: "tool_use",
          id: toolId("b4"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/src/commands/import.ts`,
            content: `import { PrismaClient, Prisma } from "@prisma/client";\nimport { readFileSync } from "fs";\nimport { parse } from "csv-parse/sync";\n\nconst prisma = new PrismaClient();\n\ninterface RowData { [key: string]: string }\n\nfunction validateRow(row: RowData): string | null {\n  if (!row.name?.trim()) return "name is required";\n  if (!row.email?.includes("@")) return "invalid email";\n  return null;\n}\n\nexport async function importCommand(filePath: string): Promise<void> {\n  const csv = readFileSync(filePath, "utf-8");\n  const rows: RowData[] = parse(csv, { columns: true });\n\n  const result = await prisma.$transaction(async (tx) => {\n    const importRecord = await tx.import.create({\n      data: { filename: filePath, status: "processing" },\n    });\n    // ID is available immediately — Prisma flushes the INSERT\n\n    let validCount = 0;\n    let errorCount = 0;\n\n    // Use a savepoint per row for granular rollback\n    for (const row of rows) {\n      const validationError = validateRow(row);\n      if (validationError) {\n        await tx.importRow.create({\n          data: { importId: importRecord.id, data: row as Prisma.JsonObject, valid: false, error: validationError },\n        });\n        errorCount++;\n        continue;\n      }\n\n      try {\n        await tx.$executeRaw\`SAVEPOINT row_sp\`;\n        await tx.importRow.create({\n          data: { importId: importRecord.id, data: row as Prisma.JsonObject, valid: true },\n        });\n        await tx.$executeRaw\`RELEASE SAVEPOINT row_sp\`;\n        validCount++;\n      } catch (e) {\n        await tx.$executeRaw\`ROLLBACK TO SAVEPOINT row_sp\`;\n        await tx.importRow.create({\n          data: { importId: importRecord.id, data: row as Prisma.JsonObject, valid: false, error: String(e) },\n        });\n        errorCount++;\n      }\n    }\n\n    const status = errorCount === 0 ? "complete" : errorCount === rows.length ? "failed" : "partial";\n    await tx.import.update({ where: { id: importRecord.id }, data: { status } });\n    return { id: importRecord.id, status, validCount, errorCount };\n  });\n\n  console.log(\`Import #\${result.id}: \${result.status} (\${result.validCount} valid, \${result.errorCount} errors)\`);\n}`,
          },
        },
      ],
      tokens: 2500,
      timestamp: tsB[9],
    },
    // Turn 10 (user): run tests
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Nice. Let's write a test for this.",
        },
      ],
      tokens: 50,
      timestamp: tsB[10],
    },
    // Turn 11 (assistant): run tests
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("b5"),
          name: "bash",
          input: { command: `cd ${PROJECT_B_TS} && npx jest tests/import.test.ts --verbose` },
        },
      ],
      tokens: 200,
      timestamp: tsB[11],
    },
    // Turn 12 (user): test results
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b5_13",
          content: `PASS tests/import.test.ts\n  importCommand\n    ✓ imports valid CSV file (124 ms)\n    ✓ handles mixed valid/invalid rows with partial status (89 ms)\n    ✓ marks import as failed when all rows invalid (67 ms)\n    ✓ rolls back individual row on constraint violation (145 ms)\n\nTest Suites: 1 passed, 1 total\nTests:       4 passed, 4 total`,
        },
      ],
      tokens: 500,
      timestamp: tsB[12],
    },
    // Turn 13 (assistant): all pass
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "All 4 tests pass. The savepoint pattern works correctly — individual row failures are isolated without rolling back the entire import transaction. This is the same fundamental pattern as the SQLAlchemy fix: avoid committing mid-transaction, use flush/savepoint semantics to get intermediate results while keeping the transaction open.",
        },
      ],
      tokens: 400,
      timestamp: tsB[13],
    },
    // Turn 14 (user): wrap up
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Excellent. The savepoint approach is clean. Thanks for the heads up about the flush vs commit pattern from the Python project — saved me a lot of debugging time.",
        },
      ],
      tokens: 150,
      timestamp: tsB[14],
    },
    // Turn 15 (assistant): final note
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "You're welcome! It's a common cross-ORM gotcha. The rule of thumb: when you need an auto-generated ID inside a transaction but plan to use savepoints or nested transactions, use the ORM's flush mechanism (SQLAlchemy's `flush()`, Prisma's implicit flush on `create()`) rather than committing. Committing ends the outer transaction and breaks savepoint semantics.",
        },
      ],
      tokens: 400,
      timestamp: tsB[15],
    },
  ];

  const sessionB: SessionTranscript = {
    id: "cp1-session-b-ts-cli",
    label: "CP-1 Project B: TypeScript CLI — Prisma nested transactions",
    projectPath: PROJECT_B_TS,
    turns: sessionBTurns,
    metadata: {
      totalTokens: 9_700,
      description:
        "Encounters nested transaction pattern with Prisma. " +
        "Tests whether the SQLAlchemy gotcha from Project A transfers.",
    },
  };

  // --- Questions ---

  const questions: EvalQuestion[] = [
    {
      id: "cp1-q1",
      dimension: "cross-project",
      scenario: "cp-1-gotcha",
      sessionRef: "cp1-session-b-ts-cli",
      question:
        "Have we encountered nested transaction issues in any project before? " +
        "What was the specific problem and which ORM was it with?",
      referenceAnswer:
        "Yes, in the Python REST API project (Project A) using SQLAlchemy. " +
        "The problem was that calling session.commit() to get an auto-generated " +
        "order ID ended the transaction, which then caused begin_nested() to " +
        "fail with 'This session is in committed state; no further SQL can be " +
        "emitted within this transaction'. The fix was to use session.flush() " +
        "instead of session.commit() — flush sends the SQL to get the ID " +
        "without ending the transaction.",
      rubric: RUBRICS.crossProject,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "gotcha", "orm", "nested-transaction"],
      },
    },
    {
      id: "cp1-q2",
      dimension: "cross-project",
      scenario: "cp-1-gotcha",
      sessionRef: "cp1-session-b-ts-cli",
      question:
        "What was the specific fix for the nested transaction problem " +
        "discovered in the Python API project?",
      referenceAnswer:
        "Replace session.commit() with session.flush() after adding the Order " +
        "record. flush() sends the INSERT to the database and populates the " +
        "auto-generated ID, but keeps the transaction open so begin_nested() " +
        "(savepoint) can still be used. A single commit() at the very end " +
        "persists everything atomically.",
      rubric: RUBRICS.crossProject,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "gotcha", "fix", "flush-vs-commit"],
      },
    },
    {
      id: "cp1-q3",
      dimension: "cross-project",
      scenario: "cp-1-gotcha",
      sessionRef: "cp1-session-b-ts-cli",
      question:
        "Which project was the nested transaction gotcha originally " +
        "discovered in, and what was the exact error message?",
      referenceAnswer:
        "The gotcha was discovered in the Python REST API project " +
        "(at /tmp/eval-project-python-api) using SQLAlchemy. The exact " +
        "error message was: \"sqlalchemy.exc.InvalidRequestError: This session " +
        "is in 'committed' state; no further SQL can be emitted within this " +
        "transaction.\"",
      rubric: RUBRICS.crossProject,
      metadata: {
        difficulty: "hard",
        tags: ["cross-project", "gotcha", "attribution", "error-message"],
      },
    },
    {
      id: "cp1-q4",
      dimension: "cross-project",
      scenario: "cp-1-gotcha",
      sessionRef: "cp1-session-b-ts-cli",
      question:
        "How does the nested transaction gotcha from the Python project " +
        "apply to our current Prisma/TypeScript implementation? What's the " +
        "equivalent principle?",
      referenceAnswer:
        "The same principle applies: don't commit mid-transaction when " +
        "you need nested transactions or savepoints. In SQLAlchemy, use " +
        "flush() instead of commit() to get generated IDs. In Prisma's " +
        "interactive transactions, the create() call implicitly flushes " +
        "(the ID is available immediately) and you should NOT try to " +
        "commit within the $transaction callback. For granular rollback, " +
        "use raw SQL SAVEPOINT/ROLLBACK TO SAVEPOINT within the " +
        "interactive transaction.",
      rubric: RUBRICS.crossProject,
      metadata: {
        difficulty: "hard",
        tags: ["cross-project", "gotcha", "analogy", "prisma", "sqlalchemy"],
      },
    },
  ];

  return {
    id: "cp-1-gotcha",
    name: "CP-1: Gotcha Transfer",
    dimension: "cross-project",
    applicableBaselines: CROSS_PROJECT_BASELINES,
    sessions: [sessionA, sessionB],
    questions,
  };
}

// =========================================================================
// CP-2: Architecture Pattern Transfer
// =========================================================================

function buildCP2(): ScenarioDefinition {
  resetToolIds();

  // --- Session A: Python API — establish repository pattern ---

  const tsA = makeTimestamps("2025-05-10T10:00:00Z", 16);

  const sessionATurns: ConversationTurn[] = [
    // Turn 0 (user): discuss database access approach
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "We need to clean up the database access in this Python API. Right now queries are scattered across route handlers. I want a proper pattern. What do you recommend?",
        },
      ],
      tokens: 200,
      timestamp: tsA[0],
    },
    // Turn 1 (assistant): propose repository pattern
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I recommend the **Repository Pattern**. The idea is to create a dedicated class for each entity that encapsulates all database queries. Route handlers call repository methods instead of writing raw queries.\n\nBenefits:\n1. **Testability** — repositories can be mocked in tests without a real database\n2. **Single Responsibility** — routes handle HTTP concerns, repositories handle data access\n3. **Query reuse** — common queries are defined once and reused across endpoints\n4. **Migration safety** — if you change ORMs (e.g., SQLAlchemy to SQLModel), only repositories change\n\nLet me look at the current code to understand the scope.",
        },
        {
          type: "tool_use",
          id: toolId("a1"),
          name: "read",
          input: { path: `${PROJECT_A_PYTHON}/app/routes/users.py` },
        },
      ],
      tokens: 800,
      timestamp: tsA[1],
    },
    // Turn 2 (user): route file with scattered queries
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_a1_1",
          content: `from fastapi import APIRouter, Depends, HTTPException\nfrom sqlalchemy.orm import Session\nfrom ..db import get_db\nfrom ..models import Customer\n\nrouter = APIRouter(prefix="/users", tags=["users"])\n\n@router.get("/")\ndef list_users(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):\n    return db.query(Customer).offset(skip).limit(limit).all()\n\n@router.get("/{user_id}")\ndef get_user(user_id: int, db: Session = Depends(get_db)):\n    user = db.query(Customer).filter(Customer.id == user_id).first()\n    if not user:\n        raise HTTPException(status_code=404, detail="User not found")\n    return user\n\n@router.post("/")\ndef create_user(name: str, email: str, db: Session = Depends(get_db)):\n    existing = db.query(Customer).filter(Customer.email == email).first()\n    if existing:\n        raise HTTPException(status_code=409, detail="Email already exists")\n    user = Customer(name=name, email=email)\n    db.add(user)\n    db.commit()\n    db.refresh(user)\n    return user\n\n@router.delete("/{user_id}")\ndef delete_user(user_id: int, db: Session = Depends(get_db)):\n    user = db.query(Customer).filter(Customer.id == user_id).first()\n    if not user:\n        raise HTTPException(status_code=404, detail="User not found")\n    db.delete(user)\n    db.commit()\n    return {"status": "deleted"}`,
        },
      ],
      tokens: 1500,
      timestamp: tsA[2],
    },
    // Turn 3 (assistant): create base repository
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Good example of scattered queries. Let me create a base repository class and then a UserRepository. The convention will be:\n- `app/repositories/base.py` — generic CRUD base class\n- `app/repositories/user.py` — entity-specific queries\n- Route handlers receive repositories via dependency injection",
        },
        {
          type: "tool_use",
          id: toolId("a2"),
          name: "write",
          input: {
            path: `${PROJECT_A_PYTHON}/app/repositories/base.py`,
            content: `from typing import TypeVar, Generic, Type, List, Optional\nfrom sqlalchemy.orm import Session\nfrom ..db import Base\n\nModelT = TypeVar("ModelT", bound=Base)\n\nclass BaseRepository(Generic[ModelT]):\n    \"\"\"Generic repository with standard CRUD operations.\"\"\"\n\n    def __init__(self, model: Type[ModelT], db: Session):\n        self._model = model\n        self._db = db\n\n    def get_by_id(self, id: int) -> Optional[ModelT]:\n        return self._db.query(self._model).filter(self._model.id == id).first()\n\n    def list(self, skip: int = 0, limit: int = 100) -> List[ModelT]:\n        return self._db.query(self._model).offset(skip).limit(limit).all()\n\n    def create(self, **kwargs) -> ModelT:\n        instance = self._model(**kwargs)\n        self._db.add(instance)\n        self._db.commit()\n        self._db.refresh(instance)\n        return instance\n\n    def delete(self, id: int) -> bool:\n        instance = self.get_by_id(id)\n        if not instance:\n            return False\n        self._db.delete(instance)\n        self._db.commit()\n        return True`,
          },
        },
      ],
      tokens: 1500,
      timestamp: tsA[3],
    },
    // Turn 4 (user): looks good
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "That looks clean. Now the UserRepository with the email-specific queries.",
        },
      ],
      tokens: 100,
      timestamp: tsA[4],
    },
    // Turn 5 (assistant): user repository
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("a3"),
          name: "write",
          input: {
            path: `${PROJECT_A_PYTHON}/app/repositories/user.py`,
            content: `from typing import Optional\nfrom sqlalchemy.orm import Session\nfrom ..models import Customer\nfrom .base import BaseRepository\n\nclass UserRepository(BaseRepository[Customer]):\n    \"\"\"Repository for Customer (user) entities.\"\"\"\n\n    def __init__(self, db: Session):\n        super().__init__(Customer, db)\n\n    def get_by_email(self, email: str) -> Optional[Customer]:\n        return self._db.query(Customer).filter(Customer.email == email).first()\n\n    def email_exists(self, email: str) -> bool:\n        return self.get_by_email(email) is not None\n\n    def search_by_name(self, name_query: str):\n        return self._db.query(Customer).filter(\n            Customer.name.ilike(f"%{name_query}%")\n        ).all()`,
          },
        },
      ],
      tokens: 800,
      timestamp: tsA[5],
    },
    // Turn 6 (user): refactor route
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Now refactor the users route to use the repository.",
        },
      ],
      tokens: 50,
      timestamp: tsA[6],
    },
    // Turn 7 (assistant): refactored route
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("a4"),
          name: "write",
          input: {
            path: `${PROJECT_A_PYTHON}/app/routes/users.py`,
            content: `from fastapi import APIRouter, Depends, HTTPException\nfrom sqlalchemy.orm import Session\nfrom ..db import get_db\nfrom ..repositories.user import UserRepository\n\nrouter = APIRouter(prefix="/users", tags=["users"])\n\ndef get_user_repo(db: Session = Depends(get_db)) -> UserRepository:\n    return UserRepository(db)\n\n@router.get("/")\ndef list_users(skip: int = 0, limit: int = 100, repo: UserRepository = Depends(get_user_repo)):\n    return repo.list(skip=skip, limit=limit)\n\n@router.get("/{user_id}")\ndef get_user(user_id: int, repo: UserRepository = Depends(get_user_repo)):\n    user = repo.get_by_id(user_id)\n    if not user:\n        raise HTTPException(status_code=404, detail="User not found")\n    return user\n\n@router.post("/")\ndef create_user(name: str, email: str, repo: UserRepository = Depends(get_user_repo)):\n    if repo.email_exists(email):\n        raise HTTPException(status_code=409, detail="Email already exists")\n    return repo.create(name=name, email=email)\n\n@router.delete("/{user_id}")\ndef delete_user(user_id: int, repo: UserRepository = Depends(get_user_repo)):\n    if not repo.delete(user_id):\n        raise HTTPException(status_code=404, detail="User not found")\n    return {"status": "deleted"}`,
          },
        },
      ],
      tokens: 1500,
      timestamp: tsA[7],
    },
    // Turn 8 (user): run tests
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Let's make sure everything still works.",
        },
      ],
      tokens: 50,
      timestamp: tsA[8],
    },
    // Turn 9 (assistant): run tests
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("a5"),
          name: "bash",
          input: { command: `cd ${PROJECT_A_PYTHON} && python -m pytest tests/ -v --tb=short` },
        },
      ],
      tokens: 200,
      timestamp: tsA[9],
    },
    // Turn 10 (user): tests pass
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_a5_5",
          content: `tests/test_auth.py::test_login PASSED\ntests/test_auth.py::test_register PASSED\ntests/test_users.py::test_list_users PASSED\ntests/test_users.py::test_get_user PASSED\ntests/test_users.py::test_create_user PASSED\ntests/test_users.py::test_create_user_duplicate_email PASSED\ntests/test_users.py::test_delete_user PASSED\n\n7 passed in 2.31s`,
        },
      ],
      tokens: 500,
      timestamp: tsA[10],
    },
    // Turn 11 (assistant): summarize pattern
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "All 7 tests pass. The refactored code is cleaner — route handlers are now ~5 lines each instead of 10-15, and all database queries are in the repository layer.\n\nHere's a summary of the repository pattern as established:\n\n**Structure**: `app/repositories/` directory with `base.py` (generic CRUD) and entity-specific repos\n**Convention**: Repositories receive a `Session` via constructor, injected by FastAPI's `Depends`\n**Rationale**: Testability (mock repos in unit tests), single responsibility (routes = HTTP, repos = data), query reuse, ORM migration safety\n**Base class**: Generic `BaseRepository[ModelT]` with `get_by_id()`, `list()`, `create()`, `delete()`\n**Entity repos**: Inherit from base, add entity-specific queries (e.g., `get_by_email()`, `search_by_name()`)",
        },
      ],
      tokens: 600,
      timestamp: tsA[11],
    },
    // Turn 12 (user): discuss test mocking
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "What's the best way to mock repositories in tests? I want unit tests that don't need a real database.",
        },
      ],
      tokens: 100,
      timestamp: tsA[12],
    },
    // Turn 13 (assistant): explain mock pattern
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Since repositories are injected via FastAPI's `Depends`, you can override the dependency in tests:\n\n```python\nfrom unittest.mock import MagicMock\nfrom app.repositories.user import UserRepository\n\ndef test_create_user_endpoint():\n    mock_repo = MagicMock(spec=UserRepository)\n    mock_repo.email_exists.return_value = False\n    mock_repo.create.return_value = Customer(id=1, name=\"Test\", email=\"test@example.com\")\n    \n    app.dependency_overrides[get_user_repo] = lambda: mock_repo\n    response = client.post(\"/users/\", json={\"name\": \"Test\", \"email\": \"test@example.com\"})\n    assert response.status_code == 200\n    mock_repo.create.assert_called_once()\n```\n\nThis is a key benefit of the repository pattern — you can test route logic without any database. The repository itself is tested separately with a real (test) database.",
        },
      ],
      tokens: 800,
      timestamp: tsA[13],
    },
    // Turn 14 (user): acknowledge
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "That's a great pattern. Much cleaner than mocking the SQLAlchemy session directly. Let's also create the OrderRepository for consistency.",
        },
      ],
      tokens: 100,
      timestamp: tsA[14],
    },
    // Turn 15 (assistant): create order repository
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("a6"),
          name: "write",
          input: {
            path: `${PROJECT_A_PYTHON}/app/repositories/order.py`,
            content: `from typing import List, Optional\nfrom sqlalchemy.orm import Session\nfrom ..models import Order, LineItem\nfrom .base import BaseRepository\n\nclass OrderRepository(BaseRepository[Order]):\n    \"\"\"Repository for Order entities with line item support.\"\"\"\n\n    def __init__(self, db: Session):\n        super().__init__(Order, db)\n\n    def get_by_customer(self, customer_id: int) -> List[Order]:\n        return self._db.query(Order).filter(\n            Order.customer_id == customer_id\n        ).order_by(Order.created_at.desc()).all()\n\n    def get_with_items(self, order_id: int) -> Optional[Order]:\n        return self._db.query(Order).filter(\n            Order.id == order_id\n        ).first()  # items loaded via relationship\n\n    def get_pending(self) -> List[Order]:\n        return self._db.query(Order).filter(\n            Order.status == "pending"\n        ).all()`,
          },
        },
      ],
      tokens: 1000,
      timestamp: tsA[15],
    },
  ];

  const sessionA: SessionTranscript = {
    id: "cp2-session-a-python-api",
    label: "CP-2 Project A: Python API — establish repository pattern",
    projectPath: PROJECT_A_PYTHON,
    turns: sessionATurns,
    metadata: {
      totalTokens: 9_800,
      description:
        "Establishes the repository pattern for database access: " +
        "generic BaseRepository, entity-specific repos, FastAPI DI, " +
        "mock-friendly testing. Rationale: testability, SRP, query reuse, " +
        "ORM migration safety.",
    },
  };

  // --- Session B: TypeScript CLI — start implementing database access ---

  const tsB = makeTimestamps("2025-05-14T11:00:00Z", 12);

  const sessionBTurns: ConversationTurn[] = [
    // Turn 0 (user): start new project DB layer
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "I'm starting the database layer for this TypeScript CLI tool. We're using Prisma and I want a clean architecture. How should I structure the data access code?",
        },
      ],
      tokens: 200,
      timestamp: tsB[0],
    },
    // Turn 1 (assistant): check current structure
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Let me first look at the current project structure to understand what we're working with.",
        },
        {
          type: "tool_use",
          id: toolId("b1"),
          name: "bash",
          input: { command: `find ${PROJECT_B_TS}/src -type f -name '*.ts' | sort` },
        },
      ],
      tokens: 200,
      timestamp: tsB[1],
    },
    // Turn 2 (user): file listing
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b1_7",
          content: `${PROJECT_B_TS}/src/commands/build.ts\n${PROJECT_B_TS}/src/commands/init.ts\n${PROJECT_B_TS}/src/config.ts\n${PROJECT_B_TS}/src/index.ts\n${PROJECT_B_TS}/src/utils.ts`,
        },
      ],
      tokens: 300,
      timestamp: tsB[2],
    },
    // Turn 3 (assistant): recommend repository pattern
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "For structuring database access, I'd recommend the **repository pattern** — we've used it successfully in other projects. The key ideas are:\n\n1. Create a `src/repositories/` directory\n2. A generic base repository class with standard CRUD methods\n3. Entity-specific repository classes that extend the base\n4. The Prisma client is injected into repositories (makes testing easy)\n\nThe rationale: it separates data access from business logic (single responsibility), makes unit testing easy (you can mock repositories), enables query reuse, and if you ever switch from Prisma to another ORM, only the repository layer changes.\n\nLet me set this up.",
        },
        {
          type: "tool_use",
          id: toolId("b2"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/src/repositories/base.ts`,
            content: `import { PrismaClient } from "@prisma/client";\n\nexport abstract class BaseRepository<T, CreateInput, UpdateInput> {\n  constructor(protected readonly prisma: PrismaClient) {}\n\n  abstract findById(id: number): Promise<T | null>;\n  abstract findMany(options?: { skip?: number; take?: number }): Promise<T[]>;\n  abstract create(data: CreateInput): Promise<T>;\n  abstract update(id: number, data: UpdateInput): Promise<T>;\n  abstract delete(id: number): Promise<boolean>;\n}`,
          },
        },
      ],
      tokens: 1200,
      timestamp: tsB[3],
    },
    // Turn 4 (user): now entity repo
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Good. Now create an ImportRepository based on the Prisma schema we have.",
        },
      ],
      tokens: 100,
      timestamp: tsB[4],
    },
    // Turn 5 (assistant): import repository
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("b3"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/src/repositories/import.ts`,
            content: `import { PrismaClient, Import, Prisma } from "@prisma/client";\nimport { BaseRepository } from "./base";\n\ntype ImportCreateInput = Prisma.ImportCreateInput;\ntype ImportUpdateInput = Prisma.ImportUpdateInput;\n\nexport class ImportRepository extends BaseRepository<Import, ImportCreateInput, ImportUpdateInput> {\n  constructor(prisma: PrismaClient) {\n    super(prisma);\n  }\n\n  async findById(id: number): Promise<Import | null> {\n    return this.prisma.import.findUnique({ where: { id } });\n  }\n\n  async findMany(options?: { skip?: number; take?: number }): Promise<Import[]> {\n    return this.prisma.import.findMany({\n      skip: options?.skip,\n      take: options?.take,\n      orderBy: { createdAt: "desc" },\n    });\n  }\n\n  async create(data: ImportCreateInput): Promise<Import> {\n    return this.prisma.import.create({ data });\n  }\n\n  async update(id: number, data: ImportUpdateInput): Promise<Import> {\n    return this.prisma.import.update({ where: { id }, data });\n  }\n\n  async delete(id: number): Promise<boolean> {\n    try {\n      await this.prisma.import.delete({ where: { id } });\n      return true;\n    } catch {\n      return false;\n    }\n  }\n\n  async findByStatus(status: string): Promise<Import[]> {\n    return this.prisma.import.findMany({\n      where: { status },\n      orderBy: { createdAt: "desc" },\n    });\n  }\n\n  async findWithRows(id: number) {\n    return this.prisma.import.findUnique({\n      where: { id },\n      include: { rows: true },\n    });\n  }\n}`,
          },
        },
      ],
      tokens: 1500,
      timestamp: tsB[5],
    },
    // Turn 6 (user): testing question
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "How do I test this without a real database?",
        },
      ],
      tokens: 50,
      timestamp: tsB[6],
    },
    // Turn 7 (assistant): mock pattern
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Since the PrismaClient is injected via constructor, you can mock it easily:\n\n```typescript\nimport { ImportRepository } from \"./repositories/import\";\n\nconst mockPrisma = {\n  import: {\n    findUnique: jest.fn(),\n    findMany: jest.fn(),\n    create: jest.fn(),\n    update: jest.fn(),\n    delete: jest.fn(),\n  },\n} as unknown as PrismaClient;\n\nconst repo = new ImportRepository(mockPrisma);\n```\n\nThe repository pattern's biggest advantage is exactly this: your business logic tests don't need a database. You mock the repository (or its underlying client) and test logic in isolation. Repository tests use a real test database.",
        },
      ],
      tokens: 600,
      timestamp: tsB[7],
    },
    // Turn 8 (user): write a test
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Can you write a test file for the ImportRepository?",
        },
      ],
      tokens: 50,
      timestamp: tsB[8],
    },
    // Turn 9 (assistant): write test
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("b4"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/tests/repositories/import.test.ts`,
            content: `import { ImportRepository } from "../../src/repositories/import";\nimport type { PrismaClient } from "@prisma/client";\n\nconst mockPrisma = {\n  import: {\n    findUnique: jest.fn(),\n    findMany: jest.fn(),\n    create: jest.fn(),\n    update: jest.fn(),\n    delete: jest.fn(),\n  },\n} as unknown as PrismaClient;\n\ndescribe("ImportRepository", () => {\n  const repo = new ImportRepository(mockPrisma);\n\n  afterEach(() => jest.clearAllMocks());\n\n  it("finds import by id", async () => {\n    const mockImport = { id: 1, filename: "test.csv", status: "complete" };\n    (mockPrisma.import.findUnique as jest.Mock).mockResolvedValue(mockImport);\n    const result = await repo.findById(1);\n    expect(result).toEqual(mockImport);\n  });\n\n  it("creates an import", async () => {\n    const input = { filename: "data.csv" };\n    (mockPrisma.import.create as jest.Mock).mockResolvedValue({ id: 2, ...input, status: "pending" });\n    const result = await repo.create(input);\n    expect(result.id).toBe(2);\n    expect(mockPrisma.import.create).toHaveBeenCalledWith({ data: input });\n  });\n\n  it("returns false when deleting non-existent import", async () => {\n    (mockPrisma.import.delete as jest.Mock).mockRejectedValue(new Error("Not found"));\n    const result = await repo.delete(999);\n    expect(result).toBe(false);\n  });\n});`,
          },
        },
      ],
      tokens: 1200,
      timestamp: tsB[9],
    },
    // Turn 10 (user): run tests
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b4_10",
          content: "File written successfully.",
        },
      ],
      tokens: 50,
      timestamp: tsB[10],
    },
    // Turn 11 (assistant): run tests
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("b5"),
          name: "bash",
          input: { command: `cd ${PROJECT_B_TS} && npx jest tests/repositories/ --verbose` },
        },
      ],
      tokens: 200,
      timestamp: tsB[11],
    },
  ];

  const sessionB: SessionTranscript = {
    id: "cp2-session-b-ts-cli",
    label: "CP-2 Project B: TypeScript CLI — implement repository pattern",
    projectPath: PROJECT_B_TS,
    turns: sessionBTurns,
    metadata: {
      totalTokens: 6_650,
      description:
        "Implements the repository pattern in a new TypeScript project, " +
        "referencing the same architecture established in Project A.",
    },
  };

  // --- Questions ---

  const questions: EvalQuestion[] = [
    {
      id: "cp2-q1",
      dimension: "cross-project",
      scenario: "cp-2-architecture",
      sessionRef: "cp2-session-b-ts-cli",
      question:
        "What database access pattern have we used in other projects, " +
        "and what is the directory/file structure convention?",
      referenceAnswer:
        "We use the Repository Pattern. The convention is a `repositories/` " +
        "directory containing a `base` module with a generic BaseRepository " +
        "class (standard CRUD: get_by_id, list, create, delete) and " +
        "entity-specific repository classes that extend the base (e.g., " +
        "UserRepository, OrderRepository). This was established in the " +
        "Python REST API project under `app/repositories/`.",
      rubric: RUBRICS.crossProject,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "architecture", "repository-pattern"],
      },
    },
    {
      id: "cp2-q2",
      dimension: "cross-project",
      scenario: "cp-2-architecture",
      sessionRef: "cp2-session-b-ts-cli",
      question:
        "What was the rationale for adopting the repository pattern " +
        "in the original project? List the specific reasons.",
      referenceAnswer:
        "Four reasons: (1) Testability — repositories can be mocked " +
        "in tests without a real database, (2) Single Responsibility — " +
        "routes handle HTTP concerns, repositories handle data access, " +
        "(3) Query reuse — common queries defined once and reused across " +
        "endpoints, (4) Migration safety — if the ORM changes, only " +
        "repositories need updating.",
      rubric: RUBRICS.crossProject,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "architecture", "rationale", "design-decision"],
      },
    },
    {
      id: "cp2-q3",
      dimension: "cross-project",
      scenario: "cp-2-architecture",
      sessionRef: "cp2-session-b-ts-cli",
      question:
        "How is the repository pattern tested in the original Python " +
        "project? What's the mocking approach?",
      referenceAnswer:
        "Repositories are injected via FastAPI's Depends system. In tests, " +
        "you override the dependency: `app.dependency_overrides[get_user_repo] " +
        "= lambda: mock_repo`. The mock is created with " +
        "`MagicMock(spec=UserRepository)` and individual methods are stubbed. " +
        "This allows testing route logic without any database connection. " +
        "The repository itself is tested separately with a real test database.",
      rubric: RUBRICS.crossProject,
      metadata: {
        difficulty: "hard",
        tags: ["cross-project", "architecture", "testing", "mocking"],
      },
    },
    {
      id: "cp2-q4",
      dimension: "cross-project",
      scenario: "cp-2-architecture",
      sessionRef: "cp2-session-b-ts-cli",
      question:
        "What methods does the generic base repository provide, and how " +
        "does an entity-specific repository extend it?",
      referenceAnswer:
        "The base repository (BaseRepository[ModelT]) provides: get_by_id(), " +
        "list() with skip/limit, create(), and delete(). Entity repositories " +
        "inherit from it and add domain-specific queries — e.g., " +
        "UserRepository adds get_by_email(), email_exists(), and " +
        "search_by_name(). The ORM session is passed via constructor " +
        "and stored as self._db.",
      rubric: RUBRICS.crossProject,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "architecture", "base-class", "inheritance"],
      },
    },
  ];

  return {
    id: "cp-2-architecture",
    name: "CP-2: Architecture Pattern Transfer",
    dimension: "cross-project",
    applicableBaselines: CROSS_PROJECT_BASELINES,
    sessions: [sessionA, sessionB],
    questions,
  };
}

// =========================================================================
// CP-3: Cross-Project Preference Consistency
// =========================================================================

function buildCP3(): ScenarioDefinition {
  resetToolIds();

  // --- Session A: Python API — state preferences ---

  const tsA = makeTimestamps("2025-05-08T09:00:00Z", 16);

  const sessionATurns: ConversationTurn[] = [
    // Turn 0 (user): start working on a feature
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Let's set up the linting and formatting for this project. I have strong opinions here.",
        },
      ],
      tokens: 100,
      timestamp: tsA[0],
    },
    // Turn 1 (assistant): suggest setup
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Sure! What tools and conventions would you like to use? Do you have a preference for linters, formatters, and coding style?",
        },
      ],
      tokens: 100,
      timestamp: tsA[1],
    },
    // Turn 2 (user): preference 1 — TypeScript strict
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "First off — whenever we write TypeScript in any project, always use strict mode. I mean `\"strict\": true` in tsconfig, and absolutely no `any` types. Use `unknown` and type guards if the type isn't known. This is non-negotiable.",
        },
      ],
      tokens: 200,
      timestamp: tsA[2],
    },
    // Turn 3 (assistant): acknowledge strict TS
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Understood — strict TypeScript with no `any` types, always. I'll use `unknown` with type guards when the type can't be determined statically. This applies across all projects.",
        },
      ],
      tokens: 100,
      timestamp: tsA[3],
    },
    // Turn 4 (user): preference 2 — pnpm
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "For package management, always use pnpm. Not npm, not yarn. pnpm is faster and handles the node_modules better with hard links. Every project should have a `.npmrc` with `engine-strict=true`.",
        },
      ],
      tokens: 150,
      timestamp: tsA[4],
    },
    // Turn 5 (assistant): ack pnpm
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Got it — pnpm exclusively, with `engine-strict=true` in `.npmrc`. I'll always use `pnpm add` instead of `npm install` or `yarn add`.",
        },
        {
          type: "tool_use",
          id: toolId("a1"),
          name: "bash",
          input: { command: `cd ${PROJECT_A_PYTHON} && echo "engine-strict=true" > .npmrc` },
        },
      ],
      tokens: 200,
      timestamp: tsA[5],
    },
    // Turn 6 (user): tool result + preference 3 — named exports
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_a1_1",
          content: "",
        },
        {
          type: "text",
          text: "Good. Another thing — always use named exports, never default exports. Default exports make refactoring harder and IDE auto-imports inconsistent. Every module should use `export function`, `export const`, `export class`, etc.",
        },
      ],
      tokens: 200,
      timestamp: tsA[6],
    },
    // Turn 7 (assistant): ack named exports
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Named exports only, no default exports. I agree — it's much better for tree-shaking and IDE support. I'll make sure every module uses explicit named exports.",
        },
      ],
      tokens: 100,
      timestamp: tsA[7],
    },
    // Turn 8 (user): preference 4 — kebab-case files
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "For file naming: always kebab-case. So `user-repository.ts`, not `UserRepository.ts` or `userRepository.ts`. Same for directories. This keeps things consistent across OSes since some are case-insensitive.",
        },
      ],
      tokens: 150,
      timestamp: tsA[8],
    },
    // Turn 9 (assistant): ack kebab-case
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Kebab-case for all file and directory names — makes sense for cross-platform consistency. So `user-repository.ts`, `auth-middleware.ts`, `api-client/`, etc.",
        },
      ],
      tokens: 100,
      timestamp: tsA[9],
    },
    // Turn 10 (user): preference 5 — never push to main
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "One more critical rule: never push directly to main or master. Always create a feature branch and open a PR. No exceptions. Even for single-line fixes.",
        },
      ],
      tokens: 100,
      timestamp: tsA[10],
    },
    // Turn 11 (assistant): ack branching policy
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Absolutely — always branch and PR, never push directly to main/master. Even for hotfixes.",
        },
      ],
      tokens: 50,
      timestamp: tsA[11],
    },
    // Turn 12 (user): preference 6 — error handling
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "For error handling, I want user-friendly error messages in APIs. Never return raw stack traces to the client. Log the full error server-side but return a clean message with an error code. Something like `{ error: { code: \"VALIDATION_ERROR\", message: \"Email is already registered\" } }`.",
        },
      ],
      tokens: 200,
      timestamp: tsA[12],
    },
    // Turn 13 (assistant): ack error handling
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Clear — user-friendly error responses with structured `{ error: { code, message } }` format, never raw stack traces. Full errors logged server-side only. I'll use this pattern in all API endpoints.",
        },
      ],
      tokens: 100,
      timestamp: tsA[13],
    },
    // Turn 14 (user): preference 7 — tests before commit
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Also, always run tests before committing. I don't care if it's a docs change — run the test suite. If tests fail, don't commit. Simple rule.",
        },
      ],
      tokens: 100,
      timestamp: tsA[14],
    },
    // Turn 15 (assistant): ack tests before commit
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Tests before every commit, no exceptions. I'll always run the full test suite before creating any commit, regardless of the change scope.\n\nTo summarize all the conventions we've established:\n1. **TypeScript strict mode** — `strict: true`, no `any`, use `unknown` + type guards\n2. **pnpm** — exclusively, with `engine-strict=true`\n3. **Named exports only** — no default exports\n4. **Kebab-case** file and directory names\n5. **Branch + PR workflow** — never push to main/master\n6. **Structured error responses** — `{ error: { code, message } }`, no stack traces\n7. **Tests before every commit**",
        },
      ],
      tokens: 400,
      timestamp: tsA[15],
    },
  ];

  const sessionA: SessionTranscript = {
    id: "cp3-session-a-python-api",
    label: "CP-3 Project A: Establish preferences (coding conventions)",
    projectPath: PROJECT_A_PYTHON,
    turns: sessionATurns,
    metadata: {
      totalTokens: 2_350,
      description:
        "Establishes 7 cross-project preferences: strict TS, pnpm, " +
        "named exports, kebab-case files, branch+PR workflow, " +
        "structured error responses, tests before commit.",
    },
  };

  // --- Session B: TypeScript CLI — test preference transfer ---

  const tsB = makeTimestamps("2025-05-15T10:00:00Z", 12);

  const sessionBTurns: ConversationTurn[] = [
    // Turn 0 (user): start new project
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "I'm starting fresh on this CLI project. Can you set up the initial TypeScript configuration?",
        },
      ],
      tokens: 100,
      timestamp: tsB[0],
    },
    // Turn 1 (assistant): create tsconfig
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'll set up the TypeScript configuration with strict mode enabled — no `any` types allowed.",
        },
        {
          type: "tool_use",
          id: toolId("b1"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/tsconfig.json`,
            content: `{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "Node16",\n    "moduleResolution": "Node16",\n    "strict": true,\n    "noUncheckedIndexedAccess": true,\n    "noUnusedLocals": true,\n    "noUnusedParameters": true,\n    "outDir": "dist",\n    "rootDir": "src",\n    "declaration": true,\n    "esModuleInterop": true,\n    "skipLibCheck": true\n  },\n  "include": ["src/**/*"],\n  "exclude": ["node_modules", "dist"]\n}`,
          },
        },
      ],
      tokens: 600,
      timestamp: tsB[1],
    },
    // Turn 2 (user): install dependencies
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b1_2",
          content: "File written successfully.",
        },
        {
          type: "text",
          text: "Now install the basic dependencies we need — commander for CLI parsing and zod for validation.",
        },
      ],
      tokens: 150,
      timestamp: tsB[2],
    },
    // Turn 3 (assistant): use pnpm
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("b2"),
          name: "bash",
          input: { command: `cd ${PROJECT_B_TS} && pnpm add commander zod && pnpm add -D typescript @types/node` },
        },
      ],
      tokens: 200,
      timestamp: tsB[3],
    },
    // Turn 4 (user): installed
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b2_3",
          content: `Packages: +4\n++++\nProgress: resolved 4, reused 4, downloaded 0, added 4, done`,
        },
      ],
      tokens: 200,
      timestamp: tsB[4],
    },
    // Turn 5 (assistant): create config module with named exports
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Now let me create the config module. I'll use named exports and kebab-case for the filename:",
        },
        {
          type: "tool_use",
          id: toolId("b3"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/src/cli-config.ts`,
            content: `import { z } from "zod";\nimport { readFileSync, existsSync } from "node:fs";\nimport { resolve } from "node:path";\n\nconst configSchema = z.object({\n  outputDir: z.string().default("dist"),\n  verbose: z.boolean().default(false),\n  maxRetries: z.number().int().min(0).max(10).default(3),\n});\n\nexport type CliConfig = z.infer<typeof configSchema>;\n\nexport function loadConfig(configPath?: string): CliConfig {\n  const path = configPath ?? resolve(process.cwd(), "cli.config.json");\n  if (!existsSync(path)) {\n    return configSchema.parse({});\n  }\n\n  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));\n  return configSchema.parse(raw);\n}\n\nexport function validateConfig(raw: unknown): CliConfig {\n  return configSchema.parse(raw);\n}`,
          },
        },
      ],
      tokens: 800,
      timestamp: tsB[5],
    },
    // Turn 6 (user): write a command
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b3_4",
          content: "File written successfully.",
        },
        {
          type: "text",
          text: "Good. Now create a 'build' command that compiles the project.",
        },
      ],
      tokens: 100,
      timestamp: tsB[6],
    },
    // Turn 7 (assistant): build command with error handling
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("b4"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/src/commands/build.ts`,
            content: `import { execSync } from "node:child_process";\nimport type { CliConfig } from "../cli-config";\n\nexport interface BuildResult {\n  success: boolean;\n  outputDir: string;\n  filesCompiled: number;\n}\n\nexport interface BuildError {\n  error: {\n    code: string;\n    message: string;\n  };\n}\n\nexport function buildCommand(config: CliConfig): BuildResult | BuildError {\n  try {\n    const output = execSync("npx tsc --noEmit", {\n      encoding: "utf-8",\n      stdio: "pipe",\n    });\n\n    return {\n      success: true,\n      outputDir: config.outputDir,\n      filesCompiled: (output.match(/\\n/g) ?? []).length,\n    };\n  } catch (err: unknown) {\n    // Log full error server-side\n    console.error("[build] Full error:", err);\n\n    // Return user-friendly structured error\n    const message =\n      err instanceof Error ? err.message.split("\\n")[0] : "Unknown build error";\n    return {\n      error: {\n        code: "BUILD_FAILED",\n        message,\n      },\n    };\n  }\n}`,
          },
        },
      ],
      tokens: 1000,
      timestamp: tsB[7],
    },
    // Turn 8 (user): write tests
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b4_5",
          content: "File written successfully.",
        },
        {
          type: "text",
          text: "Write tests for the config and build modules.",
        },
      ],
      tokens: 100,
      timestamp: tsB[8],
    },
    // Turn 9 (assistant): write tests
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId("b5"),
          name: "write",
          input: {
            path: `${PROJECT_B_TS}/tests/cli-config.test.ts`,
            content: `import { describe, it, expect } from "@jest/globals";\nimport { loadConfig, validateConfig } from "../src/cli-config";\n\ndescribe("loadConfig", () => {\n  it("returns defaults when no config file exists", () => {\n    const config = loadConfig("/nonexistent/path.json");\n    expect(config.outputDir).toBe("dist");\n    expect(config.verbose).toBe(false);\n    expect(config.maxRetries).toBe(3);\n  });\n});\n\ndescribe("validateConfig", () => {\n  it("validates a correct config", () => {\n    const config = validateConfig({ outputDir: "build", verbose: true });\n    expect(config.outputDir).toBe("build");\n    expect(config.verbose).toBe(true);\n  });\n\n  it("rejects invalid maxRetries", () => {\n    expect(() => validateConfig({ maxRetries: 999 })).toThrow();\n  });\n});`,
          },
        },
      ],
      tokens: 800,
      timestamp: tsB[9],
    },
    // Turn 10 (user): run tests then commit
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_cp_b5_6",
          content: "File written successfully.",
        },
        {
          type: "text",
          text: "Run the tests and then commit everything.",
        },
      ],
      tokens: 100,
      timestamp: tsB[10],
    },
    // Turn 11 (assistant): run tests then branch + commit
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'll run the tests first (before committing), then create a feature branch for the PR.",
        },
        {
          type: "tool_use",
          id: toolId("b6"),
          name: "bash",
          input: {
            command: `cd ${PROJECT_B_TS} && npx jest --verbose && git checkout -b feat/initial-setup && git add -A && git commit -m "feat: initial project setup with config and build command"`,
          },
        },
      ],
      tokens: 400,
      timestamp: tsB[11],
    },
  ];

  const sessionB: SessionTranscript = {
    id: "cp3-session-b-ts-cli",
    label: "CP-3 Project B: TypeScript CLI — test preference transfer",
    projectPath: PROJECT_B_TS,
    turns: sessionBTurns,
    metadata: {
      totalTokens: 4_550,
      description:
        "New project where the assistant should proactively apply " +
        "preferences established in Project A without being reminded.",
    },
  };

  // --- Questions ---

  const questions: EvalQuestion[] = [
    {
      id: "cp3-q1",
      dimension: "cross-project",
      scenario: "cp-3-preferences",
      sessionRef: "cp3-session-b-ts-cli",
      question:
        "What is the user's preferred package manager, and should it be " +
        "used in this new project even though it wasn't stated here?",
      referenceAnswer:
        "The user's preferred package manager is pnpm (not npm or yarn). " +
        "This preference was established in another project and applies " +
        "globally — the user explicitly said 'always use pnpm' across " +
        "all projects. Every project should also have `.npmrc` with " +
        "`engine-strict=true`.",
      rubric: RUBRICS.crossProjectPreference,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "preference", "pnpm", "package-manager"],
      },
    },
    {
      id: "cp3-q2",
      dimension: "cross-project",
      scenario: "cp-3-preferences",
      sessionRef: "cp3-session-b-ts-cli",
      question:
        "What TypeScript strictness rules apply in this project?",
      referenceAnswer:
        "TypeScript strict mode must be enabled (`\"strict\": true` in " +
        "tsconfig.json). No `any` types are allowed — use `unknown` with " +
        "type guards instead. This is described as 'non-negotiable' by " +
        "the user and applies to all TypeScript projects.",
      rubric: RUBRICS.crossProjectPreference,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "preference", "typescript", "strict-mode"],
      },
    },
    {
      id: "cp3-q3",
      dimension: "cross-project",
      scenario: "cp-3-preferences",
      sessionRef: "cp3-session-b-ts-cli",
      question:
        "What is the user's policy on pushing to the main branch?",
      referenceAnswer:
        "Never push directly to main or master. Always create a feature " +
        "branch and open a PR. No exceptions, even for single-line fixes " +
        "or hotfixes. This applies to all projects.",
      rubric: RUBRICS.crossProjectPreference,
      metadata: {
        difficulty: "easy",
        tags: ["cross-project", "preference", "git-workflow", "branching"],
      },
    },
    {
      id: "cp3-q4",
      dimension: "cross-project",
      scenario: "cp-3-preferences",
      sessionRef: "cp3-session-b-ts-cli",
      question:
        "What file naming convention does the user require?",
      referenceAnswer:
        "Kebab-case for all file and directory names. For example: " +
        "`user-repository.ts`, not `UserRepository.ts` or " +
        "`userRepository.ts`. The rationale is cross-platform consistency " +
        "since some operating systems are case-insensitive.",
      rubric: RUBRICS.crossProjectPreference,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "preference", "naming-convention", "kebab-case"],
      },
    },
    {
      id: "cp3-q5",
      dimension: "cross-project",
      scenario: "cp-3-preferences",
      sessionRef: "cp3-session-b-ts-cli",
      question:
        "What are the user's rules about exports in TypeScript modules?",
      referenceAnswer:
        "Always use named exports, never default exports. Every module " +
        "should use `export function`, `export const`, `export class`, etc. " +
        "The rationale is that default exports make refactoring harder and " +
        "IDE auto-imports inconsistent.",
      rubric: RUBRICS.crossProjectPreference,
      metadata: {
        difficulty: "medium",
        tags: ["cross-project", "preference", "named-exports", "module-style"],
      },
    },
    {
      id: "cp3-q6",
      dimension: "cross-project",
      scenario: "cp-3-preferences",
      sessionRef: "cp3-session-b-ts-cli",
      question:
        "What must happen before every git commit according to the user's " +
        "rules, and how should error responses be structured in APIs?",
      referenceAnswer:
        "Two rules: (1) Always run the full test suite before committing, " +
        "regardless of the change scope (even documentation changes). If " +
        "tests fail, don't commit. (2) Error responses should be " +
        "user-friendly with the format " +
        "`{ error: { code: \"...\", message: \"...\" } }` — never return " +
        "raw stack traces to the client. Full errors are logged server-side " +
        "only.",
      rubric: RUBRICS.crossProjectPreference,
      metadata: {
        difficulty: "hard",
        tags: [
          "cross-project",
          "preference",
          "testing",
          "error-handling",
          "multi-preference",
        ],
      },
    },
  ];

  return {
    id: "cp-3-preferences",
    name: "CP-3: Cross-Project Preference Consistency",
    dimension: "cross-project",
    applicableBaselines: CROSS_PROJECT_BASELINES,
    sessions: [sessionA, sessionB],
    questions,
  };
}

// =========================================================================
// Export
// =========================================================================

export const scenarios: ScenarioDefinition[] = [
  buildCP1(),
  buildCP2(),
  buildCP3(),
];
