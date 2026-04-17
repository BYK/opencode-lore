# System Architecture

This document describes the overall system architecture and key design decisions.

## Request Pipeline

Incoming requests flow through authentication, validation, and routing middleware.

The pipeline uses a chain-of-responsibility pattern where each middleware
can short-circuit the request or pass it to the next handler.

## Database Layer

PostgreSQL with connection pooling via PgBouncer.

### Schema Migrations

All migrations are forward-only using a versioned migration system.
Rollbacks are handled by writing compensating migrations, not by
reversing existing ones.

### Query Patterns

Prefer prepared statements over raw SQL. Use the query builder for
complex joins but drop to raw SQL for performance-critical paths.
