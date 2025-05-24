'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  Brain,
  Clock,
  Crown,
  Lock,
  Sparkles,
  Zap,
} from 'lucide-react';
import {
  BillingError,
  Project,
  Message as BaseApiMessageType,
} from '@/lib/api';
import { toast } from 'sonner';
import { ChatInput } from '@/components/thread/chat-input/chat-input';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { SiteHeader } from '@/components/thread/thread-site-header';
import {
  ToolCallSidePanel,
  ToolCallInput,
} from '@/components/thread/tool-call-side-panel';
import { useSidebar } from '@/components/ui/sidebar';
import { useAgentStream } from '@/hooks/useAgentStream';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { BillingErrorAlert } from '@/components/billing/usage-limit-alert';
import { isLocalMode } from '@/lib/config';
import { ThreadContent } from '@/components/thread/content/ThreadContent';
import { ThreadSkeleton } from '@/components/thread/content/ThreadSkeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import {
  UnifiedMessage,
  ParsedMetadata,
  ThreadParams,
} from '@/components/thread/types';
import {
  safeJsonParse,
} from '@/components/thread/utils';
import { useThreadQuery } from '@/hooks/react-query/threads/use-threads';
import { useAddUserMessageMutation, useMessagesQuery } from '@/hooks/react-query/threads/use-messages';
import { useProjectQuery } from '@/hooks/react-query/threads/use-project';
import { useAgentRunsQuery, useStartAgentMutation, useStopAgentMutation } from '@/hooks/react-query/threads/use-agent-run';
import { useBillingStatusQuery } from '@/hooks/react-query/threads/use-billing-status';
import { useSubscription, isPlan } from '@/hooks/react-query/subscriptions/use-subscriptions';
import { SubscriptionStatus } from '@/components/thread/chat-input/_use-model-selection';

// Extend the base Message type with the expected database fields
interface ApiMessageType extends BaseApiMessageType {
  message_id?: string;
  thread_id?: string;
  is_llm_message?: boolean;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
}

// Add a simple interface for streaming tool calls
interface StreamingToolCall {
  id?: string;
  name?: string;
  arguments?: string;
  index?: number;
  xml_tag_name?: string;
}

export default function ThreadPage({
  params,
}: {
  params: Promise<ThreadParams>;
}) {
  const unwrappedParams = React.use(params);
  const threadId = unwrappedParams.threadId;
  const isMobile = useIsMobile();
  const searchParams = useSearchParams();

  const router = useRouter();
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<
    'idle' | 'running' | 'connecting' | 'error'
  >('idle');
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallInput[]>([]);
  const [currentToolIndex, setCurrentToolIndex] = useState<number>(0);
  const [autoOpenedPanel, setAutoOpenedPanel] = useState(false);
  const [initialPanelOpenAttempted, setInitialPanelOpenAttempted] =
    useState(false);

  // Billing alert state
  const [showBillingAlert, setShowBillingAlert] = useState(false);
  const [billingData, setBillingData] = useState<{
    currentUsage?: number;
    limit?: number;
    message?: string;
    accountId?: string | null;
  }>({});

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const hasInitiallyScrolled = useRef<boolean>(false);

  const [project, setProject] = useState<Project | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [fileViewerOpen, setFileViewerOpen] = useState(false);
  const [projectName, setProjectName] = useState<string>('');
  const [fileToView, setFileToView] = useState<string | null>(null);

  const initialLoadCompleted = useRef<boolean>(false);
  const messagesLoadedRef = useRef(false);
  const agentRunsCheckedRef = useRef(false);
  const previousAgentStatus = useRef<typeof agentStatus>('idle');

  const [externalNavIndex, setExternalNavIndex] = React.useState<number | undefined>(undefined);

  // Add debug mode state - check for debug=true in URL
  const [debugMode, setDebugMode] = useState(false);

  // Add state for the free tier upgrade dialog
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);

  // --- React Query Hooks ---
  // These hooks from TanStack React Query manage server state, including data fetching,
  // caching, automatic refetching, and mutations for this page.

  /** Fetches basic thread data (like project_id, account_id) for the current `threadId`. */
  const threadQuery = useThreadQuery(threadId);
  /** Fetches the list of messages for the current `threadId`. */
  const messagesQuery = useMessagesQuery(threadId);
  /** Dynamically determines the `projectId` from `threadQuery.data` to fetch associated project details. */
  const projectId = threadQuery.data?.project_id || '';
  /** Fetches project details based on the `projectId`. Enabled only when `projectId` is available. */
  const projectQuery = useProjectQuery(projectId);
  /** Fetches all agent runs associated with the current `threadId`. */
  const agentRunsQuery = useAgentRunsQuery(threadId);
  /** Fetches the overall billing status for the current user/account. */
  const billingStatusQuery = useBillingStatusQuery();
  /** Fetches subscription details for the current user/account. */
  const { data: subscriptionData } = useSubscription();

  /** React Query mutation for adding a user message to the thread. */
  const addUserMessageMutation = useAddUserMessageMutation();
  /** React Query mutation for starting an agent run. */
  const startAgentMutation = useStartAgentMutation();
  /** React Query mutation for stopping an agent run. */
  const stopAgentMutation = useStopAgentMutation();

  const subscriptionStatus: SubscriptionStatus = subscriptionData?.status === 'active'
    ? 'active'
    : 'no_subscription';


  const handleProjectRenamed = useCallback((newName: string) => {
    setProjectName(newName);
  }, []);

  const { state: leftSidebarState, setOpen: setLeftSidebarOpen } = useSidebar();
  const initialLayoutAppliedRef = useRef(false);

  const userClosedPanelRef = useRef(false);

  // Replace both useEffect hooks with a single one that respects user closing
  useEffect(() => {
    if (initialLoadCompleted.current && !initialPanelOpenAttempted) {
      // Only attempt to open panel once on initial load
      setInitialPanelOpenAttempted(true);

      // Open the panel with tool calls if available
      if (toolCalls.length > 0) {
        setIsSidePanelOpen(true);
        setCurrentToolIndex(toolCalls.length - 1);
      } else {
        // Only if there are messages but no tool calls yet
        if (messages.length > 0) {
          setIsSidePanelOpen(true);
        }
      }
    }
  }, [initialPanelOpenAttempted, messages, toolCalls]);

  const toggleSidePanel = useCallback(() => {
    setIsSidePanelOpen((prevIsOpen) => {
      const newState = !prevIsOpen;
      if (!newState) {
        userClosedPanelRef.current = true;
      }
      if (newState) {
        // Close left sidebar when opening side panel
        setLeftSidebarOpen(false);
      }
      return newState;
    });
  }, [setLeftSidebarOpen]);

  const handleSidePanelNavigate = useCallback((newIndex: number) => {
    setCurrentToolIndex(newIndex);
  }, []);

  useEffect(() => {
    if (!initialLayoutAppliedRef.current) {
      setLeftSidebarOpen(false);
      initialLayoutAppliedRef.current = true;
    }
  }, [setLeftSidebarOpen]);

  // Update keyboard shortcut handlers to manage both panels
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // CMD+I for ToolCall SidePanel
      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        event.preventDefault();
        // If side panel is already open, just close it
        if (isSidePanelOpen) {
          setIsSidePanelOpen(false);
          userClosedPanelRef.current = true;
        } else {
          // Open side panel and ensure left sidebar is closed
          setIsSidePanelOpen(true);
          setLeftSidebarOpen(false);
        }
      }

      // CMD+B for Left Sidebar
      if ((event.metaKey || event.ctrlKey) && event.key === 'b') {
        event.preventDefault();
        // If left sidebar is expanded, collapse it
        if (leftSidebarState === 'expanded') {
          setLeftSidebarOpen(false);
        } else {
          // Otherwise expand the left sidebar and close the side panel
          setLeftSidebarOpen(true);
          if (isSidePanelOpen) {
            setIsSidePanelOpen(false);
            userClosedPanelRef.current = true;
          }
        }
      }

      if (event.key === 'Escape' && isSidePanelOpen) {
        setIsSidePanelOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidePanel, isSidePanelOpen, leftSidebarState, setLeftSidebarOpen]);

  const handleNewMessageFromStream = useCallback((message: UnifiedMessage) => {
    // Log the ID of the message received from the stream
    console.log(
      `[STREAM HANDLER] Received message: ID=${message.message_id}, Type=${message.type}`,
    );

    if (!message.message_id) {
      console.warn(
        `[STREAM HANDLER] Received message is missing ID: Type=${message.type}, Content=${message.content?.substring(0, 50)}...`,
      );
    }

    setMessages((prev) => {
      const messageExists = prev.some(
        (m) => m.message_id === message.message_id,
      );
      if (messageExists) {
        return prev.map((m) =>
          m.message_id === message.message_id ? message : m,
        );
      } else {
        return [...prev, message];
      }
    });

    // If we received a tool message, refresh the tool panel
    if (message.type === 'tool') {
      setAutoOpenedPanel(false);
    }
  }, []);

  const handleStreamStatusChange = useCallback((hookStatus: string) => {
    console.log(`[PAGE] Hook status changed: ${hookStatus}`);
    switch (hookStatus) {
      case 'idle':
      case 'completed':
      case 'stopped':
      case 'agent_not_running':
      case 'error':
      case 'failed':
        setAgentStatus('idle');
        setAgentRunId(null);
        // Reset auto-opened state when agent completes to trigger tool detection
        setAutoOpenedPanel(false);

        // After terminal states, we should scroll to bottom to show latest messages
        // The hook will already have refetched messages by this point
        if (
          [
            'completed',
            'stopped',
            'agent_not_running',
            'error',
            'failed',
          ].includes(hookStatus)
        ) {
          scrollToBottom('smooth');
        }
        break;
      case 'connecting':
        setAgentStatus('connecting');
        break;
      case 'streaming':
        setAgentStatus('running');
        break;
    }
  }, []);

  const handleStreamError = useCallback((errorMessage: string) => {
    console.error(`[PAGE] Stream hook error: ${errorMessage}`);
    if (
      !errorMessage.toLowerCase().includes('not found') &&
      !errorMessage.toLowerCase().includes('agent run is not running')
    ) {
      toast.error(`Stream Error: ${errorMessage}`);
    }
  }, []);

  const handleStreamClose = useCallback(() => {
    console.log(`[PAGE] Stream hook closed with final status: ${agentStatus}`);
  }, [agentStatus]);

  const {
    status: streamHookStatus,
    textContent: streamingTextContent,
    toolCall: streamingToolCall,
    error: streamError,
    agentRunId: currentHookRunId,
    startStreaming,
    stopStreaming,
  } = useAgentStream(
    {
      onMessage: handleNewMessageFromStream,
      onStatusChange: handleStreamStatusChange,
      onError: handleStreamError,
      onClose: handleStreamClose,
    },
    threadId,
    setMessages,
  );

  useEffect(() => {
    if (agentRunId && agentRunId !== currentHookRunId) {
      console.log(
        `[PAGE] Target agentRunId set to ${agentRunId}, initiating stream...`,
      );
      startStreaming(agentRunId);
    }
  }, [agentRunId, startStreaming, currentHookRunId]);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isSidePanelOpen) {
      setIsSidePanelOpen(false);
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSidePanelOpen]);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  // Effect to load initial data using React Query
  useEffect(() => {
    let isMounted = true;

    async function initializeData() {
      if (!initialLoadCompleted.current) setIsLoading(true);
      setError(null);

      try {
        if (!threadId) throw new Error('Thread ID is required');

        // Check if we have thread data
        if (threadQuery.isError) {
          throw new Error('Failed to load thread data: ' + threadQuery.error);
        }

        if (!isMounted) return;

        // Process project data when available
        if (projectQuery.data) {
          // Set project data
          setProject(projectQuery.data);

          // Make sure sandbox ID is set correctly
          if (typeof projectQuery.data.sandbox === 'string') {
            setSandboxId(projectQuery.data.sandbox);
          } else if (projectQuery.data.sandbox?.id) {
            setSandboxId(projectQuery.data.sandbox.id);
          }

          setProjectName(projectQuery.data.name || '');
        }

        // Process messages data when available
        if (messagesQuery.data && !messagesLoadedRef.current) {
          // Map API message type to UnifiedMessage type
          const unifiedMessages = (messagesQuery.data || [])
            .filter((msg) => msg.type !== 'status')
            .map((msg: ApiMessageType) => ({
              message_id: msg.message_id || null,
              thread_id: msg.thread_id || threadId,
              type: (msg.type || 'system') as UnifiedMessage['type'],
              is_llm_message: Boolean(msg.is_llm_message),
              content: msg.content || '',
              metadata: msg.metadata || '{}',
              created_at: msg.created_at || new Date().toISOString(),
              updated_at: msg.updated_at || new Date().toISOString(),
            }));

          setMessages(unifiedMessages);
          console.log('[PAGE] Loaded Messages (excluding status, keeping browser_state):', unifiedMessages.length);
          messagesLoadedRef.current = true;

          if (!hasInitiallyScrolled.current) {
            scrollToBottom('auto');
            hasInitiallyScrolled.current = true;
          }
        }

        // Check for active agent runs
        if (agentRunsQuery.data && !agentRunsCheckedRef.current && isMounted) {
          console.log('[PAGE] Checking for active agent runs...');
          agentRunsCheckedRef.current = true;

          const activeRun = agentRunsQuery.data.find((run) => run.status === 'running');
          if (activeRun && isMounted) {
            console.log('[PAGE] Found active run on load:', activeRun.id);
            setAgentRunId(activeRun.id);
          } else {
            console.log('[PAGE] No active agent runs found');
            if (isMounted) setAgentStatus('idle');
          }
        }

        // Mark initialization as complete when we have the core data
        if (threadQuery.data && messagesQuery.data && agentRunsQuery.data) {
          initialLoadCompleted.current = true;
          setIsLoading(false);
        }

      } catch (err) {
        console.error('Error loading thread data:', err);
        if (isMounted) {
          const errorMessage =
            err instanceof Error ? err.message : 'Failed to load thread';
          setError(errorMessage);
          toast.error(errorMessage);
          setIsLoading(false);
        }
      }
    }

    if (threadId) {
      initializeData();
    }

    return () => {
      isMounted = false;
    };
  }, [
    threadId,
    threadQuery.data,
    threadQuery.isError,
    threadQuery.error,
    projectQuery.data,
    messagesQuery.data,
    agentRunsQuery.data
  ]);

  const handleSubmitMessage = useCallback(
    async (
      message: string,
      options?: { model_name?: string; enable_thinking?: boolean },
    ) => {
      if (!message.trim()) return;
      setIsSending(true);

      const optimisticUserMessage: UnifiedMessage = {
        message_id: `temp-${Date.now()}`,
        thread_id: threadId,
        type: 'user',
        is_llm_message: false,
        content: message,
        metadata: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, optimisticUserMessage]);
      setNewMessage('');
      scrollToBottom('smooth');

      try {
        // Use React Query mutations instead of direct API calls
        const messagePromise = addUserMessageMutation.mutateAsync({
          threadId,
          message
        });

        const agentPromise = startAgentMutation.mutateAsync({
          threadId,
          options
        });

        const results = await Promise.allSettled([messagePromise, agentPromise]);

        // Handle failure to add the user message
        if (results[0].status === 'rejected') {
          const reason = results[0].reason;
          console.error("Failed to send message:", reason);
          throw new Error(`Failed to send message: ${reason?.message || reason}`);
        }

        // Handle failure to start the agent
        if (results[1].status === 'rejected') {
          const error = results[1].reason;
          console.error("Failed to start agent:", error);

          // Check if it's our custom BillingError (402)
          if (error instanceof BillingError) {
            console.log("Caught BillingError:", error.detail);
            // Extract billing details
            setBillingData({
              // Note: currentUsage and limit might not be in the detail from the backend yet
              currentUsage: error.detail.currentUsage as number | undefined,
              limit: error.detail.limit as number | undefined,
              message: error.detail.message || 'Monthly usage limit reached. Please upgrade.', // Use message from error detail
              accountId: project?.account_id || null // Pass account ID
            });
            setShowBillingAlert(true);

            // Remove the optimistic message since the agent couldn't start
            setMessages(prev => prev.filter(m => m.message_id !== optimisticUserMessage.message_id));
            return; // Stop further execution in this case
          }

          // Handle other agent start errors
          throw new Error(`Failed to start agent: ${error?.message || error}`);
        }

        // If agent started successfully
        const agentResult = results[1].value;
        setAgentRunId(agentResult.agent_run_id);

        // Refresh queries after successful operations
        messagesQuery.refetch();
        agentRunsQuery.refetch();

      } catch (err) {
        // Catch errors from addUserMessage or non-BillingError agent start errors
        console.error('Error sending message or starting agent:', err);
        // Don't show billing alert here, only for specific BillingError
        if (!(err instanceof BillingError)) {
          toast.error(err instanceof Error ? err.message : 'Operation failed');
        }
        // Ensure optimistic message is removed on any error during submit
        setMessages((prev) =>
          prev.filter((m) => m.message_id !== optimisticUserMessage.message_id),
        );
      } finally {
        setIsSending(false);
      }
    },
    [threadId, project?.account_id, addUserMessageMutation, startAgentMutation, messagesQuery, agentRunsQuery],
  );

  const handleStopAgent = useCallback(async () => {
    console.log(`[PAGE] Requesting agent stop via hook.`);
    setAgentStatus('idle');

    // First stop the streaming and let the hook handle refetching
    await stopStreaming();

    // Use React Query's stopAgentMutation if we have an agent run ID
    if (agentRunId) {
      try {
        await stopAgentMutation.mutateAsync(agentRunId);
        // Refresh agent runs after stopping
        agentRunsQuery.refetch();
      } catch (error) {
        console.error('Error stopping agent:', error);
      }
    }
  }, [stopStreaming, agentRunId, stopAgentMutation, agentRunsQuery]);

  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    const isNewUserMessage = lastMsg?.type === 'user';
    if ((isNewUserMessage || agentStatus === 'running') && !userHasScrolled) {
      scrollToBottom('smooth');
    }
  }, [messages, agentStatus, userHasScrolled]);

  useEffect(() => {
    if (!latestMessageRef.current || messages.length === 0) return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowScrollButton(!entry?.isIntersecting),
      { root: messagesContainerRef.current, threshold: 0.1 },
    );
    observer.observe(latestMessageRef.current);
    return () => observer.disconnect();
  }, [messages, streamingTextContent, streamingToolCall]);

  useEffect(() => {
    console.log(`[PAGE] 🔄 Page AgentStatus: ${agentStatus}, Hook Status: ${streamHookStatus}, Target RunID: ${agentRunId || 'none'}, Hook RunID: ${currentHookRunId || 'none'}`);

    // If the stream hook reports completion/stopping but our UI hasn't updated
    if ((streamHookStatus === 'completed' || streamHookStatus === 'stopped' ||
      streamHookStatus === 'agent_not_running' || streamHookStatus === 'error') &&
      (agentStatus === 'running' || agentStatus === 'connecting')) {
      console.log('[PAGE] Detected hook completed but UI still shows running, updating status');
      setAgentStatus('idle');
      setAgentRunId(null);
      setAutoOpenedPanel(false);
    }
  }, [agentStatus, streamHookStatus, agentRunId, currentHookRunId]);

  const handleOpenFileViewer = useCallback((filePath?: string) => {
    if (filePath) {
      setFileToView(filePath);
    } else {
      setFileToView(null);
    }
    setFileViewerOpen(true);
  }, []);

  // Process the assistant call data
  const toolViewAssistant = useCallback(
    (assistantContent?: string, toolContent?: string) => {
      // This needs to stay simple as it's meant for the side panel tool call view
      if (!assistantContent) return null;

      return (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            Assistant Message
          </div>
          <div className="rounded-md border bg-muted/50 p-3">
            <div className="text-xs prose prose-xs dark:prose-invert chat-markdown max-w-none">{assistantContent}</div>
          </div>
        </div>
      );
    },
    [],
  );

  // Process the tool result data
  const toolViewResult = useCallback(
    (toolContent?: string, isSuccess?: boolean) => {
      if (!toolContent) return null;

      return (
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <div className="text-xs font-medium text-muted-foreground">
              Tool Result
            </div>
            <div
              className={`px-2 py-0.5 rounded-full text-xs ${isSuccess
                ? 'bg-green-50 text-green-700 dark:bg-green-900 dark:text-green-300'
                : 'bg-red-50 text-red-700 dark:bg-red-900 dark:text-red-300'
                }`}
            >
              {isSuccess ? 'Success' : 'Failed'}
            </div>
          </div>
          <div className="rounded-md border bg-muted/50 p-3">
            <div className="text-xs prose prose-xs dark:prose-invert chat-markdown max-w-none">{toolContent}</div>
          </div>
        </div>
      );
    },
    [],
  );

  // Automatically detect and populate tool calls from messages
  useEffect(() => {
    // Calculate historical tool pairs regardless of panel state
    const historicalToolPairs: ToolCallInput[] = [];
    const assistantMessages = messages.filter(m => m.type === 'assistant' && m.message_id);

    assistantMessages.forEach(assistantMsg => {
      const resultMessage = messages.find(toolMsg => {
        if (toolMsg.type !== 'tool' || !toolMsg.metadata || !assistantMsg.message_id) return false;
        try {
          const metadata = JSON.parse(toolMsg.metadata);
          return metadata.assistant_message_id === assistantMsg.message_id;
        } catch (e) {
          return false;
        }
      });

      if (resultMessage) {
        // Determine tool name from assistant message content
        let toolName = 'unknown';
        try {
          // Try to extract tool name from content
          const xmlMatch = assistantMsg.content.match(
            /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>|<([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/,
          );
          if (xmlMatch) {
            toolName = xmlMatch[1] || xmlMatch[2] || 'unknown';
          } else {
            // Fallback to checking for tool_calls JSON structure
            const assistantContentParsed = safeJsonParse<{
              tool_calls?: { name: string }[];
            }>(assistantMsg.content, {});
            if (
              assistantContentParsed.tool_calls &&
              assistantContentParsed.tool_calls.length > 0
            ) {
              toolName = assistantContentParsed.tool_calls[0].name || 'unknown';
            }
          }
        } catch { }

        // Skip adding <ask> tags to the tool calls
        if (toolName === 'ask' || toolName === 'complete') {
          return;
        }

        let isSuccess = true;
        try {
          const toolContent = resultMessage.content?.toLowerCase() || '';
          isSuccess = !(toolContent.includes('failed') ||
            toolContent.includes('error') ||
            toolContent.includes('failure'));
        } catch { }

        historicalToolPairs.push({
          assistantCall: {
            name: toolName,
            content: assistantMsg.content,
            timestamp: assistantMsg.created_at,
          },
          toolResult: {
            content: resultMessage.content,
            isSuccess: isSuccess,
            timestamp: resultMessage.created_at,
          },
        });
      }
    });

    // Always update the toolCalls state
    setToolCalls(historicalToolPairs);

    // Logic to open/update the panel index
    if (historicalToolPairs.length > 0) {
      // If the panel is open (or was just auto-opened) and the user didn't close it
      if (isSidePanelOpen && !userClosedPanelRef.current) {
        // Always jump to the latest tool call index
        setCurrentToolIndex(historicalToolPairs.length - 1);
      } else if (!isSidePanelOpen && !autoOpenedPanel && !userClosedPanelRef.current) {
        // Auto-open the panel only the first time tools are detected
        setCurrentToolIndex(historicalToolPairs.length - 1);
        setIsSidePanelOpen(true);
        setAutoOpenedPanel(true);
      }
    }
  }, [messages, isSidePanelOpen, autoOpenedPanel]); // Rerun when messages or panel state changes

  // Reset auto-opened state when panel is closed
  useEffect(() => {
    if (!isSidePanelOpen) {
      setAutoOpenedPanel(false);
    }
  }, [isSidePanelOpen]);

  // Update handleToolClick to respect user closing preference and navigate correctly
  const handleToolClick = useCallback((clickedAssistantMessageId: string | null, clickedToolName: string) => {
    // Explicitly ignore ask tags from opening the side panel
    if (clickedToolName === 'ask') {
      return;
    }

    if (!clickedAssistantMessageId) {
      console.warn("Clicked assistant message ID is null. Cannot open side panel.");
      toast.warning("Cannot view details: Assistant message ID is missing.");
      return;
    }

    // Reset user closed state when explicitly clicking a tool
    userClosedPanelRef.current = false;

    console.log(
      '[PAGE] Tool Click Triggered. Assistant Message ID:',
      clickedAssistantMessageId,
      'Tool Name:',
      clickedToolName,
    );

    // Find the index of the tool call associated with the clicked assistant message
    const toolIndex = toolCalls.findIndex((tc) => {
      // Check if the assistant message ID matches the one stored in the tool result's metadata
      if (!tc.toolResult?.content || tc.toolResult.content === 'STREAMING')
        return false; // Skip streaming or incomplete calls

      // Directly compare assistant message IDs if available in the structure
      // Find the original assistant message based on the ID
      const assistantMessage = messages.find(
        (m) =>
          m.message_id === clickedAssistantMessageId &&
          m.type === 'assistant',
      );
      if (!assistantMessage) return false;

      // Find the corresponding tool message using metadata
      const toolMessage = messages.find((m) => {
        if (m.type !== 'tool' || !m.metadata) return false;
        try {
          const metadata = safeJsonParse<ParsedMetadata>(m.metadata, {});
          return (
            metadata.assistant_message_id === assistantMessage.message_id
          );
        } catch {
          return false;
        }
      });

      // Check if the current toolCall 'tc' corresponds to this assistant/tool message pair
      return (
        tc.assistantCall?.content === assistantMessage.content &&
        tc.toolResult?.content === toolMessage?.content
      );
    });

    if (toolIndex !== -1) {
      console.log(
        `[PAGE] Found tool call at index ${toolIndex} for assistant message ${clickedAssistantMessageId}`,
      );
      setExternalNavIndex(toolIndex);
      setCurrentToolIndex(toolIndex);
      setIsSidePanelOpen(true); // Explicitly open the panel

      setTimeout(() => setExternalNavIndex(undefined), 100);
    } else {
      console.warn(
        `[PAGE] Could not find matching tool call in toolCalls array for assistant message ID: ${clickedAssistantMessageId}`,
      );
      toast.info('Could not find details for this tool call.');
      // Optionally, still open the panel but maybe at the last index or show a message?
      // setIsSidePanelOpen(true);
    }
  },
    [messages, toolCalls],
  ); // Add toolCalls as a dependency

  // Handle streaming tool calls
  const handleStreamingToolCall = useCallback(
    (toolCall: StreamingToolCall | null) => {
      if (!toolCall) return;

      const toolName = toolCall.name || toolCall.xml_tag_name || 'Unknown Tool';

      // Skip <ask> tags from showing in the side panel during streaming
      if (toolName === 'ask' || toolName === 'complete') {
        return;
      }

      console.log('[STREAM] Received tool call:', toolName);

      // If user explicitly closed the panel, don't reopen it for streaming calls
      if (userClosedPanelRef.current) return;

      // Create a properly formatted tool call input for the streaming tool
      // that matches the format of historical tool calls
      const toolArguments = toolCall.arguments || '';

      // Format the arguments in a way that matches the expected XML format for each tool
      // This ensures the specialized tool views render correctly
      let formattedContent = toolArguments;
      if (
        toolName.toLowerCase().includes('command') &&
        !toolArguments.includes('<execute-command>')
      ) {
        formattedContent = `<execute-command>${toolArguments}</execute-command>`;
      } else if (
        toolName.toLowerCase().includes('file') &&
        !toolArguments.includes('<create-file>')
      ) {
        // For file operations, wrap with appropriate tag if not already wrapped
        const fileOpTags = ['create-file', 'delete-file', 'full-file-rewrite'];
        const matchingTag = fileOpTags.find((tag) =>
          toolName.toLowerCase().includes(tag),
        );
        if (matchingTag && !toolArguments.includes(`<${matchingTag}>`)) {
          formattedContent = `<${matchingTag}>${toolArguments}</${matchingTag}>`;
        }
      }

      const newToolCall: ToolCallInput = {
        assistantCall: {
          name: toolName,
          content: formattedContent,
          timestamp: new Date().toISOString(),
        },
        // For streaming tool calls, provide empty content that indicates streaming
        toolResult: {
          content: 'STREAMING',
          isSuccess: true,
          timestamp: new Date().toISOString(),
        },
      };

      // Update the tool calls state to reflect the streaming tool
      setToolCalls((prev) => {
        // If the same tool is already being streamed, update it instead of adding a new one
        if (prev.length > 0 && prev[0].assistantCall.name === toolName) {
          return [
            {
              ...prev[0],
              assistantCall: {
                ...prev[0].assistantCall,
                content: formattedContent,
              },
            },
          ];
        }
        return [newToolCall];
      });

      setCurrentToolIndex(0);
      setIsSidePanelOpen(true);
    },
    [],
  );

  // SEO title update
  useEffect(() => {
    if (projectName) {
      // Update document title when project name changes
      document.title = `${projectName} | Kortix Suna`;

      // Update meta tags for SEO
      const metaDescription = document.querySelector(
        'meta[name="description"]',
      );
      if (metaDescription) {
        metaDescription.setAttribute(
          'content',
          `${projectName} - Interactive agent conversation powered by Kortix Suna`,
        );
      }

      // Update OpenGraph tags if they exist
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        ogTitle.setAttribute('content', `${projectName} | Kortix Suna`);
      }

      const ogDescription = document.querySelector(
        'meta[property="og:description"]',
      );
      if (ogDescription) {
        ogDescription.setAttribute(
          'content',
          `Interactive AI conversation for ${projectName}`,
        );
      }
    }
  }, [projectName]);

  // Update messages when they change in the query
  useEffect(() => {
    if (messagesQuery.data && messagesQuery.status === 'success') {
      // Only update if we're not in initial loading and the agent isn't running
      if (!isLoading && agentStatus !== 'running' && agentStatus !== 'connecting') {
        // Map API message type to UnifiedMessage type
        const unifiedMessages = (messagesQuery.data || [])
          .filter((msg) => msg.type !== 'status')
          .map((msg: ApiMessageType) => ({
            message_id: msg.message_id || null,
            thread_id: msg.thread_id || threadId,
            type: (msg.type || 'system') as UnifiedMessage['type'],
            is_llm_message: Boolean(msg.is_llm_message),
            content: msg.content || '',
            metadata: msg.metadata || '{}',
            created_at: msg.created_at || new Date().toISOString(),
            updated_at: msg.updated_at || new Date().toISOString(),
          }));

        setMessages(unifiedMessages);
        // Reset auto-opened panel to allow tool detection with fresh messages
        setAutoOpenedPanel(false);
        scrollToBottom('smooth');
      }
    }
  }, [messagesQuery.data, messagesQuery.status, isLoading, agentStatus, threadId]);

  // Check billing status and handle billing limit
  const checkBillingLimits = useCallback(async () => {
    // Skip billing checks in local development mode
    if (isLocalMode()) {
      console.log(
        'Running in local development mode - billing checks are disabled',
      );
      return false;
    }

    try {
      // Use React Query to get billing status
      await billingStatusQuery.refetch();
      const result = billingStatusQuery.data;

      if (result && !result.can_run) {
        setBillingData({
          currentUsage: result.subscription?.minutes_limit || 0,
          limit: result.subscription?.minutes_limit || 0,
          message: result.message || 'Usage limit reached',
          accountId: project?.account_id || null,
        });
        setShowBillingAlert(true);
        return true;
      }
      return false;
    } catch (err) {
      console.error('Error checking billing status:', err);
      return false;
    }
  }, [project?.account_id, billingStatusQuery]);

  useEffect(() => {
    const previousStatus = previousAgentStatus.current;

    // Check if agent just completed (status changed from running to idle)
    if (previousStatus === 'running' && agentStatus === 'idle') {
      checkBillingLimits();
    }

    // Store current status for next comparison
    previousAgentStatus.current = agentStatus;
  }, [agentStatus, checkBillingLimits]);

  useEffect(() => {
    if (project?.account_id && initialLoadCompleted.current && !billingStatusQuery.data) {
      console.log('Checking billing status on initial load');
      checkBillingLimits();
    }
  }, [project?.account_id, checkBillingLimits, initialLoadCompleted, billingStatusQuery.data]);

  useEffect(() => {
    const debugParam = searchParams.get('debug');
    setDebugMode(debugParam === 'true');
  }, [searchParams]);


  useEffect(() => {
    if (initialLoadCompleted.current && subscriptionData) {
      const hasSeenUpgradeDialog = localStorage.getItem('suna_upgrade_dialog_displayed');
      const isFreeTier = subscriptionStatus === 'no_subscription';
      if (!hasSeenUpgradeDialog && isFreeTier && !isLocalMode()) {
        setShowUpgradeDialog(true);
      }
    }
  }, [subscriptionData, subscriptionStatus, initialLoadCompleted.current]);

  const handleDismissUpgradeDialog = () => {
    setShowUpgradeDialog(false);
    localStorage.setItem('suna_upgrade_dialog_displayed', 'true');
  };

  const handleUpgradeClick = () => {
    router.push('/settings/billing');
    setShowUpgradeDialog(false);
    localStorage.setItem('suna_upgrade_dialog_displayed', 'true'); // Mark as shown for this session.
  };

  /** Handles the click on the "Upgrade Now" button in the dialog, redirecting the user to the billing page. */
  const handleUpgradeClick = () => {
    router.push('/settings/billing'); // Navigate to billing settings.
    setShowUpgradeDialog(false);
    localStorage.setItem('suna_upgrade_dialog_displayed', 'true');
  };

  if (!initialLoadCompleted.current || isLoading) {
    return <ThreadSkeleton isSidePanelOpen={isSidePanelOpen} />;
  } else if (error) {
    return (
      <div className="flex h-screen">
        <div
          className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${(isSidePanelOpen && initialLoadCompleted.current) ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]' : ''}`}
        >
          <SiteHeader
            threadId={threadId}
            projectName={projectName}
            projectId={project?.id || ''}
            onViewFiles={handleOpenFileViewer}
            onToggleSidePanel={toggleSidePanel}
            isMobileView={isMobile}
            debugMode={debugMode}
          />
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-6 text-center">
              <div className="rounded-full bg-destructive/10 p-3">
                <AlertTriangle className="h-6 w-6 text-destructive" />
              </div>
              <h2 className="text-lg font-semibold text-destructive">
                Thread Not Found
              </h2>
              <p className="text-sm text-muted-foreground">
                {error.includes(
                  'JSON object requested, multiple (or no) rows returned',
                )
                  ? 'This thread either does not exist or you do not have access to it.'
                  : error
                }
              </p>
            </div>
          </div>
        </div>
        <ToolCallSidePanel
          isOpen={isSidePanelOpen && initialLoadCompleted.current}
          onClose={() => {
            setIsSidePanelOpen(false);
            userClosedPanelRef.current = true;
            setAutoOpenedPanel(true);
          }}
          toolCalls={toolCalls}
          messages={messages as ApiMessageType[]}
          externalNavigateToIndex={externalNavIndex}
          agentStatus={agentStatus}
          currentIndex={currentToolIndex}
          onNavigate={handleSidePanelNavigate}
          project={project || undefined}
          renderAssistantMessage={toolViewAssistant}
          renderToolResult={toolViewResult}
          isLoading={!initialLoadCompleted.current || isLoading}
        />

        {
          sandboxId && (
            <FileViewerModal
              open={fileViewerOpen}
              onOpenChange={setFileViewerOpen}
              sandboxId={sandboxId}
              initialFilePath={fileToView}
              project={project || undefined}
            />
          )
        }

        {/* Billing Alert for usage limit */}
        <BillingErrorAlert
          message={billingData.message}
          currentUsage={billingData.currentUsage}
          limit={billingData.limit}
          accountId={billingData.accountId}
          onDismiss={() => setShowBillingAlert(false)}
          isOpen={showBillingAlert}
        />
      </div>
    );
  } else {
    return (
      <div className="flex h-screen">
        {/* Render debug mode indicator when active */}
        {debugMode && (
          <div className="fixed top-16 right-4 bg-amber-500 text-black text-xs px-2 py-1 rounded-md shadow-md z-50">
            Debug Mode
          </div>
        )}
        <div
          className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${(!initialLoadCompleted.current || isSidePanelOpen) ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]' : ''}`}
        >
          <SiteHeader
            threadId={threadId}
            projectName={projectName}
            projectId={project?.id || ''}
            onViewFiles={handleOpenFileViewer}
            onToggleSidePanel={toggleSidePanel}
            onProjectRenamed={handleProjectRenamed}
            isMobileView={isMobile}
            debugMode={debugMode}
          />

          {/* Pass debugMode to ThreadContent component */}
          <ThreadContent
            messages={messages}
            streamingTextContent={streamingTextContent}
            streamingToolCall={streamingToolCall}
            agentStatus={agentStatus}
            handleToolClick={handleToolClick}
            handleOpenFileViewer={handleOpenFileViewer}
            readOnly={false}
            streamHookStatus={streamHookStatus}
            sandboxId={sandboxId}
            project={project}
            debugMode={debugMode}
          />

          <div
            className={cn(
              "fixed bottom-0 z-10 bg-gradient-to-t from-background via-background/90 to-transparent px-4 pt-8 transition-all duration-200 ease-in-out",
              leftSidebarState === 'expanded' ? 'left-[72px] lg:left-[256px]' : 'left-[72px]',
              isSidePanelOpen ? 'right-[90%] sm:right-[450px] md:right-[500px] lg:right-[550px] xl:right-[650px]' : 'right-0',
              isMobile ? 'left-0 right-0' : ''
            )}>
            <div className={cn(
              "mx-auto",
              isMobile ? "w-full px-4" : "max-w-3xl"
            )}>
              <ChatInput
                value={newMessage}
                onChange={setNewMessage}
                onSubmit={handleSubmitMessage}
                placeholder="Ask Suna anything..."
                loading={isSending}
                disabled={isSending || agentStatus === 'running' || agentStatus === 'connecting'}
                isAgentRunning={agentStatus === 'running' || agentStatus === 'connecting'}
                onStopAgent={handleStopAgent}
                autoFocus={!isLoading}
                onFileBrowse={handleOpenFileViewer}
                sandboxId={sandboxId || undefined}
              />
            </div>
          </div>
        </div>

        <ToolCallSidePanel
          isOpen={isSidePanelOpen && initialLoadCompleted.current}
          onClose={() => {
            setIsSidePanelOpen(false);
            userClosedPanelRef.current = true;
            setAutoOpenedPanel(true);
          }}
          toolCalls={toolCalls}
          messages={messages as ApiMessageType[]}
          externalNavigateToIndex={externalNavIndex}
          agentStatus={agentStatus}
          currentIndex={currentToolIndex}
          onNavigate={handleSidePanelNavigate}
          project={project || undefined}
          renderAssistantMessage={toolViewAssistant}
          renderToolResult={toolViewResult}
          isLoading={!initialLoadCompleted.current || isLoading}
        />

        {sandboxId && (
          <FileViewerModal
            open={fileViewerOpen}
            onOpenChange={setFileViewerOpen}
            sandboxId={sandboxId}
            initialFilePath={fileToView}
            project={project || undefined}
          />
        )}

        <BillingErrorAlert
          message={billingData.message}
          currentUsage={billingData.currentUsage}
          limit={billingData.limit}
          accountId={billingData.accountId}
          onDismiss={() => setShowBillingAlert(false)}
          isOpen={showBillingAlert}
        />

        <Dialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
          <DialogContent onPointerDownOutside={(e) => e.preventDefault()} className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center">
                <Crown className="h-5 w-5 mr-2 text-primary" />
                Unlock the Full Suna Experience
              </DialogTitle>
              <DialogDescription>
                You're currently using Suna's free tier with limited capabilities.
                Upgrade now to access our most powerful AI model.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4">
              <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">Pro Benefits</h3>

              <div className="space-y-3">
                <div className="flex items-start">
                  <div className="rounded-full bg-secondary/10 p-2 flex-shrink-0 mt-0.5">
                    <Brain className="h-4 w-4 text-secondary" />
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">Advanced AI Models</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Get access to advanced models suited for complex tasks</p>
                  </div>
                </div>

                <div className="flex items-start">
                  <div className="rounded-full bg-secondary/10 p-2 flex-shrink-0 mt-0.5">
                    <Zap className="h-4 w-4 text-secondary" />
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">Faster Responses</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Get access to faster models that breeze through your tasks</p>
                  </div>
                </div>

                <div className="flex items-start">
                  <div className="rounded-full bg-secondary/10 p-2 flex-shrink-0 mt-0.5">
                    <Clock className="h-4 w-4 text-secondary" />
                  </div>
                  <div className="ml-3">
                    <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">Higher Usage Limits</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Enjoy more conversations and longer run durations</p>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter className="flex gap-2">
              <Button variant="outline" onClick={handleDismissUpgradeDialog}>
                Maybe Later
              </Button>
              <Button onClick={handleUpgradeClick}>
                <Sparkles className="h-4 w-4" />
                Upgrade Now
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }
}