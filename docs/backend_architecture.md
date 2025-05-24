# Backend Architecture

This document outlines the main structural components of the backend system, their interactions, and data flows.

```mermaid
graph TD
    %% User/Client
    UserClient[User/Client via HTTP]

    %% External Services / Dependencies
    subgraph ExternalServices [External Services & Dependencies]
        StripeAPI[Stripe API]
        DaytonaSDK[Daytona SDK / Engine]
        LLMService[LLM Service (e.g., OpenAI, Anthropic via LiteLLM)]
        LangfuseService[Langfuse Tracing Service]
        SupabaseDB[Supabase Database (PostgreSQL)]
        SupabaseAuth[Supabase GoTrue (Auth)]
        RedisService[Redis (Cache & Pub/Sub)]
        RabbitMQService[RabbitMQ (Message Broker)]
    end

    %% Main Application
    subgraph FastAPIApp [FastAPI Application]
        direction LR
        UserClient --> APIGateway[API Gateway / Main Router]
        
        subgraph Routers [API Routers]
            APIGateway --> AgentRouter["/agent & /thread & /agent-run Router"]
            APIGateway --> SandboxRouter["/sandboxes Router"]
            APIGateway --> BillingRouter["/billing Router"]
            APIGateway --> AuthRouter["/auth Router (Potentially handled by Supabase directly or custom)"]
        end

        subgraph CoreLogicModules [Core Logic Modules]
            AgentRunLogic["agent.run module (Agent execution logic)"]
            AgentPressFramework["agentpress framework (Orchestration, Tool Calling, Response Processing)"]
            SandboxLogic["sandbox.sandbox module (Sandbox creation & management)"]
            BillingLogic["services.billing (Stripe interactions)"]
            AuthLogic["utils.auth_utils (JWT, user verification)"]
        end
        
        Routers --> CoreLogicModules
        CoreLogicModules --> SupabaseDB
        CoreLogicModules --> RedisService
        CoreLogicModules --> LLMService
        CoreLogicModules --> DaytonaSDK
        CoreLogicModules --> LangfuseService
        BillingRouter --> StripeAPI
        AuthRouter --> SupabaseAuth
        AgentRouter --> Dramatiq[Dramatiq Task Queue]
    end

    %% Background Task System
    subgraph BackgroundTaskSystem [Background Task System]
        direction TB
        Dramatiq --> RabbitMQService
        RabbitMQService --> RunAgentActor[run_agent_background Actor (Dramatiq Actor)]
        RunAgentActor --> AgentRunLogic
        RunAgentActor --> AgentPressFramework
        RunAgentActor --> SupabaseDB
        RunAgentActor --> RedisService
        RunAgentActor --> LLMService
        RunAgentActor --> DaytonaSDK
        RunAgentActor --> LangfuseService
    end
    
    %% Data Flow & Interactions Summary
    %% User Request (e.g., start agent)
    UserClient -- HTTPS Request --> AgentRouter
    AgentRouter -- Validates, AuthN/AuthZ --> AuthLogic
    AuthLogic -- Verifies against --> SupabaseAuth
    AgentRouter -- Checks billing --> BillingLogic
    BillingLogic -- Verifies subscription --> StripeAPI
    BillingLogic -- Checks usage --> SupabaseDB
    AgentRouter -- Creates initial records (e.g., agent_runs) --> SupabaseDB
    AgentRouter -- Enqueues task --> Dramatiq

    %% Background Agent Processing
    RunAgentActor -- Fetches data --> SupabaseDB
    RunAgentActor -- Interacts with LLM --> LLMService
    RunAgentActor -- Uses tools --> SandboxLogic
    SandboxLogic -- Manages sandbox lifecycle --> DaytonaSDK
    RunAgentActor -- Logs traces --> LangfuseService
    RunAgentActor -- Stores messages, results --> SupabaseDB
    RunAgentActor -- Publishes stream chunks --> RedisService

    %% Response Streaming (Handled by another flow, but Redis is the bridge)
    RedisService -- Stream data available for Frontend --> UserClient

    %% Sandbox Operations (e.g., file upload, command exec)
    UserClient -- HTTPS Request (e.g., upload file) --> SandboxRouter
    SandboxRouter -- Uses --> SandboxLogic
    SandboxLogic -- Interacts with --> DaytonaSDK
    SandboxRouter -- Returns result --> UserClient

    %% Styling
    style FastAPIApp fill:#D5F5E3,stroke:#333,stroke-width:2px
    style BackgroundTaskSystem fill:#FADBD8,stroke:#333,stroke-width:2px
    style ExternalServices fill:#E8DAEF,stroke:#333,stroke-width:2px
    style CoreLogicModules fill:#FCF3CF,stroke:#333,stroke-width:1px
    style Routers fill:#D6EAF8,stroke:#333,stroke-width:1px
```

### Component Descriptions:

*   **FastAPI Application**: The main web server handling incoming HTTP requests.
    *   **API Gateway / Main Router**: Entry point for all API requests.
    *   **API Routers**:
        *   **/agent, /thread, /agent-run Router**: Handles requests related to agent lifecycle, message processing, and streaming.
        *   **/sandboxes Router**: Manages sandbox operations (file listing, content, etc.) via the Daytona SDK.
        *   **/billing Router**: Interacts with Stripe for billing and subscription management.
        *   **/auth Router**: Handles authentication, potentially integrating with Supabase GoTrue.
    *   **Core Logic Modules**:
        *   **`agent.run` module**: Contains the primary logic for an agent's execution cycle, including LLM interaction and tool use orchestration.
        *   **`agentpress` framework**: Provides the underlying framework for defining agent capabilities, processing LLM responses, managing tool calls, and message history.
        *   **`sandbox.sandbox` module**: Interface for creating, starting, and interacting with sandboxes (likely via Daytona SDK).
        *   **`services.billing`**: Encapsulates logic for communicating with Stripe API.
        *   **`utils.auth_utils`**: Utilities for JWT validation and user authorization.
*   **Background Task System**: Handles long-running agent processes.
    *   **Dramatiq**: The task queue framework used to define and manage background tasks (actors).
    *   **RabbitMQ**: The message broker that Dramatiq uses to queue tasks, ensuring persistence and decoupling.
    *   **`run_agent_background` Actor**: The Dramatiq actor responsible for executing the main agent logic (`agent.run`) asynchronously. This is where the bulk of an agent's work happens after being initiated by an API request.
*   **External Services & Dependencies**:
    *   **Supabase Database (PostgreSQL)**: Primary data store for projects, threads, messages, user accounts, billing info, etc.
    *   **Supabase GoTrue (Auth)**: Manages user authentication and identity.
    *   **Redis**: Used for caching, real-time message streaming (Pub/Sub and Lists for SSE), and potentially for distributed state management (e.g., tracking active agent runs per instance).
    *   **LLM Service (LiteLLM)**: Abstraction layer for communicating with various Large Language Models (OpenAI, Anthropic, etc.). `LiteLLM` standardizes the API calls.
    *   **Daytona SDK / Engine**: Used for creating, managing, and interacting with sandboxed development environments where agents can execute tools (shell commands, file operations).
    *   **Langfuse Tracing Service**: For observability and tracing of agent executions, LLM calls, and tool usage.
    *   **Stripe API**: For handling payments, subscriptions, and billing customer data.

### Key Interactions & Data Flows:

1.  **User Initiates Agent Task (e.g., sends a message)**:
    *   Frontend sends request to an Agent API endpoint (e.g., `/threads/{threadId}/agent/start`).
    *   FastAPI app authenticates, authorizes, performs billing checks (interacting with Supabase DB & Stripe).
    *   If valid, a new `agent_runs` record is created in the DB, and a task is enqueued into RabbitMQ via Dramatiq.
    *   The API responds quickly to the frontend with an `agent_run_id`.

2.  **Background Agent Processing**:
    *   A `run_agent_background` Dramatiq worker picks up the task from RabbitMQ.
    *   The worker executes `agent.run`, which uses `agentpress` to manage the conversation.
    *   `agent.run` interacts with:
        *   **LLM Service (LiteLLM)** for generating responses and deciding on tool use.
        *   **Sandbox (Daytona SDK)** if tools need to be executed (e.g., shell commands, file access).
        *   **Supabase DB** to store messages (user, assistant, tool calls, tool results).
        *   **Langfuse** to send traces of the execution.
        *   **Redis** to publish message chunks for real-time streaming to the frontend.

3.  **Response Streaming**:
    *   As the agent generates responses or tool updates, these are pushed to a Redis List and a notification is sent via Redis Pub/Sub.
    *   The frontend, connected to an SSE endpoint (e.g., `/agent-run/{agent_run_id}/stream`), receives these updates. The SSE endpoint on the backend reads from Redis to stream data.

4.  **Direct Sandbox Interaction (e.g., File Upload/View)**:
    *   Frontend sends request to a Sandbox API endpoint.
    *   The API uses `sandbox.sandbox` module (which wraps Daytona SDK) to perform the action.
    *   Response is sent back to the frontend.

This structure allows the API to be responsive by offloading long-running agent tasks to background workers, while Redis facilitates real-time communication for a reactive user experience.
