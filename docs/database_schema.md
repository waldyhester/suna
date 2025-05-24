# Database Schema (Entity Relationship Diagrams)

This document provides ERD diagrams for the key database tables, illustrating their columns, primary keys, foreign keys, and relationships.

```mermaid
erDiagram
    %% --- basejump schema ---
    "auth.users" {
        UUID id PK "User ID (from Supabase auth)"
        TEXT email "User's email"
        TIMESTAMP created_at "Timestamp of user creation"
    }

    accounts {
        UUID id PK "Account ID"
        UUID primary_owner_user_id FK "FK to auth.users.id"
        BOOLEAN personal_account "True if it's a user's personal account"
        TEXT name "Account name (e.g., team name or user's name for personal account)"
        TEXT slug "URL-friendly slug for the account"
        TIMESTAMP created_at
        JSONB team_members_pending_invitation_count "Cached count, consider if direct ERD representation is needed or as note"
        TEXT avatar_url
        UUID default_model_id "FK to a hypothetical models table (not detailed)"
        TEXT default_model_provider
        TEXT default_model_name
    }

    account_user {
        UUID user_id PK FK "FK to auth.users.id"
        UUID account_id PK FK "FK to accounts.id"
        TEXT account_role "Enum: owner, member (Note: Enum type)"
        TIMESTAMP created_at
    }

    invitations {
        UUID id PK "Invitation ID"
        UUID account_id FK "FK to accounts.id (Team being invited to)"
        UUID invited_by_user_id FK "FK to auth.users.id (User who sent invitation)"
        TEXT email "Email address of the invitee"
        TEXT account_role "Enum: owner, member (Note: Enum type)"
        TEXT token "Secure token for invitation"
        TEXT invitation_type "Enum: one_time, reusable (Note: Enum type)"
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    billing_customers {
        UUID id PK "Billing Customer ID (usually maps to Stripe Customer ID)"
        UUID account_id FK "FK to accounts.id (Account this billing customer belongs to)"
        TEXT stripe_customer_id "Stripe's customer ID"
        BOOLEAN active
        TEXT email
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    billing_subscriptions {
        UUID id PK "Subscription ID (usually maps to Stripe Subscription ID)"
        UUID billing_customer_id FK "FK to billing_customers.id"
        TEXT stripe_subscription_id "Stripe's subscription ID"
        TEXT status "Enum: active, past_due, canceled, etc. (Note: Enum type)"
        TIMESTAMP current_period_start
        TIMESTAMP current_period_end
        JSONB metadata "Any other Stripe subscription metadata"
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    %% --- public schema (AgentPress core) ---
    projects {
        UUID project_id PK "Project ID"
        UUID account_id FK "FK to accounts.id (Owner account)"
        TEXT name "Project name"
        JSONB sandbox "JSONB containing sandbox details (e.g., id, pass, urls)"
        BOOLEAN is_public "Whether the project is publicly accessible"
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    threads {
        UUID thread_id PK "Thread ID"
        UUID project_id FK "FK to projects.project_id"
        UUID account_id FK "FK to accounts.id (Owner account)"
        TEXT name "Thread name (optional, can be auto-generated)"
        BOOLEAN is_public "Whether the thread is publicly accessible"
        JSONB metadata "Other metadata for the thread"
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    messages {
        UUID message_id PK "Message ID"
        UUID thread_id FK "FK to threads.thread_id"
        TEXT type "Message type (e.g., 'user', 'assistant', 'tool', 'status')"
        JSONB content "Content of the message (can be complex JSON for structured messages)"
        JSONB metadata "Additional metadata (e.g., tool call details, stream status)"
        BOOLEAN is_llm_message "True if this message should be part of LLM context"
        TIMESTAMP created_at
        TIMESTAMP updated_at
        TEXT role "Role of the message sender (e.g. 'user', 'assistant', 'tool')"
        TEXT status_type "If type is 'status', this specifies the kind of status"
        TEXT function_name "If a tool call, the function name"
        TEXT xml_tag_name "If XML tool call, the tag name"
        INTEGER tool_index "Index for multiple tool calls in one step"
        TEXT model_name "Model used for this message (if assistant)"
    }

    agent_runs {
        UUID id PK "Agent Run ID"
        UUID thread_id FK "FK to threads.thread_id"
        TEXT status "Status of the agent run (e.g., 'running', 'completed', 'failed', 'stopped')"
        TIMESTAMP started_at "Timestamp when the run started"
        TIMESTAMP completed_at "Timestamp when the run completed/failed/stopped"
        JSONB responses "(Not used for primary storage, stream data stored elsewhere or transient)"
        TEXT error "Error message if the run failed"
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }
    
    %% --- public schema (Other app-specific) ---
    devices {
        UUID id PK
        TEXT name
        TEXT type
        TEXT os
        TEXT browser
        JSONB screen "Screen dimensions, etc."
        TEXT user_agent
        TEXT external_id "ID from external service if any"
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    recordings {
        UUID id PK
        UUID device_id FK "FK to devices.id"
        TEXT name
        TEXT status
        TEXT path "Storage path of the recording"
        INTEGER duration "Duration in seconds"
        JSONB metadata "Other metadata"
        TIMESTAMP recorded_at
        TIMESTAMP created_at
        TIMESTAMP updated_at
    }

    %% --- Relationships ---
    "auth.users" ||--o{ accounts : "primary_owner_user_id"
    "auth.users" }o--o{ account_user : "user_id"
    accounts ||--o{ account_user : "account_id"
    accounts ||--o{ invitations : "account_id"
    "auth.users" }o--o{ invitations : "invited_by_user_id"
    accounts ||--o{ billing_customers : "account_id"
    billing_customers ||--o{ billing_subscriptions : "billing_customer_id"
    
    accounts ||--o{ projects : "account_id"
    projects ||--o{ threads : "project_id"
    accounts ||--o{ threads : "account_id"  // Direct link also useful for queries by account
    threads ||--o{ messages : "thread_id"
    threads ||--o{ agent_runs : "thread_id"

    devices ||--o{ recordings : "device_id"
```

## Notes on Enum Types

Mermaid ERD syntax does not have direct support for specifying Enum types for columns. The following columns use Enum-like values:

*   **`account_user.account_role`**: Expected values include `owner`, `member`.
*   **`invitations.account_role`**: Expected values include `owner`, `member`.
*   **`invitations.invitation_type`**: Expected values include `one_time`, `reusable`.
*   **`billing_subscriptions.status`**: Expected values include `active`, `past_due`, `canceled`, `incomplete`, `incomplete_expired`, `trialing`, `unpaid`. (These often map to Stripe subscription statuses).
*   **`messages.type`**: Common values include `user`, `assistant`, `tool`, `status`, `system`, `browser_state`, `image_context`.
*   **`agent_runs.status`**: Common values include `running`, `completed`, `failed`, `stopped`.

These should be enforced at the database level using PostgreSQL Enum types or check constraints.
The `sandbox` column in `projects` and `content`/`metadata` columns in `messages` are JSONB and can have varied structures. Key expected fields within them are context-dependent.
The `responses` column in `agent_runs` is noted as not for primary storage of all stream data, which is typically handled transiently (e.g., via Redis for live streaming) and then individual messages stored in the `messages` table.
The `team_members_pending_invitation_count` in `accounts` is likely a cached or computed value; its direct representation in ERD might be simplified, or it could be managed by triggers/functions.
The `default_model_id`, `default_model_provider`, `default_model_name` in `accounts` suggest a relationship to a (currently undetailed) models table or configuration.

The diagram attempts to be comprehensive. If it proves too dense, it can be split into:
1.  Basejump Schema (`auth.users`, `accounts`, `account_user`, `invitations`, `billing_customers`, `billing_subscriptions`).
2.  AgentPress Core Schema (`projects`, `threads`, `messages`, `agent_runs` and their link to `accounts`).
3.  Other App-Specific Tables (`devices`, `recordings`).
