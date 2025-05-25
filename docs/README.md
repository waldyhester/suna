# System Documentation

This section contains various diagrams and documents describing the architecture, design, and processes of the Suna application.

## Diagrams

*   **[Activity Diagrams](./activity_diagrams.md)**
    *   Visualizes key user flows and system processes. Includes detailed flows for message handling, agent tool usage, and more.
*   **[Database Schema (ERD)](./database_schema.md)**
    *   Detailed Entity Relationship Diagram of the database, showing tables, columns, and relationships for both `basejump` and application-specific schemas.
*   **[Backend Architecture](./backend_architecture.md)**
    *   Structural diagram of the backend system, including the FastAPI application, API modules, background task system (Dramatiq/RabbitMQ), core agent logic, sandbox management (Daytona), and interactions with services like Postgres, Redis, and LLMs.
*   **[Frontend Architecture](./frontend_architecture.md)**
    *   Structural diagram of the Next.js frontend application, including key components, state management (React Query, Context), routing, and interactions with the backend API.

## Other Documentation

*   **[Self-Hosting Guide](./SELF-HOSTING.md)**
    *   Instructions and information for self-hosting the Suna application.
