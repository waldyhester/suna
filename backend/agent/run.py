import os
import json
import re
from uuid import uuid4
from typing import Optional

# from agent.tools.message_tool import MessageTool
from agent.tools.message_tool import MessageTool
from agent.tools.sb_deploy_tool import SandboxDeployTool
from agent.tools.sb_expose_tool import SandboxExposeTool
from agent.tools.web_search_tool import SandboxWebSearchTool
from dotenv import load_dotenv
from utils.config import config

from agentpress.thread_manager import ThreadManager
from agentpress.response_processor import ProcessorConfig
from agent.tools.sb_shell_tool import SandboxShellTool
from agent.tools.sb_files_tool import SandboxFilesTool
from agent.tools.sb_browser_tool import SandboxBrowserTool
from agent.tools.data_providers_tool import DataProvidersTool
from agent.prompt import get_system_prompt
from utils.logger import logger
from utils.auth_utils import get_account_id_from_thread
from services.billing import check_billing_status
from agent.tools.sb_vision_tool import SandboxVisionTool
from services.langfuse import langfuse
from langfuse.client import StatefulTraceClient
from services.langfuse import langfuse
from agent.gemini_prompt import get_gemini_system_prompt

load_dotenv()

async def run_agent(
    thread_id: str,
    project_id: str,
    stream: bool,
    thread_manager: Optional[ThreadManager] = None,
    native_max_auto_continues: int = 25,
    max_iterations: int = 100,
    model_name: str = "anthropic/claude-3-7-sonnet-latest",
    enable_thinking: Optional[bool] = False,
    reasoning_effort: Optional[str] = 'low',
    enable_context_manager: bool = True,
    trace: Optional[StatefulTraceClient] = None
):
    """Run the development agent with specified configuration."""
    logger.info(f"🚀 Starting agent with model: {model_name}")

    if not trace:
        trace = langfuse.trace(name="run_agent", session_id=thread_id, metadata={"project_id": project_id})
    thread_manager = ThreadManager(trace=trace)

    client = await thread_manager.db.client

    # Get account ID from thread for billing checks
    account_id = await get_account_id_from_thread(client, thread_id)
    if not account_id:
        raise ValueError("Could not determine account ID for thread")

    # Get sandbox info from project
    project = await client.table('projects').select('*').eq('project_id', project_id).execute()
    if not project.data or len(project.data) == 0:
        raise ValueError(f"Project {project_id} not found")

    project_data = project.data[0]
    sandbox_info = project_data.get('sandbox', {})
    if not sandbox_info.get('id'):
        raise ValueError(f"No sandbox found for project {project_id}")

    # Initialize tools with project_id instead of sandbox object
    # This ensures each tool independently verifies it's operating on the correct project
    # SandboxShellTool: Allows execution of shell commands within the agent's isolated sandbox environment.
    thread_manager.add_tool(SandboxShellTool, project_id=project_id, thread_manager=thread_manager)
    # SandboxFilesTool: Provides capabilities to read, write, and manage files within the sandbox.
    thread_manager.add_tool(SandboxFilesTool, project_id=project_id, thread_manager=thread_manager)
    # SandboxBrowserTool: Enables the agent to control a headless browser for web navigation and interaction.
    thread_manager.add_tool(SandboxBrowserTool, project_id=project_id, thread_id=thread_id, thread_manager=thread_manager)
    # SandboxDeployTool: Handles the deployment of applications or code from the sandbox to a public URL.
    thread_manager.add_tool(SandboxDeployTool, project_id=project_id, thread_manager=thread_manager)
    # SandboxExposeTool: Allows exposing specific ports from the sandbox to make services accessible externally.
    thread_manager.add_tool(SandboxExposeTool, project_id=project_id, thread_manager=thread_manager)
    # MessageTool: Facilitates direct communication with the user, typically for asking questions or signaling task completion.
    # Note: The comment indicates this is primarily handled via prompt engineering rather than explicit tool calls.
    thread_manager.add_tool(MessageTool) 
    # SandboxWebSearchTool: Empowers the agent to perform web searches to gather information.
    thread_manager.add_tool(SandboxWebSearchTool, project_id=project_id, thread_manager=thread_manager)
    # SandboxVisionTool: Allows the agent to process and understand image content, often used for analyzing screenshots from the browser.
    thread_manager.add_tool(SandboxVisionTool, project_id=project_id, thread_id=thread_id, thread_manager=thread_manager)
    # Add data providers tool if RapidAPI key is available, enabling access to various external data APIs.
    if config.RAPID_API_KEY:
        # DataProvidersTool: A generic tool to interact with various third-party data provider APIs (e.g., Zillow, Twitter via RapidAPI).
        thread_manager.add_tool(DataProvidersTool)

    # Determine the system message based on the model name.
    # Different models may have different optimal ways of interpreting system prompts or requiring examples.
    if "gemini-2.5-flash" in model_name.lower():
        # For Gemini models, a specific prompt structure might be more effective.
        # The 'get_gemini_system_prompt()' function likely provides this specialized prompt.
        # The comment "# example included" suggests the Gemini prompt itself might contain or refer to an example.
        system_message = { "role": "system", "content": get_gemini_system_prompt() } # example included
    elif "anthropic" not in model_name.lower():
        # For models other than Anthropic's Claude (e.g., various OpenAI models), providing a sample response can be crucial.
        # This sample response guides the model on the expected format of its output, especially for tool usage (e.g., XML structure).
        # It helps ensure the model's responses are parsable and that tools are called correctly.
        sample_response_path = os.path.join(os.path.dirname(__file__), 'sample_responses/1.txt')
        with open(sample_response_path, 'r') as file:
            sample_response = file.read()
        
        system_message = { "role": "system", "content": get_system_prompt() + "\n\n <sample_assistant_response>" + sample_response + "</sample_assistant_response>" }
    else:
        # For Anthropic models (Claude), a standard system prompt without an explicit appended sample response is used.
        # These models might have been trained to follow instructions and use tools effectively without needing an explicit sample in the prompt.
        system_message = { "role": "system", "content": get_system_prompt() }

    iteration_count = 0
    # This flag controls the main execution loop. It's set to False if the agent decides to stop (e.g., via 'complete' or 'ask' tools)
    # or if an unrecoverable error occurs, or max_iterations is reached.
    continue_execution = True

    # Fetch the latest user message to potentially update the trace input.
    # This helps in tracking what the user initially requested in this agent run or interaction segment.
    latest_user_message = await client.table('messages').select('*').eq('thread_id', thread_id).eq('type', 'user').order('created_at', desc=True).limit(1).execute()
    if latest_user_message.data and len(latest_user_message.data) > 0:
        data = json.loads(latest_user_message.data[0]['content'])
        trace.update(input=data['content']) # Update Langfuse trace with the user's input.

    # The main loop for agent execution. It continues as long as `continue_execution` is True
    # and the number of iterations is less than `max_iterations` to prevent infinite loops.
    while continue_execution and iteration_count < max_iterations:
        iteration_count += 1
        logger.info(f"🔄 Running iteration {iteration_count} of {max_iterations}...")

        # Perform a billing check at the beginning of each iteration.
        # This is crucial to ensure that the agent stops if usage limits are exceeded during its operation.
        can_run, message, subscription = await check_billing_status(client, account_id)
        if not can_run:
            error_msg = f"Billing limit reached: {message}"
            trace.event(name="billing_limit_reached", level="ERROR", status_message=(f"{error_msg}"))
            # Yield a special status message to inform the client that the agent stopped due to billing limits.
            yield {
                "type": "status",
                "status": "stopped",
                "message": error_msg
            }
            break # Exit the loop immediately if billing limits are reached.

        # Check if the last message in the thread was from the assistant.
        # If so, it implies the agent has completed its turn and is waiting for user input or further instructions.
        # This prevents the agent from re-running automatically without new stimuli.
        latest_message = await client.table('messages').select('*').eq('thread_id', thread_id).in_('type', ['assistant', 'tool', 'user']).order('created_at', desc=True).limit(1).execute()
        if latest_message.data and len(latest_message.data) > 0:
            message_type = latest_message.data[0].get('type')
            if message_type == 'assistant':
                logger.info(f"Last message was from assistant, stopping execution for this iteration.")
                trace.event(name="last_message_from_assistant", level="INFO", status_message=(f"Last message was from assistant, stopping execution for this iteration."))
                continue_execution = False # Signal to stop the loop.
                break # Exit the loop.

        # ---- Temporary Message Handling (Browser State & Image Context) ----
        # This section constructs a temporary message to provide the LLM with the most recent
        # contextual information, such as the current browser state (DOM, screenshot) or
        # an image the user explicitly requested to see. This message is injected into the
        # current LLM call to ensure the agent's decisions are based on the latest available data.
        # The goal is to make the LLM "aware" of the most recent visual/state information before it generates its response.
        temporary_message = None
        temp_message_content_list = [] # List to hold different parts of the temporary message (text, image_url).

        # Fetch the latest 'browser_state' message. This message typically contains
        # a snapshot of the browser's DOM, metadata, and a screenshot.
        latest_browser_state_msg = await client.table('messages').select('*').eq('thread_id', thread_id).eq('type', 'browser_state').order('created_at', desc=True).limit(1).execute()
        if latest_browser_state_msg.data and len(latest_browser_state_msg.data) > 0:
            try:
                browser_content = json.loads(latest_browser_state_msg.data[0]["content"])
                screenshot_base64 = browser_content.get("screenshot_base64")
                screenshot_url = browser_content.get("screenshot_url")
                
                # Create a copy of the browser state without screenshot data
                browser_state_text = browser_content.copy()
                browser_state_text.pop('screenshot_base64', None)
                browser_state_text.pop('screenshot_url', None)

                if browser_state_text:
                    temp_message_content_list.append({
                        "type": "text",
                        "text": f"The following is the current state of the browser:\n{json.dumps(browser_state_text, indent=2)}"
                    })
                    
                # Prioritize screenshot_url if available
                if screenshot_url:
                    temp_message_content_list.append({
                        "type": "image_url",
                        "image_url": {
                            "url": screenshot_url,
                        }
                    })
                elif screenshot_base64:
                    # Fallback to base64 if URL not available
                    temp_message_content_list.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{screenshot_base64}",
                        }
                    })
                else:
                    logger.warning("Browser state found but no screenshot data.")

            except Exception as e:
                logger.error(f"Error parsing browser state: {e}")
                trace.event(name="error_parsing_browser_state", level="ERROR", status_message=(f"{e}"))

        # Get the latest image_context message (NEW)
        latest_image_context_msg = await client.table('messages').select('*').eq('thread_id', thread_id).eq('type', 'image_context').order('created_at', desc=True).limit(1).execute()
        if latest_image_context_msg.data and len(latest_image_context_msg.data) > 0:
            try:
                image_context_content = json.loads(latest_image_context_msg.data[0]["content"])
                base64_image = image_context_content.get("base64")
                mime_type = image_context_content.get("mime_type")
                file_path = image_context_content.get("file_path", "unknown file")

                if base64_image and mime_type:
                    temp_message_content_list.append({
                        "type": "text",
                        "text": f"Here is the image you requested to see: '{file_path}'"
                    })
                    temp_message_content_list.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{base64_image}",
                        }
                    })
                else:
                    logger.warning(f"Image context found for '{file_path}' but missing base64 or mime_type.")

                await client.table('messages').delete().eq('message_id', latest_image_context_msg.data[0]["message_id"]).execute()
            except Exception as e:
                logger.error(f"Error parsing image context: {e}")
                trace.event(name="error_parsing_image_context", level="ERROR", status_message=(f"{e}"))

        # If we have any content, construct the temporary_message
        if temp_message_content_list:
            temporary_message = {"role": "user", "content": temp_message_content_list}
            # logger.debug(f"Constructed temporary message with {len(temp_message_content_list)} content blocks.")
        # ---- End Temporary Message Handling ----

        # Set max_tokens based on model
        max_tokens = None
        if "sonnet" in model_name.lower():
            max_tokens = 64000
        elif "gpt-4" in model_name.lower():
            max_tokens = 4096
            
        generation = trace.generation(name="thread_manager.run_thread")
        try:
            # Make the LLM call and process the response
            response = await thread_manager.run_thread(
                thread_id=thread_id,
                system_prompt=system_message,
                stream=stream,
                llm_model=model_name,
                llm_temperature=0,
                llm_max_tokens=max_tokens,
                tool_choice="auto",
                max_xml_tool_calls=1,
                temporary_message=temporary_message,
                processor_config=ProcessorConfig(
                    xml_tool_calling=True,
                    native_tool_calling=False,
                    execute_tools=True,
                    execute_on_stream=True,
                    tool_execution_strategy="parallel",
                    xml_adding_strategy="user_message"
                ),
                native_max_auto_continues=native_max_auto_continues,
                include_xml_examples=True,
                enable_thinking=enable_thinking,
                reasoning_effort=reasoning_effort,
                enable_context_manager=enable_context_manager,
                generation=generation
            )

            # Handle direct error responses from run_thread (e.g., if the underlying LLM call fails validation)
            if isinstance(response, dict) and "status" in response and response["status"] == "error":
                logger.error(f"Error response from run_thread: {response.get('message', 'Unknown error')}")
                trace.event(name="error_response_from_run_thread", level="ERROR", status_message=(f"{response.get('message', 'Unknown error')}"))
                yield response # Forward the error response to the client.
                break # Stop execution if run_thread itself returns an error.

            # This variable will track if the agent used a "terminal" XML tool like <ask>, <complete>, or <web-browser-takeover>.
            # These tools typically signify the end of the agent's current action sequence.
            last_tool_call = None

            # Process the streaming response from the LLM.
            error_detected = False # Flag to track if an error status is encountered in the stream.
            try:
                full_response = "" # Accumulate the full text response from the assistant.
                async for chunk in response:
                    # If an error status chunk is received, it indicates a problem during tool execution or response generation.
                    if isinstance(chunk, dict) and chunk.get('type') == 'status' and chunk.get('status') == 'error':
                        logger.error(f"Error chunk detected: {chunk.get('message', 'Unknown error')}")
                        trace.event(name="error_chunk_detected", level="ERROR", status_message=(f"{chunk.get('message', 'Unknown error')}"))
                        error_detected = True # Mark that an error was detected.
                        yield chunk  # Forward the error chunk to the client.
                        continue     # Continue processing other chunks in this response, but the loop will break afterwards.
                        
                    # Check for specific XML tool tags within the assistant's content.
                    # These tags (<ask>, <complete>, <web-browser-takeover>) signal that the agent
                    # has decided to pause, finish, or hand over control.
                    if chunk.get('type') == 'assistant' and 'content' in chunk:
                        try:
                            # The content from the LLM might be a JSON string or already an object.
                            content = chunk.get('content', '{}')
                            if isinstance(content, str):
                                assistant_content_json = json.loads(content)
                            else:
                                assistant_content_json = content

                            # The actual text from the assistant is nested.
                            assistant_text = assistant_content_json.get('content', '')
                            full_response += assistant_text # Accumulate the textual response.
                            if isinstance(assistant_text, str): # Ensure it's a string for searching.
                                 # Detect the presence of closing tags for terminal tools.
                                if '</ask>' in assistant_text or '</complete>' in assistant_text or '</web-browser-takeover>' in assistant_text:
                                   if '</ask>' in assistant_text:
                                       xml_tool = 'ask'
                                   elif '</complete>' in assistant_text:
                                       xml_tool = 'complete'
                                   elif '</web-browser-takeover>' in assistant_text:
                                       xml_tool = 'web-browser-takeover'

                                   last_tool_call = xml_tool # Record the terminal tool used.
                                   logger.info(f"Agent used XML tool: {xml_tool}")
                                   trace.event(name="agent_used_xml_tool", level="INFO", status_message=(f"Agent used XML tool: {xml_tool}"))
                        except json.JSONDecodeError:
                            # Handle cases where assistant content might not be valid JSON.
                            logger.warning(f"Warning: Could not parse assistant content JSON: {chunk.get('content')}")
                            trace.event(name="warning_could_not_parse_assistant_content_json", level="WARNING", status_message=(f"Warning: Could not parse assistant content JSON: {chunk.get('content')}"))
                        except Exception as e:
                            logger.error(f"Error processing assistant chunk: {e}")
                            trace.event(name="error_processing_assistant_chunk", level="ERROR", status_message=(f"Error processing assistant chunk: {e}"))

                    yield chunk # Forward the current chunk to the client.

                # After processing all chunks, check if an error was detected during streaming.
                if error_detected:
                    logger.info(f"Stopping due to error detected in response stream.")
                    trace.event(name="stopping_due_to_error_detected_in_response_stream", level="INFO", status_message=(f"Stopping due to error detected in response stream."))
                    generation.end(output=full_response, status_message="error_detected_in_stream", level="ERROR")
                    break # Exit the main loop due to the error.
                    
                # If a terminal XML tool was used, the agent's current task is considered complete for this iteration.
                if last_tool_call in ['ask', 'complete', 'web-browser-takeover']:
                    logger.info(f"Agent decided to stop with tool: {last_tool_call}")
                    trace.event(name="agent_decided_to_stop_with_tool", level="INFO", status_message=(f"Agent decided to stop with tool: {last_tool_call}"))
                    generation.end(output=full_response, status_message=f"agent_stopped_with_{last_tool_call}")
                    continue_execution = False # Signal to stop the main execution loop.

            except Exception as e:
                # Catch any unexpected errors during the response streaming process.
                error_msg = f"Error during response streaming: {str(e)}"
                logger.error(f"Error: {error_msg}")
                trace.event(name="error_during_response_streaming", level="ERROR", status_message=(f"Error during response streaming: {str(e)}"))
                generation.end(output=full_response, status_message=error_msg, level="ERROR")
                yield {
                    "type": "status",
                    "status": "error",
                    "message": error_msg
                }
                # Stop execution immediately on any error
                break
                
        except Exception as e:
            # Just log the error and re-raise to stop all iterations
            error_msg = f"Error running thread: {str(e)}"
            logger.error(f"Error: {error_msg}")
            trace.event(name="error_running_thread", level="ERROR", status_message=(f"Error running thread: {str(e)}"))
            yield {
                "type": "status",
                "status": "error",
                "message": error_msg
            }
            # Stop execution immediately on any error
            break
        generation.end(output=full_response)

    langfuse.flush() # Flush Langfuse events at the end of the run
  


# # TESTING

# async def test_agent():
#     """Test function to run the agent with a sample query"""
#     from agentpress.thread_manager import ThreadManager
#     from services.supabase import DBConnection

#     # Initialize ThreadManager
#     thread_manager = ThreadManager()

#     # Create a test thread directly with Postgres function
#     client = await DBConnection().client

#     try:
#         # Get user's personal account
#         account_result = await client.rpc('get_personal_account').execute()

#         # if not account_result.data:
#         #     print("Error: No personal account found")
#         #     return

#         account_id = "a5fe9cb6-4812-407e-a61c-fe95b7320c59"

#         if not account_id:
#             print("Error: Could not get account ID")
#             return

#         # Find or create a test project in the user's account
#         project_result = await client.table('projects').select('*').eq('name', 'test11').eq('account_id', account_id).execute()

#         if project_result.data and len(project_result.data) > 0:
#             # Use existing test project
#             project_id = project_result.data[0]['project_id']
#             print(f"\n🔄 Using existing test project: {project_id}")
#         else:
#             # Create new test project if none exists
#             project_result = await client.table('projects').insert({
#                 "name": "test11",
#                 "account_id": account_id
#             }).execute()
#             project_id = project_result.data[0]['project_id']
#             print(f"\n✨ Created new test project: {project_id}")

#         # Create a thread for this project
#         thread_result = await client.table('threads').insert({
#             'project_id': project_id,
#             'account_id': account_id
#         }).execute()
#         thread_data = thread_result.data[0] if thread_result.data else None

#         if not thread_data:
#             print("Error: No thread data returned")
#             return

#         thread_id = thread_data['thread_id']
#     except Exception as e:
#         print(f"Error setting up thread: {str(e)}")
#         return

#     print(f"\n🤖 Agent Thread Created: {thread_id}\n")

#     # Interactive message input loop
#     while True:
#         # Get user input
#         user_message = input("\n💬 Enter your message (or 'exit' to quit): ")
#         if user_message.lower() == 'exit':
#             break

#         if not user_message.strip():
#             print("\n🔄 Running agent...\n")
#             await process_agent_response(thread_id, project_id, thread_manager)
#             continue

#         # Add the user message to the thread
#         await thread_manager.add_message(
#             thread_id=thread_id,
#             type="user",
#             content={
#                 "role": "user",
#                 "content": user_message
#             },
#             is_llm_message=True
#         )

#         print("\n🔄 Running agent...\n")
#         await process_agent_response(thread_id, project_id, thread_manager)

#     print("\n👋 Test completed. Goodbye!")

# async def process_agent_response(
#     thread_id: str,
#     project_id: str,
#     thread_manager: ThreadManager,
#     stream: bool = True,
#     model_name: str = "anthropic/claude-3-7-sonnet-latest",
#     enable_thinking: Optional[bool] = False,
#     reasoning_effort: Optional[str] = 'low',
#     enable_context_manager: bool = True
# ):
#     """Process the streaming response from the agent."""
#     chunk_counter = 0
#     current_response = ""
#     tool_usage_counter = 0 # Renamed from tool_call_counter as we track usage via status

#     # Create a test sandbox for processing with a unique test prefix to avoid conflicts with production sandboxes
#     sandbox_pass = str(uuid4())
#     sandbox = create_sandbox(sandbox_pass)

#     # Store the original ID so we can refer to it
#     original_sandbox_id = sandbox.id

#     # Generate a clear test identifier
#     test_prefix = f"test_{uuid4().hex[:8]}_"
#     logger.info(f"Created test sandbox with ID {original_sandbox_id} and test prefix {test_prefix}")

#     # Log the sandbox URL for debugging
#     print(f"\033[91mTest sandbox created: {str(sandbox.get_preview_link(6080))}/vnc_lite.html?password={sandbox_pass}\033[0m")

#     async for chunk in run_agent(
#         thread_id=thread_id,
#         project_id=project_id,
#         sandbox=sandbox,
#         stream=stream,
#         thread_manager=thread_manager,
#         native_max_auto_continues=25,
#         model_name=model_name,
#         enable_thinking=enable_thinking,
#         reasoning_effort=reasoning_effort,
#         enable_context_manager=enable_context_manager
#     ):
#         chunk_counter += 1
#         # print(f"CHUNK: {chunk}") # Uncomment for debugging

#         if chunk.get('type') == 'assistant':
#             # Try parsing the content JSON
#             try:
#                 # Handle content as string or object
#                 content = chunk.get('content', '{}')
#                 if isinstance(content, str):
#                     content_json = json.loads(content)
#                 else:
#                     content_json = content

#                 actual_content = content_json.get('content', '')
#                 # Print the actual assistant text content as it comes
#                 if actual_content:
#                      # Check if it contains XML tool tags, if so, print the whole tag for context
#                     if '<' in actual_content and '>' in actual_content:
#                          # Avoid printing potentially huge raw content if it's not just text
#                          if len(actual_content) < 500: # Heuristic limit
#                             print(actual_content, end='', flush=True)
#                          else:
#                              # Maybe just print a summary if it's too long or contains complex XML
#                              if '</ask>' in actual_content: print("<ask>...</ask>", end='', flush=True)
#                              elif '</complete>' in actual_content: print("<complete>...</complete>", end='', flush=True)
#                              else: print("<tool_call>...</tool_call>", end='', flush=True) # Generic case
#                     else:
#                         # Regular text content
#                          print(actual_content, end='', flush=True)
#                     current_response += actual_content # Accumulate only text part
#             except json.JSONDecodeError:
#                  # If content is not JSON (e.g., just a string chunk), print directly
#                  raw_content = chunk.get('content', '')
#                  print(raw_content, end='', flush=True)
#                  current_response += raw_content
#             except Exception as e:
#                  print(f"\nError processing assistant chunk: {e}\n")

#         elif chunk.get('type') == 'tool': # Updated from 'tool_result'
#             # Add timestamp and format tool result nicely
#             tool_name = "UnknownTool" # Try to get from metadata if available
#             result_content = "No content"

#             # Parse metadata - handle both string and dict formats
#             metadata = chunk.get('metadata', {})
#             if isinstance(metadata, str):
#                 try:
#                     metadata = json.loads(metadata)
#                 except json.JSONDecodeError:
#                     metadata = {}

#             linked_assistant_msg_id = metadata.get('assistant_message_id')
#             parsing_details = metadata.get('parsing_details')
#             if parsing_details:
#                 tool_name = parsing_details.get('xml_tag_name', 'UnknownTool') # Get name from parsing details

#             try:
#                 # Content is a JSON string or object
#                 content = chunk.get('content', '{}')
#                 if isinstance(content, str):
#                     content_json = json.loads(content)
#                 else:
#                     content_json = content

#                 # The actual tool result is nested inside content.content
#                 tool_result_str = content_json.get('content', '')
#                  # Extract the actual tool result string (remove outer <tool_result> tag if present)
#                 match = re.search(rf'<{tool_name}>(.*?)</{tool_name}>', tool_result_str, re.DOTALL)
#                 if match:
#                     result_content = match.group(1).strip()
#                     # Try to parse the result string itself as JSON for pretty printing
#                     try:
#                         result_obj = json.loads(result_content)
#                         result_content = json.dumps(result_obj, indent=2)
#                     except json.JSONDecodeError:
#                          # Keep as string if not JSON
#                          pass
#                 else:
#                      # Fallback if tag extraction fails
#                      result_content = tool_result_str

#             except json.JSONDecodeError:
#                 result_content = chunk.get('content', 'Error parsing tool content')
#             except Exception as e:
#                 result_content = f"Error processing tool chunk: {e}"

#             print(f"\n\n🛠️  TOOL RESULT [{tool_name}] → {result_content}")

#         elif chunk.get('type') == 'status':
#             # Log tool status changes
#             try:
#                 # Handle content as string or object
#                 status_content = chunk.get('content', '{}')
#                 if isinstance(status_content, str):
#                     status_content = json.loads(status_content)

#                 status_type = status_content.get('status_type')
#                 function_name = status_content.get('function_name', '')
#                 xml_tag_name = status_content.get('xml_tag_name', '') # Get XML tag if available
#                 tool_name = xml_tag_name or function_name # Prefer XML tag name

#                 if status_type == 'tool_started' and tool_name:
#                     tool_usage_counter += 1
#                     print(f"\n⏳ TOOL STARTING #{tool_usage_counter} [{tool_name}]")
#                     print("  " + "-" * 40)
#                     # Return to the current content display
#                     if current_response:
#                         print("\nContinuing response:", flush=True)
#                         print(current_response, end='', flush=True)
#                 elif status_type == 'tool_completed' and tool_name:
#                      status_emoji = "✅"
#                      print(f"\n{status_emoji} TOOL COMPLETED: {tool_name}")
#                 elif status_type == 'finish':
#                      finish_reason = status_content.get('finish_reason', '')
#                      if finish_reason:
#                          print(f"\n📌 Finished: {finish_reason}")
#                 # else: # Print other status types if needed for debugging
#                 #    print(f"\nℹ️ STATUS: {chunk.get('content')}")

#             except json.JSONDecodeError:
#                  print(f"\nWarning: Could not parse status content JSON: {chunk.get('content')}")
#             except Exception as e:
#                 print(f"\nError processing status chunk: {e}")


#         # Removed elif chunk.get('type') == 'tool_call': block

#     # Update final message
#     print(f"\n\n✅ Agent run completed with {tool_usage_counter} tool executions")

#     # Try to clean up the test sandbox if possible
#     try:
#         # Attempt to delete/archive the sandbox to clean up resources
#         # Note: Actual deletion may depend on the Daytona SDK's capabilities
#         logger.info(f"Attempting to clean up test sandbox {original_sandbox_id}")
#         # If there's a method to archive/delete the sandbox, call it here
#         # Example: daytona.archive_sandbox(sandbox.id)
#     except Exception as e:
#         logger.warning(f"Failed to clean up test sandbox {original_sandbox_id}: {str(e)}")

# if __name__ == "__main__":
#     import asyncio

#     # Configure any environment variables or setup needed for testing
#     load_dotenv()  # Ensure environment variables are loaded

#     # Run the test function
#     asyncio.run(test_agent())