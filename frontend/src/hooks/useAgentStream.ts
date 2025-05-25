import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  streamAgent,
  getAgentStatus,
  stopAgent,
  AgentRun,
  getMessages,
} from '@/lib/api';
import { toast } from 'sonner';
import {
  UnifiedMessage,
  ParsedContent,
  ParsedMetadata,
} from '@/components/thread/types';
import { safeJsonParse } from '@/components/thread/utils';

interface ApiMessageType {
  message_id?: string;
  thread_id?: string;
  type: string;
  is_llm_message?: boolean;
  content: string;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
}

// Define the structure returned by the hook
export interface UseAgentStreamResult {
  status: string;
  textContent: string;
  toolCall: ParsedContent | null;
  error: string | null;
  agentRunId: string | null; // Expose the currently managed agentRunId
  startStreaming: (runId: string) => void;
  stopStreaming: () => Promise<void>;
}

// Define the callbacks the hook consumer can provide
export interface AgentStreamCallbacks {
  onMessage: (message: UnifiedMessage) => void; // Callback for complete messages
  onStatusChange?: (status: string) => void; // Optional: Notify on internal status changes
  onError?: (error: string) => void; // Optional: Notify on errors
  onClose?: (finalStatus: string) => void; // Optional: Notify when streaming definitively ends
  onAssistantStart?: () => void; // Optional: Notify when assistant starts streaming
  onAssistantChunk?: (chunk: { content: string }) => void; // Optional: Notify on each assistant message chunk
}

// Helper function to map API messages to UnifiedMessages
const mapApiMessagesToUnified = (
  messagesData: ApiMessageType[] | null | undefined,
  currentThreadId: string,
): UnifiedMessage[] => {
  return (messagesData || [])
    .filter((msg) => msg.type !== 'status')
    .map((msg: ApiMessageType) => ({
      message_id: msg.message_id || null,
      thread_id: msg.thread_id || currentThreadId,
      type: (msg.type || 'system') as UnifiedMessage['type'],
      is_llm_message: Boolean(msg.is_llm_message),
      content: msg.content || '',
      metadata: msg.metadata || '{}',
      created_at: msg.created_at || new Date().toISOString(),
      updated_at: msg.updated_at || new Date().toISOString(),
    }));
};

export function useAgentStream(
  callbacks: AgentStreamCallbacks,
  threadId: string,
  setMessages: (messages: UnifiedMessage[]) => void,
): UseAgentStreamResult {
  /**
   * @property {string | null} agentRunId
   * Stores the ID of the currently active agent run being streamed.
   * It's `null` if no stream is active or after a stream has been finalized.
   * This ID is used to manage stream connections and interactions with the backend for a specific agent execution.
   */
  const [agentRunId, setAgentRunId] = useState<string | null>(null);

  /**
   * @property {string} status
   * Represents the current operational status of the agent stream and interaction.
   * Possible values include:
   *  - 'idle': No stream is active, and the hook is ready.
   *  - 'connecting': Attempting to establish a connection for a new agent run stream.
   *  - 'streaming': Actively receiving data from the agent run stream.
   *  - 'completed': The agent run finished successfully.
   *  - 'stopped': The agent run was manually stopped by the user.
   *  - 'failed': The agent run encountered an error and could not complete.
   *  - 'error': A client-side or connection error occurred during streaming.
   *  - 'agent_not_running': Attempted to stream an agent run that is not currently in a 'running' state on the backend.
   * This status is crucial for UI updates and conditional logic in the consuming component.
   */
  const [status, setStatus] = useState<string>('idle');

  /**
   * @property {{ content: string; sequence?: number }[]} textContent
   * An array storing chunks of assistant's text content as they arrive from the stream.
   * Each element is an object containing a `content` string (the chunk) and an optional `sequence` number
   * (if provided by the backend, useful for ordering).
   * This state is accumulated during streaming and typically cleared once a full assistant message is processed
   * or when a new stream starts. The `orderedTextContent` memoized value is derived from this.
   */
  const [textContent, setTextContent] = useState<
    { content: string; sequence?: number }[]
  >([]);

  /**
   * @property {ParsedContent | null} toolCall
   * Stores the parsed content of an active tool call when the backend signals `status_type: 'tool_started'`.
   * It holds information like the tool's name, arguments, and index.
   * It's set to `null` when no tool call is currently active, or after a tool call completes, fails, or errors out.
   * This allows the UI to display information about ongoing tool executions.
   */
  const [toolCall, setToolCall] = useState<ParsedContent | null>(null);

  /**
   * @property {string | null} error
   * Stores an error message string if an error occurs during the streaming process,
   * an agent execution error is reported by the backend via the stream, or an API call within the hook fails.
   * It's `null` if there are no active errors.
   * This state is used to display error information to the user, often via toasts or error messages in the UI.
   */
  const [error, setError] = useState<string | null>(null);

  /**
   * @property {React.MutableRefObject<(() => void) | null>} streamCleanupRef
   * Holds a reference to the cleanup function returned by `streamAgent` (which typically closes the EventSource).
   * This ref is used to ensure that any active stream connection can be properly closed when:
   *  - A new stream is started (to clean up the previous one).
   *  - The component unmounts.
   *  - The stream is explicitly stopped or finalized.
   * Purpose: Prevents multiple concurrent streams for the same hook instance and ensures resources are released.
   */
  const streamCleanupRef = useRef<(() => void) | null>(null);

  /**
   * @property {React.MutableRefObject<boolean>} isMountedRef
   * A ref that tracks whether the component utilizing this hook is currently mounted.
   * It's set to `true` on mount and `false` on unmount.
   * Purpose: Used in asynchronous callbacks (e.g., after API calls, stream events) to prevent
   * attempting state updates if the component has since been unmounted. This helps avoid
   * React warnings about setting state on unmounted components and potential memory leaks.
   */
  const isMountedRef = useRef<boolean>(true);

  /**
   * @property {React.MutableRefObject<string | null>} currentRunIdRef
   * Stores the `agentRunId` of the agent run that the hook is currently managing or attempting to stream.
   * Purpose: Provides a stable reference to the run ID, especially within asynchronous operations or closures.
   * State updates (like `setAgentRunId`) are asynchronous, so `currentRunIdRef.current` gives immediate
   * access to the ID that was active when an operation (e.g., an event handler, a cleanup function)
   * was initiated, mitigating issues with stale state in closures.
   */
  const currentRunIdRef = useRef<string | null>(null); // Ref to track the run ID being processed
  
  /**
   * @property {React.MutableRefObject<string>} threadIdRef
   * Holds the `threadId` prop passed to the hook.
   * Purpose: Ensures that asynchronous operations or callbacks within the hook (e.g., `finalizeStream`
   * when refetching messages) use the `threadId` that was current when the operation became relevant.
   * This helps prevent issues with stale closures if the `threadId` prop changes while an async task is pending.
   */
  const threadIdRef = useRef(threadId); // Ref to hold the current threadId

  /**
   * @property {React.MutableRefObject<(messages: UnifiedMessage[]) => void>>} setMessagesRef
   * Holds the `setMessages` callback function provided as a prop.
   * Purpose: Similar to `threadIdRef`, this ensures that asynchronous operations or internal callbacks
   * (like the message refetch logic in `finalizeStream`) use the most up-to-date version of the
   * `setMessages` function passed from the parent component. This is crucial for correctly updating
   * the parent component's state and avoiding stale closures.
   */
  const setMessagesRef = useRef(setMessages); // Ref to hold the setMessages function

  const orderedTextContent = useMemo(() => {
    return textContent
      .sort((a, b) => a.sequence - b.sequence)
      .reduce((acc, curr) => acc + curr.content, '');
  }, [textContent]);

  // Update refs if threadId or setMessages changes
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);

  // Helper function to map backend status to frontend status string
  const mapAgentStatus = (backendStatus: string): string => {
    switch (backendStatus) {
      case 'completed':
        return 'completed';
      case 'stopped':
        return 'stopped';
      case 'failed':
        return 'failed';
      default:
        return 'error';
    }
  };

  /**
   * Centralized function to update the internal status of the hook and notify consumers.
   * It ensures that status updates and corresponding callbacks are only triggered if the component is mounted.
   *
   * @param {string} newStatus - The new status to set (e.g., 'streaming', 'completed', 'error').
   */
  const updateStatus = useCallback(
    (newStatus: string) => {
      // Only proceed if the component is still mounted.
      if (isMountedRef.current) {
        setStatus(newStatus);
        // Notify the consumer about the status change via the provided callback.
        callbacks.onStatusChange?.(newStatus);

        // If the new status is 'error', also invoke the onError callback with the current error message.
        if (newStatus === 'error' && error) {
          callbacks.onError?.(error);
        }

        // If the new status indicates a terminal state for the stream, invoke the onClose callback.
        // Terminal states signify that the stream will no longer produce data.
        if (
          [
            'completed', // Agent run finished successfully.
            'stopped',   // Agent run was manually stopped.
            'failed',    // Agent run failed on the backend.
            'error',     // A client-side or connection error occurred.
            'agent_not_running', // Attempted to stream a non-running agent.
          ].includes(newStatus)
        ) {
          callbacks.onClose?.(newStatus);
        }
      }
    },
    // Dependencies: `callbacks` and `error` state are used.
    [callbacks, error],
  ); // Include error dependency

  /**
   * Handles the finalization of an agent stream. This function is called when a stream
   * definitively ends, whether due to successful completion, manual stop, failure, an error,
   * or if the agent was found not to be running.
   *
   * Its responsibilities include:
   * - Cleaning up the active stream connection (e.g., closing EventSource).
   * - Resetting streaming-specific states (textContent, toolCall).
   * - Updating the overall status of the hook.
   * - Clearing the active agentRunId.
   * - Crucially, triggering a refetch of all messages for the current thread if the stream
   *   ended in a terminal state. This ensures the UI reflects the complete and final
   *   set of messages post-agent execution.
   *
   * @param {string} finalStatus - The definitive final status to set for the stream
   *                               (e.g., 'completed', 'stopped', 'failed', 'error').
   * @param {string | null} [runId=agentRunId] - The ID of the agent run being finalized.
   *                                            Defaults to the current `agentRunId` state.
   */
  const finalizeStream = useCallback(
    (finalStatus: string, runId: string | null = agentRunId) => {
      if (!isMountedRef.current) return; // Only proceed if component is mounted.

      // Use refs for threadId and setMessages to ensure the latest versions are used in async operations.
      const currentThreadId = threadIdRef.current; 
      const currentSetMessages = setMessagesRef.current;

      console.log(
        `[useAgentStream] Finalizing stream for ${runId || 'unknown run'} on thread ${currentThreadId} with status: ${finalStatus}`,
      );

      // If a stream cleanup function exists (meaning an EventSource was active), call it.
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
        streamCleanupRef.current = null; // Clear the ref after cleanup.
      }

      // Reset states related to active streaming.
      setTextContent([]); // Clear accumulated text chunks.
      setToolCall(null);  // Clear any active tool call information.

      // Update the overall status and clear the agent run ID.
      updateStatus(finalStatus);
      setAgentRunId(null);         // Clear the agentRunId state.
      currentRunIdRef.current = null; // Clear the ref for the current run ID.

      // --- Reliable Message Refetch on Finalization ---
      // This is a critical step: after an agent run concludes (or is confirmed not running),
      // refetch all messages for the thread to ensure the UI displays the complete and
      // authoritative state from the backend. This accounts for any messages that might have been
      // created or modified by the agent but not fully processed by the stream before it closed.
      const terminalStatusesForRefetch = [
        'completed',
        'stopped',
        'failed',
        'error', // Includes client-side errors where backend state might be unknown or changed.
        'agent_not_running', // Confirms the agent isn't running, so current messages are final for this attempt.
      ];
      if (currentThreadId && terminalStatusesForRefetch.includes(finalStatus)) {
        console.log(
          `[useAgentStream] Refetching messages for thread ${currentThreadId} after finalization (status: ${finalStatus}).`,
        );
        getMessages(currentThreadId)
          .then((messagesData: ApiMessageType[]) => {
            if (isMountedRef.current && messagesData) {
              console.log(
                `[useAgentStream] Refetched ${messagesData.length} messages for thread ${currentThreadId}. Updating UI.`,
              );
              const unifiedMessages = mapApiMessagesToUnified(
                messagesData,
                currentThreadId,
              );
              currentSetMessages(unifiedMessages); // Update messages in the parent component.
            } else if (!isMountedRef.current) {
              console.log(
                `[useAgentStream] Component unmounted before messages could be set after refetch for thread ${currentThreadId}.`,
              );
            }
          })
          .catch((err) => {
            // Log error during refetch but typically don't change overall agent status here,
            // as the agent run itself has already finalized.
            console.error(
              `[useAgentStream] Error refetching messages for thread ${currentThreadId} after finalization:`,
              err,
            );
            toast.error(`Failed to refresh messages: ${err.message}`);
          });
      } else {
        // Log if refetch is skipped (e.g., if finalStatus isn't one that implies a completed run).
        console.log(
          `[useAgentStream] Skipping message refetch for thread ${currentThreadId}. Final status: ${finalStatus}`,
        );
      }

      // Optional: If the run was definitively stopped or completed, one final check on its status.
      // This can be useful for internal bookkeeping or confirming the backend acknowledges the state.
      // This is less critical than the message refetch.
      if (
        runId &&
        (finalStatus === 'completed' ||
          finalStatus === 'stopped' ||
          finalStatus === 'agent_not_running')
      ) {
        getAgentStatus(runId).catch((err) => {
          // Errors here are logged but generally not critical to the UI state at this point.
          console.log(
            `[useAgentStream] Post-finalization status check for ${runId} failed (this might be expected if run was deleted or not found): ${err.message}`,
          );
        });
      }
    },
    // Dependencies: `agentRunId` (for default runId) and `updateStatus` (for internal state changes).
    [agentRunId, updateStatus],
  );

  /**
   * Overall Error Handling Strategy:
   * Errors within `useAgentStream` can originate from several sources:
   * 1. API Calls made by the hook (e.g., `getAgentStatus` in `startStreaming` or `finalizeStream`, `stopAgent`).
   *    These are typically caught in `try...catch` blocks, set the `error` state, and might call `callbacks.onError`.
   * 2. Server-Sent Event (SSE) stream connection errors (e.g., network issues, server unavailable).
   *    These are handled by the `handleStreamError` callback provided to `streamAgent`.
   * 3. Error messages explicitly sent by the backend *through* the SSE stream (e.g., a JSON message with `status: 'error'`).
   *    These are parsed in `handleStreamMessage`.
   * 4. Unexpected stream closures, handled by `handleStreamClose`, which then tries to determine the true agent status.
   *
   * The general approach is to:
   * - Set the `error` state variable with an error message.
   * - Invoke the `callbacks.onError` prop to notify the consuming component.
   * - Display a user-facing `toast` notification for immediate feedback.
   * - Transition the hook's `status` to an appropriate terminal state (e.g., 'error', 'failed').
   * - Call `finalizeStream` to ensure cleanup and potentially refetch messages to get the latest consistent state.
   */

  // --- Stream Callback Handlers ---

  /**
   * Processes raw data received from the Server-Sent Event (SSE) stream.
   * This function is the primary handler for incoming agent messages and status updates.
   * It parses the data, determines its type, and updates the hook's state accordingly,
   * notifying the consuming component via callbacks.
   *
   * @param {string} rawData - The raw string data received from the SSE stream.
   *                           Expected to be prefixed with "data: " and be a JSON string.
   */
  const handleStreamMessage = useCallback(
    (rawData: string) => {
      if (!isMountedRef.current) return; // Ensure component is mounted.
      (window as any).lastStreamMessage = Date.now(); // For debugging or monitoring stream activity.

      // Pre-process raw SSE data: remove "data: " prefix and trim.
      let processedData = rawData;
      if (processedData.startsWith('data: ')) {
        processedData = processedData.substring(6).trim();
      }
      if (!processedData) return; // Ignore empty messages.

      // --- Early Exit for Specific Completion Messages ---
      // Some backend configurations might send simple string messages for completion.
      // Handling these early can prevent unnecessary JSON parsing attempts.
      if (
        processedData ===
        '{"type": "status", "status": "completed", "message": "Agent run completed successfully"}'
      ) {
        console.log(
          '[useAgentStream] Received explicit final completion status message. Finalizing.',
        );
        finalizeStream('completed', currentRunIdRef.current);
        return;
      }
      // Handle other forms of completion signals that might not be structured JSON.
      if (
        processedData.includes('Run data not available for streaming') || // Example: Daytona specific message
        processedData.includes('Stream ended with status: completed')    // Example: Generic completion
      ) {
        console.log(
          `[useAgentStream] Detected final completion signal: "${processedData}". Finalizing.`,
        );
        finalizeStream('completed', currentRunIdRef.current);
        return;
      }

      // --- Attempt to Parse as JSON for Structured Error Messages ---
      // The backend might send structured error messages via the stream.
      try {
        const jsonData = JSON.parse(processedData);
        if (jsonData.status === 'error') { // Check for a specific error structure.
          console.error('[useAgentStream] Received structured error status message:', jsonData);
          const errorMessage = jsonData.message || 'Unknown error occurred via stream.';
          setError(errorMessage);
          toast.error(errorMessage, { duration: 15000 }); // Show persistent toast for errors.
          callbacks.onError?.(errorMessage);
          // Typically, an error message from the stream means the run has failed or encountered a critical issue.
          // For robust handling, finalize the stream if an explicit error status is received.
          finalizeStream('error', currentRunIdRef.current); 
          return; 
        }
      } catch (jsonError) {
        // Message is not a JSON object or not a structured error message.
        // Proceed to parse as a standard UnifiedMessage.
      }

      // --- Process as Standard UnifiedMessage ---
      // All other messages are expected to be parsable into the UnifiedMessage format.
      const message: UnifiedMessage = safeJsonParse(processedData, null);
      if (!message) {
        console.warn(
          '[useAgentStream] Failed to parse streamed message into UnifiedMessage:',
          processedData,
        );
        return; // Ignore malformed messages.
      }

      // Parse nested JSON content and metadata within the UnifiedMessage.
      const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
      const parsedMetadata = safeJsonParse<ParsedMetadata>(
        message.metadata,
        {},
      );

      // If receiving any valid message, update status to 'streaming' if not already set.
      if (status !== 'streaming') updateStatus('streaming');

      // Handle message based on its `type` (assistant, tool, status, etc.).
      switch (message.type) {
        case 'assistant':
          // Handles messages from the assistant, which can be chunked or complete.
          // `parsedMetadata.stream_status` indicates if it's a chunk or a complete message.
          if (
            parsedMetadata.stream_status === 'chunk' &&
            typeof parsedContent.content === 'string' // Ensure there's string content in the chunk.
          ) {
            // This is an assistant text chunk.
            // Call onAssistantStart if this is the first chunk of a new response sequence.
            if (textContent.length === 0) {
                 callbacks.onAssistantStart?.();
            }
            // Accumulate text chunks.
            setTextContent((prev) => {
              return prev.concat({
                sequence: message.sequence, // Use sequence if available for ordering.
                content: parsedContent.content as string, // Cast because we checked it's a string
              });
            });
            // Notify consumer of the new chunk.
            callbacks.onAssistantChunk?.({ content: parsedContent.content as string });
          } else if (parsedMetadata.stream_status === 'complete') {
            // A complete assistant message has been received (or a non-chunked one).
            setTextContent([]); // Clear accumulated chunks as this message is final for this interaction.
            setToolCall(null);  // Clear any active tool call display.
            if (message.message_id) callbacks.onMessage(message); // Notify consumer of the complete message.
          } else if (!parsedMetadata.stream_status && typeof parsedContent.content === 'string') {
            // Handle non-chunked assistant messages that still have textual content.
            callbacks.onAssistantStart?.(); // Signal start of (potentially) new assistant message.
            setTextContent([{ content: parsedContent.content, sequence: message.sequence }]); // Set as current text
            callbacks.onAssistantChunk?.({ content: parsedContent.content }); // Treat as a single chunk
            // If it's a complete message without stream_status, it might be passed to onMessage
            // depending on how the consuming component handles onAssistantChunk vs onMessage.
            // For simplicity here, if it has an ID, it's likely a "complete" message in itself.
            if (message.message_id) {
                // To avoid duplicating, typically this path means it's a full message not using chunks.
                // So, we call onMessage and clear textContent as if it were a 'complete' stream_status.
                callbacks.onMessage(message);
                setTextContent([]);
            }
          }
          break;
        case 'tool':
          // A tool result message (or a tool call message itself, depending on backend structure) has been received.
          // This usually signifies the completion of a tool's operation or the request for a tool.
          setToolCall(null); // Clear any active tool call being displayed as a new tool message arrives.
          if (message.message_id) callbacks.onMessage(message); // Notify consumer of the tool-related message.
          break;
        case 'status':
          // Process various status updates from the backend, often related to tool execution or run lifecycle.
          // `parsedContent.status_type` distinguishes different kinds of status updates.
          switch (parsedContent.status_type) {
            case 'tool_started':
              // The backend has started executing a tool. Update UI to show this.
              // This is important for user feedback, indicating the agent is working with a tool.
              setToolCall({
                role: 'assistant', // Tool calls are typically part of an assistant's turn.
                status_type: 'tool_started',
                name: parsedContent.function_name,
                arguments: parsedContent.arguments,
                xml_tag_name: parsedContent.xml_tag_name, // If XML tool calling is used.
                tool_index: parsedContent.tool_index,   // Unique index for this tool call if multiple tools are called.
              });
              break;
            case 'tool_completed':
            case 'tool_failed':
            case 'tool_error':
              // The tool execution has finished (successfully or not).
              // Clear the tool call display if the completed/failed tool matches the one currently active.
              if (toolCall?.tool_index === parsedContent.tool_index) {
                setToolCall(null);
              }
              // Note: A `tool` type message (handled above) usually follows to provide the actual result.
              break;
            case 'thread_run_end':
              // Signals the end of the entire agent run on the backend.
              console.log(
                '[useAgentStream] Received backend signal: thread_run_end. Stream should close or send final status soon.',
              );
              // Don't finalize immediately based on this; wait for the stream to actually close
              // or for a definitive "completed"/"failed"/"stopped" status message from the stream itself.
              break;
            case 'finish':
              // Indicates a reason why the LLM finished generating content for a particular step
              // (e.g., 'stop_sequence', 'tool_calls', 'xml_tool_limit_reached').
              console.log(
                '[useAgentStream] Received LLM finish status from backend:',
                parsedContent.finish_reason,
              );
              // This is primarily informational for debugging or fine-grained control.
              // Actual stream finalization depends on other signals like 'thread_run_end' followed by stream closure.
              break;
            case 'error':
              // An explicit error message from the backend specifically for this agent run.
              console.error(
                '[useAgentStream] Received explicit error status message from backend during run:',
                parsedContent.message,
              );
              setError(parsedContent.message || 'Agent run failed due to a backend-reported error.');
              finalizeStream('error', currentRunIdRef.current); // Finalize the stream as an error.
              break;
            // Other status types like 'thread_run_start', 'assistant_response_start' are logged
            // but might not trigger immediate UI state changes within this hook itself.
            // They can be useful for more granular logging or advanced UI feedback.
            default:
              // console.debug('[useAgentStream] Received unhandled status type from stream:', parsedContent.status_type);
              break;
          }
          break;
        case 'user': // E.g., if backend echoes back user messages for context or confirmation.
        case 'system': // E.g., if backend sends system-level messages or notifications mid-stream.
          // These are treated as complete messages to be passed to the consumer.
          if (message.message_id) callbacks.onMessage(message);
          break;
        default:
          // Log if an unhandled message type is received, which might indicate
          // a new message type from the backend or an issue with frontend/backend contracts.
          console.warn(
            '[useAgentStream] Unhandled message type received from stream:',
            message.type,
          );
      }
    },
    // Dependencies for `handleStreamMessage`.
    [
      threadId, // Though used via ref, including for clarity if direct use was intended.
      setMessages, // Same as threadId.
      status, // Used to determine if status needs to be updated to 'streaming'.
      toolCall, // Used to check against `tool_index` for clearing tool display.
      callbacks, // For notifying consumer of events.
      finalizeStream, // For handling terminal error statuses.
      updateStatus, // For updating internal status.
      textContent, // For onAssistantStart logic based on its length
    ],
  );

  /**
   * Callback for handling errors that occur directly on the EventSource object
   * (e.g., network connection failures, server errors that prevent SSE connection).
   * These are typically client-side or transport-level errors for the stream.
   *
   * @param {Error | string | Event} err - The error object or event from the EventSource.
   */
  const handleStreamError = useCallback(
    (err: Error | string | Event) => {
      if (!isMountedRef.current) return; // Ensure component is mounted.

      // Normalize different error types into a user-friendly string message.
      let errorMessage = 'Unknown streaming error';
      if (typeof err === 'string') {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else if (err instanceof Event && err.type === 'error') {
        // Standard EventSource 'error' events often lack detailed messages.
        // The browser's developer console might log more specific network details.
        errorMessage = 'Stream connection error. Please check your network or server status.';
      }

      console.error('[useAgentStream] EventSource streaming error encountered:', errorMessage, err);
      setError(errorMessage); // Update the error state for the UI.
      
      // Display a persistent toast notification to the user.
      toast.error(errorMessage, { duration: 15000 });
      callbacks.onError?.(errorMessage); // Notify the consuming component of the error.

      const runId = currentRunIdRef.current;
      if (!runId) {
        // If an error occurs but no specific run ID is active (e.g., error during initial connection attempt for a new run),
        // finalize the stream with a generic 'error' status.
        console.warn(
          '[useAgentStream] Stream error occurred, but no agentRunId is active. Finalizing as generic error.',
        );
        finalizeStream('error'); 
        return;
      }
      // If a run ID is active, the stream is likely compromised.
      // `handleStreamClose` is often triggered immediately after an EventSource 'error' event
      // by the browser/EventSource polyfill. `handleStreamClose` will then perform a more
      // definitive status check with the backend. So, we don't always finalize here,
      // but let `handleStreamClose` make the final call on the stream's status.
      // However, if `handleStreamClose` isn't reliably triggered, or to be more proactive:
      // finalizeStream('error', runId); // Consider if immediate finalization is better here.
      // For now, this relies on `handleStreamClose` to follow up.
    },
    // Dependencies: `finalizeStream` (to potentially stop if error is fatal) and `callbacks`.
    [finalizeStream, callbacks], 
  );

  /**
   * Callback for when the EventSource connection is closed. This can happen for various reasons:
   * - The server gracefully closes the connection after the agent run completes successfully.
   * - A network interruption occurs, breaking the connection.
   * - The server crashes, restarts, or otherwise terminates the connection.
   * This function's primary role is to determine the true final status of the agent run
   * by querying the backend API, as the stream closure itself is ambiguous.
   */
  const handleStreamClose = useCallback(() => {
    if (!isMountedRef.current) return; // Ensure component is mounted.
    console.log('[useAgentStream] Stream connection has been closed (by server or network).');

    const runId = currentRunIdRef.current;
    if (!runId) {
      // If no run ID is active, it means the stream closed without ever being fully established
      // or it was already finalized (e.g., by `stopStreaming` or an earlier error).
      console.warn('[useAgentStream] Stream closed, but no active agentRunId was found. Current status:', status);
      // If the status was 'streaming' or 'connecting', an unexpected closure occurred. Finalize as 'error'.
      if (status === 'streaming' || status === 'connecting') {
        finalizeStream('error');
      } else if (
        // If status is already terminal or 'idle', no further action usually needed beyond what finalizeStream does.
        status !== 'idle' &&
        status !== 'completed' &&
        status !== 'stopped' &&
        status !== 'agent_not_running' &&
        status !== 'failed' && // Added failed here
        status !== 'error'     // Added error here
      ) {
        // For any other intermediate state that wasn't 'streaming' or 'connecting',
        // and isn't already terminal, revert to 'idle' if no specific run was being tracked.
        finalizeStream('idle');
      }
      return;
    }

    // If a run ID was active, the stream closure is ambiguous.
    // Query the backend for the authoritative status of this agent run. This is crucial.
    console.log(`[useAgentStream] Stream closed for run ${runId}. Querying backend for its final authoritative status.`);
    getAgentStatus(runId)
      .then((agentStatus) => {
        if (!isMountedRef.current) return; // Re-check mount status after async API call.

        console.log(
          `[useAgentStream] Backend status for run ${runId} after stream close: ${agentStatus.status}`,
        );
        if (agentStatus.status === 'running') {
          // This is an unexpected scenario: stream closed, but backend says agent is still running.
          // This could be a temporary network blip or a server issue where the stream dropped but the process continued.
          // Treat as an error for the stream's perspective as it's no longer receiving updates.
          console.warn(
            `[useAgentStream] Stream closed for run ${runId}, but backend reports agent is still 'running'. Finalizing stream as 'error'.`,
          );
          setError('Stream closed unexpectedly while the agent was reported as still running by the backend.');
          finalizeStream('error', runId); 
          toast.warning('Stream disconnected. The agent might still be running. Please check its status or try refreshing.');
        } else {
          // Backend reports a terminal status (e.g., completed, failed, stopped).
          // Use this as the definitive final status for the stream.
          const finalStatus = mapAgentStatus(agentStatus.status); // Map to frontend status enum.
          console.log(
            `[useAgentStream] Stream closed for run ${runId}. Backend status is '${agentStatus.status}'. Finalizing stream as '${finalStatus}'.`,
          );
          finalizeStream(finalStatus, runId);
        }
      })
      .catch((err) => {
        // An error occurred while trying to get the agent's status after stream closure.
        if (!isMountedRef.current) return;

        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[useAgentStream] Error checking agent status for ${runId} after stream close: ${errorMessage}`,
        );

        // Check if the error indicates the agent run was not found (e.g., a 404 HTTP error).
        // This could happen if the run was deleted by another process or never properly initiated.
        const isNotFoundError =
          errorMessage.includes('not found') || // Common phrase in error messages
          errorMessage.includes('404') ||        // HTTP status code
          errorMessage.includes('does not exist'); // Common phrase in DB error messages

        if (isNotFoundError) {
          console.log(
            `[useAgentStream] Agent run ${runId} not found on backend after stream close. Finalizing as 'agent_not_running'.`,
          );
          // If the run doesn't exist on the backend, it's effectively not running.
          finalizeStream('agent_not_running', runId);
        } else {
          // For other errors (e.g., network error trying to reach `getAgentStatus`),
          // finalize the stream with a generic 'error' status, as the true state of the agent run is unknown.
          finalizeStream('error', runId);
        }
      });
  }, [status, finalizeStream]); // Dependencies: `status` (to decide action if no runId) and `finalizeStream`.

  // --- Effect to manage the stream lifecycle (component mount/unmount) ---
  // --- Effect to manage the stream lifecycle (component mount/unmount) ---
  useEffect(() => {
    // Set `isMountedRef` to true when the component mounts.
    isMountedRef.current = true;

    // Cleanup function to be executed when the component unmounts or before this effect re-runs.
    return () => {
      isMountedRef.current = false; // Mark component as unmounted.
      console.log(
        '[useAgentStream] Component unmounting or dependencies changed. Cleaning up active stream.',
      );
      // If there's an active stream connection (indicated by `streamCleanupRef.current`),
      // call its cleanup function to close the EventSource and prevent further events.
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
        streamCleanupRef.current = null; // Clear the ref.
      }
      // Resetting state here on unmount can be useful to ensure a clean slate if the hook instance
      // were to be reused, though typically a new instance is created on re-mount.
      // `finalizeStream` handles most state resets when a stream ends, so explicit resets here
      // are more of a safeguard or for immediate UI state change on unmount if needed.
      setStatus('idle');
      setTextContent([]);
      setToolCall(null);
      setError(null);
      setAgentRunId(null);
      currentRunIdRef.current = null;
    };
  }, []); // Empty dependency array ensures this effect runs only on mount and unmount.

  // --- Public Functions ---

  /**
   * Initiates the process of streaming data for a given agent run ID.
   * It first cleans up any existing stream, then checks if the target agent run is actually
   * in a 'running' state on the backend. If so, it establishes a new Server-Sent Event (SSE)
   * connection via `streamAgent`.
   *
   * @param {string} runId - The ID of the agent run to start streaming from.
   */
  const startStreaming = useCallback(
    async (runId: string) => {
      if (!isMountedRef.current) return; // Ensure component is mounted.
      console.log(
        `[useAgentStream] Received request to start streaming for agent run ID: ${runId}`,
      );

      // If a stream is already active (or was active and not cleaned up), clean it up first.
      if (streamCleanupRef.current) {
        console.log(
          '[useAgentStream] Cleaning up existing stream before starting new one for run ID:', runId
        );
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }

      // Reset streaming-specific states to ensure a clean slate for the new stream.
      setTextContent([]);
      setToolCall(null);
      setError(null);
      updateStatus('connecting'); // Set status to 'connecting' while setting up.
      setAgentRunId(runId);       // Store the new agent run ID in state.
      currentRunIdRef.current = runId; // Also store in ref for immediate access in closures.

      try {
        // **Critical Pre-check**: Before attempting to connect to the SSE stream,
        // verify with the backend that the agent run is indeed in a 'running' state.
        // This prevents trying to stream from runs that have already completed, failed, or were never started.
        const agentStatus = await getAgentStatus(runId);
        if (!isMountedRef.current) return; // Re-check mount status after async API call.

        if (agentStatus.status !== 'running') {
          // If the agent is not running, do not attempt to stream.
          // Finalize the stream locally with the status reported by the backend.
          console.warn(
            `[useAgentStream] Agent run ${runId} is not in 'running' state (actual status: ${agentStatus.status}). Cannot start stream. Finalizing.`,
          );
          setError(`Agent run is not currently running (status: ${agentStatus.status}).`);
          finalizeStream(
            mapAgentStatus(agentStatus.status) || 'agent_not_running', // Map backend status to local status.
            runId,
          );
          return; // Exit early.
        }

        // Agent is confirmed to be running. Proceed to establish the SSE connection.
        console.log(
          `[useAgentStream] Agent run ${runId} confirmed 'running'. Setting up EventSource stream.`,
        );
        // `streamAgent` (from lib/api) establishes the EventSource and returns a cleanup function.
        const cleanup = streamAgent(runId, {
          onMessage: handleStreamMessage, // Handler for incoming messages.
          onError: handleStreamError,     // Handler for EventSource errors.
          onClose: handleStreamClose,     // Handler for when the EventSource connection closes.
        });
        streamCleanupRef.current = cleanup; // Store the cleanup function.
        // Note: The status will typically be updated to 'streaming' by the `handleStreamMessage`
        // callback upon receiving the first valid message from the stream.
      } catch (err) {
        // Handle errors that occur during the `getAgentStatus` call or `streamAgent` setup.
        if (!isMountedRef.current) return; 

        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[useAgentStream] Error during stream initiation for ${runId}: ${errorMessage}`,
        );
        setError(errorMessage); // Set error state.

        // Determine if the error was due to the agent run not being found.
        const isNotFoundError =
          errorMessage.includes('not found') ||
          errorMessage.includes('404') ||
          errorMessage.includes('does not exist');
        
        // Finalize the stream with an appropriate error status.
        finalizeStream(isNotFoundError ? 'agent_not_running' : 'error', runId);
      }
    },
    // Dependencies for `startStreaming`.
    [
      updateStatus,
      finalizeStream,
      handleStreamMessage,
      handleStreamError,
      handleStreamClose,
    ],
  ); 

  /**
   * Manually stops the currently active agent stream and notifies the backend.
   * This function is typically called when the user explicitly requests to stop the agent.
   */
  const stopStreaming = useCallback(async () => {
    if (!isMountedRef.current || !agentRunId) {
      // No active stream to stop, or component is unmounted.
      console.warn('[useAgentStream] stopStreaming called but no active agentRunId or component unmounted.');
      return;
    }

    const runIdToStop = agentRunId; // Get the ID of the run to stop.
    console.log(
      `[useAgentStream] User requested to stop streaming for agent run ${runIdToStop}.`,
    );

    // Immediately finalize the local stream state with 'stopped' status.
    // This provides instant UI feedback and cleans up the local EventSource connection.
    finalizeStream('stopped', runIdToStop);

    try {
      // Send a request to the backend API to formally stop the agent run.
      await stopAgent(runIdToStop);
      toast.success('Agent stopped successfully.');
      // `finalizeStream` would have already initiated a message refetch if configured for 'stopped' status.
      // It also might have called `getAgentStatus` internally.
    } catch (err) {
      // An error occurred while trying to tell the backend to stop the agent.
      // The local stream is already considered 'stopped' by `finalizeStream`.
      // This error is primarily for logging and user notification.
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[useAgentStream] Error sending stop request to backend for agent run ${runIdToStop}: ${errorMessage}`,
      );
      toast.error(`Failed to confirm agent stop with server: ${errorMessage}`);
    }
  }, [agentRunId, finalizeStream]); // Dependencies: `agentRunId` (to know which run to stop) and `finalizeStream`.

  return {
    status,
    textContent: orderedTextContent,
    toolCall,
    error,
    agentRunId,
    startStreaming,
    stopStreaming,
  };
}