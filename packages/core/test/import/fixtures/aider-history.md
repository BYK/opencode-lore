#### user
Can you add error handling to the database module?

#### assistant
I'll add try-catch blocks around the database operations and proper error propagation.

Here are the changes I'll make:

1. Wrap all DB calls in try-catch
2. Add a custom DatabaseError class
3. Log errors before re-throwing

Let me update the files now.

---

#### user
The tests are failing after your changes. The mock database doesn't throw the right error type.

#### assistant
You're right. The mock needs to throw `DatabaseError` instead of a plain `Error`. Let me fix the test fixtures.

The key insight is that our error handling checks `instanceof DatabaseError`, so mocks must use the same class.

---

#### user
Great, all tests pass now. Can you also add retry logic for transient errors?

#### assistant
I'll add an exponential backoff retry wrapper for transient database errors (like SQLITE_BUSY).

The retry logic will:
- Retry up to 3 times
- Use exponential backoff (100ms, 200ms, 400ms)
- Only retry on known transient error codes
- Log each retry attempt

This pattern is important because SQLite BUSY errors are common in concurrent access scenarios.
