# Frontend Architecture

This document outlines the main structural components of the frontend application, their interactions, and typical data flows. It's built using Next.js (App Router) and leverages React Query for server state management.

```mermaid
graph TD
    %% User
    User[User via Browser]

    %% Core Framework & Routing
    subgraph NextJsApp [Next.js Application (App Router)]
        direction TB
        User -- Interacts with --> AppRouter[Next.js App Router]
        AppRouter -- Renders --> PageComponents[Page Components]
        
        subgraph PageComponents [Page Components (Containers)]
            ThreadPage["ThreadPage (`/agents/{threadId}`)"]
            DashboardPage["DashboardPage (`/dashboard`)"]
            SettingsPage["SettingsPages (`/settings/*`)"]
            AuthPages["AuthPages (`/auth/*`)"]
            HomePage["Landing/Home Page (`/`)"]
        end
    end

    %% UI Components
    subgraph UI [UI Components & Presentation Logic]
        direction TB
        PageComponents --> ReusableComponents[Reusable UI Component Groups]
        ReusableComponents --> BaseUI[Base UI Library (`components/ui/*` - Shadcn)]

        subgraph ReusableComponents
            ChatInputComp["ChatInput Component"]
            MessageListComp["MessageList / ThreadContent"]
            FileViewerModalComp["FileViewerModal"]
            ToolCallSidePanelComp["ToolCallSidePanel"]
            SiteHeaderComp["SiteHeader"]
            SidebarComp["Sidebar (Left Navigation)"]
            BillingComp["Billing Components"]
        end
    end
    
    %% State Management
    subgraph StateManagement [State Management]
        direction TB
        ReactQuery["React Query (TanStack Query)"]
        ContextAPI["React Context API / Zustand (for global UI state)"]
        
        PageComponents -- Uses/Updates --> ReactQuery
        ReusableComponents -- Uses/Updates --> ReactQuery
        PageComponents -- Uses/Updates --> ContextAPI
        ReusableComponents -- Uses/Updates --> ContextAPI
    end

    %% Data Fetching & API Client
    subgraph DataFetching [Data Fetching & API Client Logic]
        direction TB
        ApiClient["`lib/api.ts` (Primary Backend API Client)"]
        AgentStreamHook["`hooks/useAgentStream.ts` (SSE Streaming)"]
        SupabaseClient["Supabase Client (`lib/supabase/client.ts`)"]
        
        ReactQuery -- Uses --> ApiClient
        PageComponents -- Uses --> AgentStreamHook
        AuthPages -- Uses --> SupabaseClient
        ApiClient -- Interacts with --> BackendAPI
        AgentStreamHook -- Connects to SSE --> BackendAPI
        SupabaseClient -- Interacts with --> SupabaseServices[Supabase (Auth, DB)]
    end

    %% Backend & External Services (as consumed by Frontend)
    subgraph BackendServices [Backend & External Services]
        direction TB
        BackendAPI[Backend API (FastAPI)]
        SupabaseServices
        LangfuseClientSide["Langfuse (Client-side Tracing, if any)"]
    end

    %% Key Interactions & Data Flows

    %% 1. Page Load & Initial Data Fetch (e.g., ThreadPage)
    AppRouter -- Loads --> ThreadPage
    ThreadPage -- Triggers React Query hooks --> ReactQuery
    ReactQuery -- Uses `useQuery` with functions from --> ApiClient
    ApiClient -- HTTP GET Request --> BackendAPI
    BackendAPI -- Response --> ApiClient
    ApiClient -- Returns data --> ReactQuery
    ReactQuery -- Caches data & provides to --> ThreadPage
    ThreadPage -- Renders with data --> MessageListComp
    ThreadPage -- May also initiate stream if agent run is active --> AgentStreamHook
    
    %% 2. User Sends a Message
    User -- Types message --> ChatInputComp
    ChatInputComp -- On Submit, calls handler in --> ThreadPage
    ThreadPage -- Calls React Query `useMutation` (e.g., `useAddUserMessageMutation`) --> ReactQuery
    ReactQuery -- Uses mutation function from --> ApiClient
    ApiClient -- HTTP POST Request (add message & start agent) --> BackendAPI
    BackendAPI -- Responds with agent_run_id --> ApiClient
    ApiClient -- Returns agent_run_id to mutation --> ReactQuery
    ThreadPage -- Updates `agentRunId` state, triggers --> AgentStreamHook
    AgentStreamHook -- Establishes SSE connection --> BackendAPI

    %% 3. Agent Response Streaming
    BackendAPI -- Pushes SSE events --> AgentStreamHook
    AgentStreamHook -- Processes events, updates internal state --> AgentStreamHook
    AgentStreamHook -- Provides (via return values) `streamingTextContent`, `streamingToolCall`, `status` to --> ThreadPage
    ThreadPage -- Updates UI in real-time --> MessageListComp
    ThreadPage -- Updates UI for tool calls --> ToolCallSidePanelComp

    %% 4. Authentication
    User -- Navigates to Auth Page or action requires auth --> AppRouter
    AppRouter -- Renders --> AuthPages
    AuthPages -- Uses Supabase Client (e.g., for OAuth, Magic Link) --> SupabaseClient
    SupabaseClient -- Handles Auth with --> SupabaseServices
    SupabaseClient -- On success, updates session, potentially in --> ContextAPI["AuthProvider / SessionContext"]
    ContextAPI -- Provides auth state to --> PageComponents
    ApiClient -- Reads Auth Token (from context/storage) for authenticated requests --> BackendAPI

    %% Styling
    style NextJsApp fill:#D5F5E3,stroke:#333,stroke-width:2px
    style UI fill:#FCF3CF,stroke:#333,stroke-width:2px
    style StateManagement fill:#E8DAEF,stroke:#333,stroke-width:2px
    style DataFetching fill:#D6EAF8,stroke:#333,stroke-width:2px
    style BackendServices fill:#FADBD8,stroke:#333,stroke-width:2px
```

### Component Descriptions:

*   **Next.js Application (App Router)**: The core framework providing server-side rendering, client-side navigation, and the overall application structure using the App Router paradigm.
    *   **Page Components**: Top-level components for different routes/views (e.g., `ThreadPage` for conversations, `DashboardPage`). These often orchestrate data fetching and manage page-specific state.
*   **UI Components & Presentation Logic**:
    *   **Reusable UI Component Groups**: Major, feature-specific components like `ChatInput`, `MessageList` (part of `ThreadContent`), `FileViewerModal`, `ToolCallSidePanel`, `SiteHeader`, etc. These encapsulate significant parts of the UI and user interaction logic.
    *   **Base UI Library (`components/ui/*`)**: Common, low-level UI elements (buttons, dialogs, inputs, etc.), likely based on a library like Shadcn/ui, providing consistent styling and accessibility.
*   **State Management**:
    *   **React Query (TanStack Query)**: Primarily used for server state management. Handles fetching, caching, synchronizing, and updating data from the backend API. Manages loading and error states for server data.
    *   **React Context API / Zustand**: Used for global client-side UI state (e.g., theme, sidebar visibility via `SidebarProvider`, authentication status via `AuthProvider`).
*   **Data Fetching & API Client Logic**:
    *   **`lib/api.ts`**: A dedicated module that centralizes functions for making HTTP requests to the backend API. Used by React Query hooks and other parts of the application.
    *   **`hooks/useAgentStream.ts`**: Custom hook responsible for establishing and managing the Server-Sent Event (SSE) connection for real-time streaming of agent responses.
    *   **Supabase Client (`lib/supabase/client.ts`)**: Client-side interface for interacting with Supabase services, primarily for authentication (GoTrue) and potentially direct database interactions if needed (though most data access is via the backend API).
*   **Backend & External Services (as consumed by Frontend)**:
    *   **Backend API (FastAPI)**: The primary source of data and business logic, consumed via HTTP requests.
    *   **Supabase Services**: Includes Supabase Auth (GoTrue) for user authentication and potentially Supabase DB for direct data operations from the client if applicable.
    *   **Langfuse (Client-side Tracing)**: If implemented, allows for capturing client-side events and traces to be sent to Langfuse for observability.

### Key Interactions & Data Flows:

1.  **Page Load & Initial Data (e.g., viewing a thread)**:
    *   User navigates to a URL. Next.js App Router maps it to a Page Component (e.g., `ThreadPage`).
    *   `ThreadPage` mounts and its React Query `useQuery` hooks are triggered.
    *   These hooks call functions in `lib/api.ts` to fetch initial data (thread details, messages, project info) from the Backend API.
    *   React Query manages caching and provides data, loading, and error states to the page.
    *   The page renders UI components with the fetched data.
    *   If an agent run is detected as active from the fetched data, `useAgentStream` might be initiated.

2.  **User Sends a Message**:
    *   User types in `ChatInputComp` and submits.
    *   A handler function in `ThreadPage` is called.
    *   This handler typically uses a React Query `useMutation` hook (which again uses `lib/api.ts`) to send the message to the Backend API. This API call usually also triggers a new agent run.
    *   The UI might optimistically update to show the user's message immediately.
    *   Upon successful mutation response (containing `agent_run_id`), `ThreadPage` updates its state, and `useAgentStream` is triggered to start streaming for the new run.

3.  **Agent Response Streaming**:
    *   `useAgentStream` establishes an SSE connection to the Backend API's stream endpoint.
    *   The backend pushes agent messages (text chunks, tool calls, status updates) as SSE events.
    *   `useAgentStream` processes these events, updating its internal state (`streamingTextContent`, `streamingToolCall`, `status`).
    *   `ThreadPage` consumes these state values from `useAgentStream` and updates the `MessageListComp` and `ToolCallSidePanelComp` in real-time.

4.  **Authentication**:
    *   User interacts with AuthPages (e.g., Login, Sign Up).
    *   These pages use the `SupabaseClient` to interact with Supabase GoTrue (e.g., OAuth, magic link, email/password).
    *   Upon successful authentication, the session is typically managed by an `AuthProvider` (using React Context), making user/session information available throughout the app.
    *   Authenticated API calls from `lib/api.ts` include the JWT token obtained from the session.

This architecture emphasizes a separation of concerns, with Next.js handling routing and rendering, React Query managing server state, `useAgentStream` handling real-time updates, and `lib/api.ts` encapsulating backend communication. UI components are structured hierarchically from pages down to base elements.
