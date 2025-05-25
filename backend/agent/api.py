from fastapi import APIRouter, HTTPException, Depends, Request, Body, File, UploadFile, Form
from fastapi.responses import StreamingResponse
import asyncio
import json
import traceback
from datetime import datetime, timezone
import uuid
from typing import Optional, List, Dict, Any
import jwt
from pydantic import BaseModel
import tempfile
import os

from agentpress.thread_manager import ThreadManager
from services.supabase import DBConnection
from services import redis
from agent.run import run_agent
from utils.auth_utils import get_current_user_id_from_jwt, get_user_id_from_stream_auth, verify_thread_access
from utils.logger import logger
from services.billing import check_billing_status, can_use_model
from utils.config import config
from sandbox.sandbox import create_sandbox, get_or_start_sandbox
from services.llm import make_llm_api_call
from run_agent_background import run_agent_background, _cleanup_redis_response_list, update_agent_run_status
from utils.constants import MODEL_NAME_ALIASES
# Initialize shared resources
router = APIRouter()

# db: Represents the global Supabase database client connection.
# This is initialized by the main application (FastAPI lifespan event) and passed to the agent API via `initialize()`.
# All database operations within the agent API will use this shared client instance.
db = None

# instance_id: A unique identifier for this specific backend server instance.
# In a distributed environment where multiple backend instances might be running,
# this ID helps in managing resources (like Redis keys or tracking active agent runs)
# that are specific to this particular instance. It's generated during `initialize()`.
instance_id = None # Global instance ID for this backend instance

# TTL for Redis response lists (24 hours)
# Defines how long the list of responses for an agent run should persist in Redis.
REDIS_RESPONSE_LIST_TTL = 3600 * 24


class AgentStartRequest(BaseModel):
    model_name: Optional[str] = None  # Will be set from config.MODEL_TO_USE in the endpoint
    enable_thinking: Optional[bool] = False
    reasoning_effort: Optional[str] = 'low'
    stream: Optional[bool] = True
    enable_context_manager: Optional[bool] = False

class InitiateAgentResponse(BaseModel):
    thread_id: str
    agent_run_id: Optional[str] = None

def initialize(
    _db: DBConnection,
    _instance_id: str = None
):
    """
    Initialize the agent API with shared resources, primarily the database connection
    and a unique identifier for this backend instance.

    This function is typically called once at application startup (e.g., via FastAPI's lifespan events)
    to inject dependencies from the main application context into this agent API module.

    Args:
        _db (DBConnection): The initialized Supabase database connection client.
        _instance_id (str, optional): A specific ID to use for this backend instance. 
                                      If None, a new UUID will be generated.
    """
    global db, instance_id
    # Store the provided database client globally for use by API endpoints.
    db = _db

    # Use provided instance_id or generate a new one
    if _instance_id:
        instance_id = _instance_id
    else:
        # Generate instance ID
        instance_id = str(uuid.uuid4())[:8]

    logger.info(f"Initialized agent API with instance ID: {instance_id}")

    # Note: The Redis client (`services.redis`) is expected to be initialized
    # separately, typically in the main application's lifespan events,
    # similar to how the database connection is handled.

async def cleanup():
    """
    Clean up resources when the application shuts down.
    
    This involves:
    1. Identifying agent runs that were being managed by this specific backend instance.
    2. For each such agent run, calling `stop_agent_run` to mark it as stopped/failed 
       and notify any listeners. This is important to prevent runs from appearing "stuck"
       in a running state if the server instance crashes or is restarted.
    3. Closing the global Redis connection.
    """
    logger.info("Starting cleanup of agent API resources")

    # Use the global `instance_id` to find Redis keys representing active agent runs
    # managed by this particular backend instance.
    try:
        if instance_id: # Ensure instance_id was set during initialization.
            # Pattern for Redis keys: "active_run:{instance_id}:{agent_run_id}"
            running_keys = await redis.keys(f"active_run:{instance_id}:*")
            logger.info(f"Found {len(running_keys)} running agent runs for instance {instance_id} to clean up")

            for key in running_keys:
                # Key format is expected to be "active_run:{instance_id}:{agent_run_id}"
                parts = key.split(":")
                if len(parts) == 3:
                    agent_run_id = parts[2]
                    # Call stop_agent_run to gracefully terminate the agent run.
                    # This includes updating its status in the DB and publishing STOP signals.
                    await stop_agent_run(agent_run_id, error_message=f"Instance {instance_id} shutting down")
                else:
                    # Log a warning if an active_run key has an unexpected format.
                    logger.warning(f"Unexpected active_run key format found: {key}")
        else:
            logger.warning("Instance ID not set, cannot clean up instance-specific agent runs.")

    except Exception as e:
        # Catch any errors during the cleanup of agent runs (e.g., Redis connection issues).
        logger.error(f"Failed to clean up running agent runs: {str(e)}")

    # Close the shared Redis connection.
    await redis.close()
    logger.info("Completed cleanup of agent API resources (including Redis connection closure)")

async def stop_agent_run(agent_run_id: str, error_message: Optional[str] = None):
    """
    Stops an agent run by updating its status in the database, publishing a stop signal
    to relevant Redis channels, and cleaning up associated Redis resources.

    This function orchestrates a graceful shutdown of an agent run, ensuring that:
    - Its final state (stopped or failed) is recorded.
    - All components listening to this run (e.g., streaming clients) are notified.
    - Temporary Redis data for the run is cleared.

    Args:
        agent_run_id (str): The ID of the agent run to stop.
        error_message (Optional[str]): If provided, the agent run is marked as "failed"
                                       with this message. Otherwise, it's marked as "stopped".
    """
    logger.info(f"Stopping agent run: {agent_run_id} with error: {error_message if error_message else 'None'}")
    client = await db.client
    final_status = "failed" if error_message else "stopped"

    # 1. Attempt to fetch final responses from the Redis list.
    # These responses are accumulated during the agent's execution and might be needed
    # to persist the complete interaction history in the database.
    response_list_key = f"agent_run:{agent_run_id}:responses"
    all_responses = []
    try:
        all_responses_json = await redis.lrange(response_list_key, 0, -1)
        all_responses = [json.loads(r) for r in all_responses_json]
        logger.info(f"Fetched {len(all_responses)} responses from Redis for DB update on stop/fail for run {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to fetch responses from Redis for run {agent_run_id} during stop/fail: {e}")
        # If fetching from Redis fails, we proceed without these responses for the DB update,
        # as the primary goal is to mark the run as stopped/failed.

    # 2. Update the agent run status in the Supabase database.
    # This records the final state of the agent run along with any error message and collected responses.
    update_success = await update_agent_run_status(
        client, agent_run_id, final_status, error=error_message, responses=all_responses
    )

    if not update_success:
        # Log an error if the database update fails, but continue with Redis signaling
        # as other parts of the system might rely on the STOP signal.
        logger.error(f"Failed to update database status for stopped/failed run {agent_run_id}")

    # 3. Send a "STOP" signal to the global Redis Pub/Sub control channel for this agent run.
    # This channel is used by components that need to know about the termination of this specific run,
    # regardless of which backend instance was managing it.
    global_control_channel = f"agent_run:{agent_run_id}:control"
    try:
        await redis.publish(global_control_channel, "STOP")
        logger.debug(f"Published STOP signal to global control channel {global_control_channel} for run {agent_run_id}")
    except Exception as e:
        logger.error(f"Failed to publish STOP signal to global control channel {global_control_channel} for run {agent_run_id}: {str(e)}")

    # 4. Find all backend instances that might be actively handling this agent run
    # (e.g., streaming its output) and send a "STOP" signal to their instance-specific control channels.
    # This is crucial in a distributed setup to ensure all streaming connections related to this
    # agent run are properly terminated.
    try:
        # Redis keys like "active_run:{instance_id}:{agent_run_id}" indicate an instance is managing the run.
        instance_keys = await redis.keys(f"active_run:*:{agent_run_id}")
        logger.debug(f"Found {len(instance_keys)} active instance keys for agent run {agent_run_id} to send STOP signal.")

        for key in instance_keys:
            parts = key.split(":") # Expected format: active_run:{instance_id}:{agent_run_id}
            if len(parts) == 3:
                instance_id_from_key = parts[1]
                # Instance-specific channel: "agent_run:{agent_run_id}:control:{instance_id}"
                instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id_from_key}"
                try:
                    await redis.publish(instance_control_channel, "STOP")
                    logger.debug(f"Published STOP signal to instance channel {instance_control_channel} for run {agent_run_id}")
                except Exception as e:
                    logger.warning(f"Failed to publish STOP signal to instance channel {instance_control_channel} for run {agent_run_id}: {str(e)}")
            else:
                 logger.warning(f"Unexpected active_run key format found while stopping: {key}")
        
        # 5. Clean up the Redis response list associated with this agent run.
        # Since the run is stopping, these temporary responses are no longer needed in Redis.
        # The `_cleanup_redis_response_list` function (defined in run_agent_background.py) handles this.
        await _cleanup_redis_response_list(agent_run_id)

    except Exception as e:
        logger.error(f"Failed to find or signal active instances for agent run {agent_run_id}: {str(e)}")

    logger.info(f"Successfully initiated stop process for agent run: {agent_run_id}")

# async def restore_running_agent_runs():
#     """Mark agent runs that were still 'running' in the database as failed and clean up Redis resources."""
#     logger.info("Restoring running agent runs after server restart")
#     client = await db.client
#     running_agent_runs = await client.table('agent_runs').select('id').eq("status", "running").execute()

#     for run in running_agent_runs.data:
#         agent_run_id = run['id']
#         logger.warning(f"Found running agent run {agent_run_id} from before server restart")

#         # Clean up Redis resources for this run
#         try:
#             # Clean up active run key
#             active_run_key = f"active_run:{instance_id}:{agent_run_id}"
#             await redis.delete(active_run_key)

#             # Clean up response list
#             response_list_key = f"agent_run:{agent_run_id}:responses"
#             await redis.delete(response_list_key)

#             # Clean up control channels
#             control_channel = f"agent_run:{agent_run_id}:control"
#             instance_control_channel = f"agent_run:{agent_run_id}:control:{instance_id}"
#             await redis.delete(control_channel)
#             await redis.delete(instance_control_channel)

#             logger.info(f"Cleaned up Redis resources for agent run {agent_run_id}")
#         except Exception as e:
#             logger.error(f"Error cleaning up Redis resources for agent run {agent_run_id}: {e}")

#         # Call stop_agent_run to handle status update and cleanup
#         await stop_agent_run(agent_run_id, error_message="Server restarted while agent was running")

async def check_for_active_project_agent_run(client, project_id: str):
    """
    Check if there is an active agent run for any thread in the given project.
    If found, returns the ID of the active run, otherwise returns None.
    """
    project_threads = await client.table('threads').select('thread_id').eq('project_id', project_id).execute()
    project_thread_ids = [t['thread_id'] for t in project_threads.data]

    if project_thread_ids:
        active_runs = await client.table('agent_runs').select('id').in_('thread_id', project_thread_ids).eq('status', 'running').execute()
        if active_runs.data and len(active_runs.data) > 0:
            return active_runs.data[0]['id']
    return None

async def get_agent_run_with_access_check(client, agent_run_id: str, user_id: str):
    """Get agent run data after verifying user access."""
    agent_run = await client.table('agent_runs').select('*').eq('id', agent_run_id).execute()
    if not agent_run.data:
        raise HTTPException(status_code=404, detail="Agent run not found")

    agent_run_data = agent_run.data[0]
    thread_id = agent_run_data['thread_id']
    await verify_thread_access(client, thread_id, user_id)
    return agent_run_data

@router.post("/thread/{thread_id}/agent/start")
async def start_agent(
    thread_id: str,
    body: AgentStartRequest = Body(...),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """Start an agent for a specific thread in the background."""
    global instance_id # Ensure instance_id is accessible
    if not instance_id:
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Use model from config if not specified in the request
    model_name = body.model_name
    logger.info(f"Original model_name from request: {model_name}")

    if model_name is None:
        model_name = config.MODEL_TO_USE
        logger.info(f"Using model from config: {model_name}")

    # Log the model name after alias resolution
    resolved_model = MODEL_NAME_ALIASES.get(model_name, model_name)
    logger.info(f"Resolved model name: {resolved_model}")

    # Update model_name to use the resolved version
    model_name = resolved_model

    logger.info(f"Starting new agent for thread: {thread_id} with config: model={model_name}, thinking={body.enable_thinking}, effort={body.reasoning_effort}, stream={body.stream}, context_manager={body.enable_context_manager} (Instance: {instance_id})")
    client = await db.client

    await verify_thread_access(client, thread_id, user_id)
    thread_result = await client.table('threads').select('project_id', 'account_id').eq('thread_id', thread_id).execute()
    if not thread_result.data:
        raise HTTPException(status_code=404, detail="Thread not found")
    thread_data = thread_result.data[0]
    project_id = thread_data.get('project_id')
    account_id = thread_data.get('account_id')

    can_use, model_message, allowed_models = await can_use_model(client, account_id, model_name)
    if not can_use:
        raise HTTPException(status_code=403, detail={"message": model_message, "allowed_models": allowed_models})

    can_run, message, subscription = await check_billing_status(client, account_id)
    if not can_run:
        raise HTTPException(status_code=402, detail={"message": message, "subscription": subscription})

    active_run_id = await check_for_active_project_agent_run(client, project_id)
    if active_run_id:
        logger.info(f"Stopping existing agent run {active_run_id} for project {project_id}")
        await stop_agent_run(active_run_id)

    try:
        # Get project data to find sandbox ID
        project_result = await client.table('projects').select('*').eq('project_id', project_id).execute()
        if not project_result.data:
            raise HTTPException(status_code=404, detail="Project not found")
        
        project_data = project_result.data[0]
        sandbox_info = project_data.get('sandbox', {})
        if not sandbox_info.get('id'):
            raise HTTPException(status_code=404, detail="No sandbox found for this project")
            
        sandbox_id = sandbox_info['id']
        sandbox = await get_or_start_sandbox(sandbox_id)
        logger.info(f"Successfully started sandbox {sandbox_id} for project {project_id}")
    except Exception as e:
        logger.error(f"Failed to start sandbox for project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to initialize sandbox: {str(e)}")

    agent_run = await client.table('agent_runs').insert({
        "thread_id": thread_id, "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat()
    }).execute()
    agent_run_id = agent_run.data[0]['id']
    logger.info(f"Created new agent run: {agent_run_id}")

    # Register this run in Redis with TTL using instance ID
    instance_key = f"active_run:{instance_id}:{agent_run_id}"
    try:
        await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
    except Exception as e:
        logger.warning(f"Failed to register agent run in Redis ({instance_key}): {str(e)}")

    # Run the agent in the background
    run_agent_background.send(
        agent_run_id=agent_run_id, thread_id=thread_id, instance_id=instance_id,
        project_id=project_id,
        model_name=model_name,  # Already resolved above
        enable_thinking=body.enable_thinking, reasoning_effort=body.reasoning_effort,
        stream=body.stream, enable_context_manager=body.enable_context_manager
    )

    return {"agent_run_id": agent_run_id, "status": "running"}

@router.post("/agent-run/{agent_run_id}/stop")
async def stop_agent(agent_run_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Stop a running agent."""
    logger.info(f"Received request to stop agent run: {agent_run_id}")
    client = await db.client
    await get_agent_run_with_access_check(client, agent_run_id, user_id)
    await stop_agent_run(agent_run_id)
    return {"status": "stopped"}

@router.get("/thread/{thread_id}/agent-runs")
async def get_agent_runs(thread_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Get all agent runs for a thread."""
    logger.info(f"Fetching agent runs for thread: {thread_id}")
    client = await db.client
    await verify_thread_access(client, thread_id, user_id)
    agent_runs = await client.table('agent_runs').select('*').eq("thread_id", thread_id).order('created_at', desc=True).execute()
    logger.debug(f"Found {len(agent_runs.data)} agent runs for thread: {thread_id}")
    return {"agent_runs": agent_runs.data}

@router.get("/agent-run/{agent_run_id}")
async def get_agent_run(agent_run_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    """Get agent run status and responses."""
    logger.info(f"Fetching agent run details: {agent_run_id}")
    client = await db.client
    agent_run_data = await get_agent_run_with_access_check(client, agent_run_id, user_id)
    # Note: Responses are not included here by default, they are in the stream or DB
    return {
        "id": agent_run_data['id'],
        "threadId": agent_run_data['thread_id'],
        "status": agent_run_data['status'],
        "startedAt": agent_run_data['started_at'],
        "completedAt": agent_run_data['completed_at'],
        "error": agent_run_data['error']
    }

@router.get("/agent-run/{agent_run_id}/stream")
async def stream_agent_run(
    agent_run_id: str,
    token: Optional[str] = None,
    request: Request = None
):
    """Stream the responses of an agent run using Redis Lists and Pub/Sub."""
    logger.info(f"Starting stream for agent run: {agent_run_id}")
    client = await db.client # Get Supabase client.

    # Authenticate and authorize the user for streaming.
    # `get_user_id_from_stream_auth` handles token validation from query param or request.
    user_id = await get_user_id_from_stream_auth(request, token)
    # `get_agent_run_with_access_check` verifies the user has access to the thread associated with this agent run.
    agent_run_data = await get_agent_run_with_access_check(client, agent_run_id, user_id)

    # Define Redis keys and channels for this specific agent run:
    # `response_list_key`: Key for the Redis list storing all response chunks for this run.
    #   Used to catch up clients that connect mid-stream and to persist responses temporarily.
    response_list_key = f"agent_run:{agent_run_id}:responses"
    # `response_channel`: Redis Pub/Sub channel where "new" messages are published when new responses are added to the list.
    #   Allows real-time notification for connected clients.
    response_channel = f"agent_run:{agent_run_id}:new_response"
    # `control_channel`: Global Redis Pub/Sub channel for control signals (e.g., "STOP", "ERROR") for this run.
    #   Used to signal termination or critical errors to all listeners.
    control_channel = f"agent_run:{agent_run_id}:control" 

    async def stream_generator():
        """
        An asynchronous generator that yields Server-Sent Events (SSE) for an agent run.
        It combines fetching historical data from a Redis list with real-time updates via Pub/Sub.
        """
        logger.debug(f"Streaming responses for {agent_run_id} using Redis list {response_list_key} and channel {response_channel}")
        
        # `last_processed_index`: Tracks the last index fetched from the Redis response list.
        # This ensures that when new messages arrive via Pub/Sub, only newer messages are fetched from the list.
        last_processed_index = -1
        pubsub_response = None  # For listening to new response notifications.
        pubsub_control = None   # For listening to control signals (STOP, ERROR).
        listener_task = None    # asyncio.Task for running Pub/Sub listeners concurrently.
        terminate_stream = False # Flag to signal the generator to stop.
        
        # `initial_yield_complete`: Flag to track if the initial batch of historical responses
        # has been yielded. This is important for error handling; if an error occurs
        # *before* this is True, an error message is yielded. Otherwise, the stream might just end.
        initial_yield_complete = False

        try:
            # Step 1: Fetch and yield initial (historical) responses from the Redis list.
            # This ensures that a client connecting to an ongoing stream gets all previous messages.
            initial_responses_json = await redis.lrange(response_list_key, 0, -1)
            initial_responses = []
            if initial_responses_json:
                initial_responses = [json.loads(r) for r in initial_responses_json]
                logger.debug(f"Sending {len(initial_responses)} initial responses for {agent_run_id}")
                for response in initial_responses:
                    yield f"data: {json.dumps(response)}\n\n" # Yield each response as an SSE.
                last_processed_index = len(initial_responses) - 1 # Update the last processed index.
            initial_yield_complete = True # Mark that initial yielding is done.

            # Step 2: Check the current status of the agent run from the database *after* yielding initial data.
            # If the run is already completed, stopped, or failed, there's no need to set up Pub/Sub.
            run_status_query = await client.table('agent_runs').select('status').eq("id", agent_run_id).maybe_single().execute()
            current_status = run_status_query.data.get('status') if run_status_query.data else None

            if current_status != 'running':
                logger.info(f"Agent run {agent_run_id} is not running (status: {current_status}). Ending stream after initial yield.")
                # Send a final status based on the DB, e.g., 'completed' or 'failed'.
                final_status_event = {'type': 'status', 'status': current_status if current_status else 'completed'}
                yield f"data: {json.dumps(final_status_event)}\n\n"
                return # End the stream.

            # Step 3: Set up Redis Pub/Sub listeners for new responses and control signals.
            # These listeners run in a separate asyncio task (`listen_messages`).
            pubsub_response = await redis.create_pubsub()
            await pubsub_response.subscribe(response_channel)
            logger.debug(f"Subscribed to response channel: {response_channel}")

            pubsub_control = await redis.create_pubsub()
            await pubsub_control.subscribe(control_channel) # Listen to global control signals for this run.
            logger.debug(f"Subscribed to control channel: {control_channel}")

            # `message_queue`: An asyncio.Queue used to communicate messages from the
            # concurrent Pub/Sub listeners back to the main `stream_generator` loop.
            message_queue = asyncio.Queue()

            async def listen_messages():
                """A concurrent task that listens to both response and control Pub/Sub channels."""
                response_reader = pubsub_response.listen()
                control_reader = pubsub_control.listen()
                # Create tasks for listening to each channel.
                tasks = [asyncio.create_task(response_reader.__anext__()), asyncio.create_task(control_reader.__anext__())]

                while not terminate_stream: # Continue listening until the stream is terminated.
                    # Wait for the first listener task to complete (i.e., a message arrives).
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        try:
                            message = task.result() # Get the message from the completed task.
                            if message and isinstance(message, dict) and message.get("type") == "message":
                                channel = message.get("channel")
                                data_bytes = message.get("data")
                                data = data_bytes.decode('utf-8') if isinstance(data_bytes, bytes) else data_bytes

                                # If it's a "new" notification on the response channel, put "new_response" on the queue.
                                if channel == response_channel and data == "new":
                                    await message_queue.put({"type": "new_response"})
                                # If it's a control signal (STOP, END_STREAM, ERROR), put it on the queue and stop listening.
                                elif channel == control_channel and data in ["STOP", "END_STREAM", "ERROR"]:
                                    logger.info(f"Received control signal '{data}' on {control_channel} for {agent_run_id}")
                                    await message_queue.put({"type": "control", "data": data})
                                    return # Stop this listener task.
                        except StopAsyncIteration: # Listener was gracefully closed.
                            logger.warning(f"Pub/Sub listener {task.get_name()} stopped for {agent_run_id}.")
                            await message_queue.put({"type": "error", "data": "Listener stopped unexpectedly"})
                            return
                        except Exception as e: # Catch other errors in the listener.
                            logger.error(f"Error in Pub/Sub listener for {agent_run_id}: {e}", exc_info=True)
                            await message_queue.put({"type": "error", "data": "Listener failed"})
                            return
                        finally:
                            # Reschedule the completed listener task to continue listening on its channel.
                            if task in tasks:
                                tasks.remove(task)
                                if message and isinstance(message, dict): # Check if message is not None
                                    if message.get("channel") == response_channel:
                                         tasks.append(asyncio.create_task(response_reader.__anext__()))
                                    elif message.get("channel") == control_channel:
                                         tasks.append(asyncio.create_task(control_reader.__anext__()))
                                else: # If message is None (e.g. listener was cancelled), don't reschedule
                                    logger.debug(f"Listener task for {task.get_name()} not rescheduled as message was None.")


                # On exit from the loop (e.g., terminate_stream is True), cancel any pending listener tasks.
                for p_task in pending: p_task.cancel()
                for task_to_cancel in tasks: task_to_cancel.cancel()

            listener_task = asyncio.create_task(listen_messages()) # Start the concurrent listener.

            # Step 4: Main loop to process items from the `message_queue`.
            while not terminate_stream:
                try:
                    queue_item = await message_queue.get() # Wait for an item from the listeners.

                    if queue_item["type"] == "new_response":
                        # A "new_response" signal means new data is available in the Redis list.
                        new_start_index = last_processed_index + 1
                        new_responses_json = await redis.lrange(response_list_key, new_start_index, -1)

                        if new_responses_json:
                            new_responses = [json.loads(r) for r in new_responses_json]
                            num_new = len(new_responses)
                            for response in new_responses:
                                yield f"data: {json.dumps(response)}\n\n" # Yield each new response.
                                # If a response itself signals completion/failure, terminate the stream.
                                if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped']:
                                    logger.info(f"Detected run completion via status message in stream: {response.get('status')} for {agent_run_id}")
                                    terminate_stream = True
                                    break 
                            last_processed_index += num_new # Update the last processed index.
                        if terminate_stream: break # Exit loop if termination was signaled by a response.

                    elif queue_item["type"] == "control":
                        # A control signal (STOP, END_STREAM, ERROR) was received.
                        control_signal = queue_item["data"]
                        logger.info(f"Stream for {agent_run_id} terminating due to control signal: {control_signal}")
                        terminate_stream = True 
                        yield f"data: {json.dumps({'type': 'status', 'status': control_signal})}\n\n" # Yield the control signal status.
                        break

                    elif queue_item["type"] == "error":
                        # An error occurred in one of the listeners.
                        logger.error(f"Listener error for {agent_run_id}: {queue_item['data']}. Terminating stream.")
                        terminate_stream = True
                        yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': queue_item['data']})}\n\n"
                        break
                except asyncio.CancelledError: # If the stream_generator itself is cancelled.
                     logger.info(f"Stream generator main loop cancelled for {agent_run_id}")
                     terminate_stream = True # Ensure loop terminates.
                     break
                except Exception as loop_err: # Catch unexpected errors in this loop.
                    logger.error(f"Error in stream generator main loop for {agent_run_id}: {loop_err}", exc_info=True)
                    terminate_stream = True
                    yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': f'Stream failed: {loop_err}'})}\n\n"
                    break
        except Exception as e: # Catch errors during the setup phase (before main loop).
            logger.error(f"Error setting up stream for agent run {agent_run_id}: {e}", exc_info=True)
            # Only yield an error if the initial batch of responses wasn't even sent.
            if not initial_yield_complete:
                 yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': f'Failed to start stream: {e}'})}\n\n"
        finally:
            # Graceful shutdown of resources.
            terminate_stream = True # Ensure listeners know to stop.
            # Order of cleanup: unsubscribe from channels, then close Pub/Sub connections, then cancel listener task.
            if pubsub_response: 
                try: await pubsub_response.unsubscribe(response_channel) catch: pass
                try: await pubsub_response.close() catch: pass
            if pubsub_control: 
                try: await pubsub_control.unsubscribe(control_channel) catch: pass
                try: await pubsub_control.close() catch: pass

            if listener_task:
                listener_task.cancel()
                try:
                    await listener_task  # Wait for the listener task to actually finish.
                except asyncio.CancelledError:
                    pass # Expected if cancelled.
                except Exception as e: # Log any other errors from listener task during cancellation.
                    logger.debug(f"Listener task for {agent_run_id} ended with exception during cleanup: {e}")
            
            await asyncio.sleep(0.1) # Brief pause to allow tasks to fully cancel.
            logger.debug(f"Streaming cleanup complete for agent run: {agent_run_id}")

    # Return a StreamingResponse that uses the `stream_generator`.
    # Headers are set for Server-Sent Events (SSE).
    return StreamingResponse(stream_generator(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive",
        "X-Accel-Buffering": "no", "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*" # Allow cross-origin requests for the stream.
    })

async def generate_and_update_project_name(project_id: str, prompt: str):
    """Generates a project name using an LLM and updates the database."""
    logger.info(f"Starting background task to generate name for project: {project_id}")
    try:
        db_conn = DBConnection()
        client = await db_conn.client

        model_name = "openai/gpt-4o-mini"
        system_prompt = "You are a helpful assistant that generates extremely concise titles (2-4 words maximum) for chat threads based on the user's message. Respond with only the title, no other text or punctuation."
        user_message = f"Generate an extremely brief title (2-4 words only) for a chat thread that starts with this message: \"{prompt}\""
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]

        logger.debug(f"Calling LLM ({model_name}) for project {project_id} naming.")
        response = await make_llm_api_call(messages=messages, model_name=model_name, max_tokens=20, temperature=0.7)

        generated_name = None
        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_name = response['choices'][0]['message'].get('content', '').strip()
            cleaned_name = raw_name.strip('\'" \n\t')
            if cleaned_name:
                generated_name = cleaned_name
                logger.info(f"LLM generated name for project {project_id}: '{generated_name}'")
            else:
                logger.warning(f"LLM returned an empty name for project {project_id}.")
        else:
            logger.warning(f"Failed to get valid response from LLM for project {project_id} naming. Response: {response}")

        if generated_name:
            update_result = await client.table('projects').update({"name": generated_name}).eq("project_id", project_id).execute()
            if hasattr(update_result, 'data') and update_result.data:
                logger.info(f"Successfully updated project {project_id} name to '{generated_name}'")
            else:
                logger.error(f"Failed to update project {project_id} name in database. Update result: {update_result}")
        else:
            logger.warning(f"No generated name, skipping database update for project {project_id}.")

    except Exception as e:
        logger.error(f"Error in background naming task for project {project_id}: {str(e)}\n{traceback.format_exc()}")
    finally:
        # No need to disconnect DBConnection singleton instance here
        logger.info(f"Finished background naming task for project: {project_id}")

@router.post("/agent/initiate", response_model=InitiateAgentResponse)
async def initiate_agent_with_files(
    prompt: str = Form(...),
    model_name: Optional[str] = Form(None),  # Default to None to use config.MODEL_TO_USE
    enable_thinking: Optional[bool] = Form(False),
    reasoning_effort: Optional[str] = Form("low"),
    stream: Optional[bool] = Form(True),
    enable_context_manager: Optional[bool] = Form(False),
    files: List[UploadFile] = File(default=[]),
    user_id: str = Depends(get_current_user_id_from_jwt) # Ensures the user is authenticated.
):
    """
    Initiates a new agent session. This is a comprehensive endpoint that performs several setup steps:
    1. Creates a new Project.
    2. Creates a new Thread associated with the Project.
    3. (Optionally) Triggers a background task to generate a name for the Project using an LLM.
    4. Creates a new Sandbox environment for the Project.
    5. Updates the Project with the Sandbox details.
    6. (If files are provided) Uploads files to the Sandbox's workspace.
    7. Adds the initial user prompt (and file upload info) as the first message in the Thread.
    8. Creates an AgentRun record in the database.
    9. Registers the agent run in Redis for tracking by this instance.
    10. Starts the agent execution in a background task.

    This flow ensures that all necessary resources and records are created before the agent
    starts processing the user's request.

    Args:
        prompt (str): The initial user prompt.
        model_name (Optional[str]): The LLM model to use. Defaults to `config.MODEL_TO_USE`.
        enable_thinking (Optional[bool]): Flag to enable 'thinking' indicators in LLM responses.
        reasoning_effort (Optional[str]): Effort level for reasoning, if applicable.
        stream (Optional[bool]): Whether to stream responses (typically True).
        enable_context_manager (Optional[bool]): Flag to enable context management.
        files (List[UploadFile]): A list of files uploaded by the user.
        user_id (str): The ID of the authenticated user, injected by FastAPI's dependency system.

    Returns:
        InitiateAgentResponse: Contains the IDs of the newly created thread and agent run.
    
    Raises:
        HTTPException: 
            - 500 if the Agent API (instance_id) is not initialized.
            - 403 if the user is not permitted to use the selected model.
            - 402 if billing limits are reached.
            - 500 for other general errors during the initiation process.
    """
    global instance_id # Ensure global instance_id is accessible.
    if not instance_id:
        # This is a critical server configuration error.
        logger.error("Agent API not initialized with instance ID during agent initiation.")
        raise HTTPException(status_code=500, detail="Agent API not initialized with instance ID")

    # Determine the model to use, defaulting to the one specified in the server configuration.
    logger.info(f"Original model_name from request: {model_name}")
    if model_name is None:
        model_name = config.MODEL_TO_USE
        logger.info(f"Using model from config: {model_name}")

    # Resolve model name aliases (e.g., "claude-sonnet" to "anthropic/claude-3-7-sonnet-latest").
    resolved_model = MODEL_NAME_ALIASES.get(model_name, model_name)
    logger.info(f"Resolved model name for initiation: {resolved_model}")
    model_name = resolved_model # Use the resolved model name moving forward.

    logger.info(f"Initiating new agent with prompt and {len(files)} files (Instance: {instance_id}), model: {model_name}, enable_thinking: {enable_thinking}")
    client = await db.client
    # For Basejump, the personal account_id is the same as the user_id.
    # This is used for billing checks and resource ownership.
    account_id = user_id 
    
    # Perform billing checks before creating any resources.
    # `can_use_model`: Checks if the user's subscription plan allows usage of the requested model.
    can_use, model_message, allowed_models = await can_use_model(client, account_id, model_name)
    if not can_use:
        logger.warning(f"User {user_id} denied access to model {model_name}: {model_message}")
        raise HTTPException(status_code=403, detail={"message": model_message, "allowed_models": allowed_models})

    # `check_billing_status`: Checks overall billing status (e.g., usage limits, active subscription).
    can_run, message, subscription = await check_billing_status(client, account_id)
    if not can_run:
        logger.warning(f"User {user_id} failed billing check: {message}")
        raise HTTPException(status_code=402, detail={"message": message, "subscription": subscription})

    try:
        # Step 1: Create a new Project record in the database.
        # A placeholder name is used initially; it can be updated later by a background task.
        placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
        project_insert_data = {
            "project_id": str(uuid.uuid4()), "account_id": account_id, "name": placeholder_name,
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        project_result = await client.table('projects').insert(project_insert_data).execute()
        if not project_result.data: raise Exception("Failed to create project in database.")
        project_id = project_result.data[0]['project_id']
        logger.info(f"Step 1/10: Created new project {project_id} for user {user_id}")

        # Step 2: Create a new Thread associated with the Project.
        thread_insert_data = {
            "thread_id": str(uuid.uuid4()), "project_id": project_id, "account_id": account_id,
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        thread_result = await client.table('threads').insert(thread_insert_data).execute()
        if not thread_result.data: raise Exception("Failed to create thread in database.")
        thread_id = thread_result.data[0]['thread_id']
        logger.info(f"Step 2/10: Created new thread {thread_id} for project {project_id}")

        # Step 3: Trigger a background task to generate a more descriptive project name.
        # This is done asynchronously to avoid blocking the main request flow.
        asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
        logger.info(f"Step 3/10: Enqueued background task for project {project_id} naming.")

        # Step 4: Create a new Sandbox environment for this project.
        # The sandbox provides an isolated execution environment for the agent's tools.
        sandbox_pass = str(uuid.uuid4()) # Generate a password for sandbox access (e.g., VNC).
        sandbox = create_sandbox(sandbox_pass, project_id) # `create_sandbox` is from `sandbox.sandbox`
        sandbox_id = sandbox.id
        logger.info(f"Step 4/10: Created new sandbox {sandbox_id} for project {project_id}")

        # Step 5: Update the Project record with details of the created Sandbox.
        # This includes preview links and access tokens if applicable.
        vnc_link = sandbox.get_preview_link(6080) # Port for VNC/noVNC.
        website_link = sandbox.get_preview_link(8080) # Port for general web access if sandbox hosts a server.
        # Extract URL and token robustly, as Daytona SDK might change return types.
        vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link).split("url='")[1].split("'")[0]
        website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
        sandbox_access_token = None
        if hasattr(vnc_link, 'token'): sandbox_access_token = vnc_link.token
        elif "token='" in str(vnc_link): sandbox_access_token = str(vnc_link).split("token='")[1].split("'")[0]

        sandbox_update_payload = {
            'id': sandbox_id, 'pass': sandbox_pass, 'vnc_preview': vnc_url,
            'sandbox_url': website_url, 'token': sandbox_access_token
        }
        project_update_result = await client.table('projects').update({'sandbox': sandbox_update_payload}).eq('project_id', project_id).execute()
        if not project_update_result.data:
            logger.error(f"Failed to update project {project_id} with new sandbox {sandbox_id} details.")
            # This is a critical failure as the agent needs sandbox info.
            raise Exception("Database update for sandbox details failed.")
        logger.info(f"Step 5/10: Updated project {project_id} with sandbox {sandbox_id} details.")

        # Step 6: Upload any provided files to the Sandbox's workspace.
        # These files will be accessible by the agent through its file system tools.
        message_content = prompt # Start with the user's text prompt.
        if files:
            logger.info(f"Step 6/10: Starting file uploads ({len(files)} files) to sandbox {sandbox_id} for project {project_id}.")
            successful_uploads = []
            failed_uploads = []
            for file_obj in files: # Renamed `file` to `file_obj` to avoid conflict with `File` type hint.
                if file_obj.filename:
                    try:
                        # Sanitize filename to prevent path traversal or other issues.
                        safe_filename = file_obj.filename.replace('/', '_').replace('\\', '_')
                        target_path = f"/workspace/{safe_filename}" # Files are typically placed in /workspace.
                        logger.info(f"Attempting to upload '{safe_filename}' to '{target_path}' in sandbox {sandbox_id}")
                        
                        file_content = await file_obj.read() # Read file content.
                        upload_successful_to_sandbox = False
                        try:
                            # Use the sandbox's file system interface to upload the file.
                            # This abstracts the underlying mechanism (e.g., Daytona SDK call).
                            if hasattr(sandbox, 'fs') and hasattr(sandbox.fs, 'upload_file'):
                                import inspect # Used to check if upload_file is async.
                                if inspect.iscoroutinefunction(sandbox.fs.upload_file):
                                    await sandbox.fs.upload_file(target_path, file_content)
                                else:
                                    sandbox.fs.upload_file(target_path, file_content)
                                logger.debug(f"Sandbox fs.upload_file called for '{target_path}'")
                                upload_successful_to_sandbox = True
                            else:
                                # This indicates an issue with the sandbox object's interface.
                                raise NotImplementedError("Suitable upload method not found on sandbox object.")
                        except Exception as upload_error:
                            logger.error(f"Error during direct sandbox upload call for '{safe_filename}': {str(upload_error)}", exc_info=True)

                        if upload_successful_to_sandbox:
                            # Verification step: Check if the file actually appears in the sandbox directory.
                            # This adds robustness but might be slow for many files or large directories.
                            try:
                                await asyncio.sleep(0.2) # Short delay to allow filesystem to sync.
                                parent_dir = os.path.dirname(target_path)
                                files_in_dir = sandbox.fs.list_files(parent_dir) # List files in the target directory.
                                file_names_in_dir = [f.name for f in files_in_dir]
                                if safe_filename in file_names_in_dir:
                                    successful_uploads.append(target_path)
                                    logger.info(f"Successfully uploaded and verified file '{safe_filename}' to sandbox path '{target_path}'")
                                else:
                                    logger.error(f"Verification failed for '{safe_filename}': File not found in '{parent_dir}' after upload attempt.")
                                    failed_uploads.append(safe_filename)
                            except Exception as verify_error:
                                logger.error(f"Error verifying file '{safe_filename}' after upload: {str(verify_error)}", exc_info=True)
                                failed_uploads.append(safe_filename) # Assume failure if verification errors.
                        else:
                            failed_uploads.append(safe_filename)
                    except Exception as file_processing_error:
                        logger.error(f"Error processing file '{file_obj.filename}' for upload: {str(file_processing_error)}", exc_info=True)
                        failed_uploads.append(file_obj.filename)
                    finally:
                        await file_obj.close() # Ensure the uploaded file is closed.
            
            # Append information about uploaded files (successes and failures) to the initial user message.
            if successful_uploads:
                message_content += "\n\n" if message_content else "" # Add separator if prompt exists.
                for uploaded_file_path in successful_uploads: message_content += f"[Uploaded File: {uploaded_file_path}]\n"
            if failed_uploads:
                message_content += "\n\nThe following files failed to upload:\n"
                for failed_file_name in failed_uploads: message_content += f"- {failed_file_name}\n"
            logger.info(f"Step 6/10: File uploads complete. Successful: {len(successful_uploads)}, Failed: {len(failed_uploads)}.")
        else:
            logger.info(f"Step 6/10: No files provided for upload.")

        # Step 7: Add the initial user message (prompt + file info) to the Thread.
        # This message will be the starting point for the LLM interaction.
        initial_message_id = str(uuid.uuid4())
        initial_message_payload = {"role": "user", "content": message_content}
        await client.table('messages').insert({
            "message_id": initial_message_id, "thread_id": thread_id, "type": "user",
            "is_llm_message": True, # This indicates it's part of the LLM's conversational context.
            "content": json.dumps(initial_message_payload),
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        logger.info(f"Step 7/10: Added initial user message {initial_message_id} to thread {thread_id}")

        # Step 8: Create an AgentRun record in the database to track this specific agent execution.
        # Initially, its status is "running".
        agent_run_insert_data = {
            "thread_id": thread_id, "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat()
        }
        agent_run_result = await client.table('agent_runs').insert(agent_run_insert_data).execute()
        if not agent_run_result.data: raise Exception("Failed to create agent_run in database.")
        agent_run_id = agent_run_result.data[0]['id']
        logger.info(f"Step 8/10: Created new agent run {agent_run_id} for thread {thread_id}")

        # Step 9: Register this agent run in Redis with a TTL, associated with this backend instance.
        # This helps in tracking which instance is managing which run, especially for cleanup on shutdown.
        instance_key = f"active_run:{instance_id}:{agent_run_id}"
        try:
            await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL) # `REDIS_KEY_TTL` from `run_agent_background.py`
            logger.info(f"Step 9/10: Registered agent run {agent_run_id} in Redis with key {instance_key}")
        except Exception as e:
            # Log a warning but don't fail the entire operation if Redis registration fails.
            # The agent can still run; cleanup might be affected if this instance crashes.
            logger.warning(f"Failed to register agent run {agent_run_id} in Redis ({instance_key}): {str(e)}")

        # Step 10: Start the agent execution in a background task using Dramatiq.
        # `run_agent_background.send(...)` enqueues the task.
        # The actual agent logic (LLM calls, tool execution) happens in this background task.
        run_agent_background.send(
            agent_run_id=agent_run_id, thread_id=thread_id, instance_id=instance_id,
            project_id=project_id,
            model_name=model_name, # Pass the resolved model name.
            enable_thinking=enable_thinking, reasoning_effort=reasoning_effort,
            stream=stream, enable_context_manager=enable_context_manager
        )
        logger.info(f"Step 10/10: Enqueued background task for agent run {agent_run_id}.")

        # Return the IDs of the created thread and agent run to the client.
        return {"thread_id": thread_id, "agent_run_id": agent_run_id}

    except Exception as e:
        # Catch any exception during the multi-step initiation process.
        logger.error(f"Error during agent initiation for user {user_id}: {str(e)}\n{traceback.format_exc()}")
        # TODO: Implement cleanup logic here. If project/thread/sandbox were created before the error,
        # they should ideally be deleted to avoid orphaned resources. This can be complex
        # due to the sequence of operations and potential partial failures.
        raise HTTPException(status_code=500, detail=f"Failed to initiate agent session: {str(e)}")
