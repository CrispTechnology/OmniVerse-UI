/**
 * Clara Assistant API Service
 * 
 * This service handles all API communications for the Clara Assistant,
 * using the existing AssistantAPIClient that talks directly to AI providers
 * with OpenAI-like APIs.
 */

import { AssistantAPIClient } from '../utils/AssistantAPIClient';
import type { ChatMessage } from '../utils/APIClient';
import { 
  ClaraMessage, 
  ClaraFileAttachment, 
  ClaraProvider, 
  ClaraModel, 
  ClaraAIConfig,
  ClaraArtifact,
  ClaraFileProcessingResult,
  ClaraProviderType,
  ClaraMCPToolCall,
  ClaraMCPToolResult
} from '../types/clara_assistant_types';
import { defaultTools, executeTool } from '../utils/claraTools';
import { db } from '../db';
import type { Tool } from '../db';
import { claraMCPService } from './claraMCPService';
import { addCompletionNotification, addErrorNotification, addInfoNotification } from './notificationService';

/**
 * Chat request payload for Clara backend
 */
interface ClaraChatRequest {
  query: string;
  collection_name?: string;
  system_template?: string;
  k?: number;
  filter?: Record<string, any>;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  enable_tools?: boolean;
  enable_rag?: boolean;
}

/**
 * Chat response from Clara backend
 */
interface ClaraChatResponse {
  response: string;
  model?: string;
  tokens?: number;
  processing_time?: number;
  tool_calls?: any[];
  artifacts?: any[];
  error?: string;
}

/**
 * File upload response from Clara backend
 */
interface ClaraFileUploadResponse {
  document_id: number;
  filename: string;
  file_type: string;
  collection_name: string;
  processed: boolean;
  processing_result?: any;
  error?: string;
}

/**
 * Enhanced autonomous agent configuration
 */
interface AutonomousAgentConfig {
  maxRetries: number;
  retryDelay: number;
  enableSelfCorrection: boolean;
  enableToolGuidance: boolean;
  enableProgressTracking: boolean;
  maxToolCalls: number;
  confidenceThreshold: number;
}

/**
 * Tool execution attempt tracking
 */
interface ToolExecutionAttempt {
  attempt: number;
  toolName: string;
  arguments: any;
  error?: string;
  success: boolean;
  timestamp: Date;
}

/**
 * Agent execution context
 */
interface AgentExecutionContext {
  originalQuery: string;
  attempts: ToolExecutionAttempt[];
  toolsAvailable: string[];
  currentStep: number;
  maxSteps: number;
  progressLog: string[];
}

export class ClaraApiService {
  private client: AssistantAPIClient | null = null;
  private currentProvider: ClaraProvider | null = null;
  
  // Enhanced autonomous agent configuration
  private agentConfig: AutonomousAgentConfig = {
    maxRetries: 3,
    retryDelay: 1000,
    enableSelfCorrection: true,
    enableToolGuidance: true,
    enableProgressTracking: true,
    maxToolCalls: 10,
    confidenceThreshold: 0.7
  };

  constructor() {
    this.initializeFromConfig();
  }

  /**
   * Initialize API service from database configuration
   */
  private async initializeFromConfig() {
    try {
      const primaryProvider = await this.getPrimaryProvider();
      if (primaryProvider) {
        this.updateProvider(primaryProvider);
      }
    } catch (error) {
      console.warn('Failed to load primary provider:', error);
    }
  }

  /**
   * Update API client for a specific provider
   */
  public updateProvider(provider: ClaraProvider) {
    this.currentProvider = provider;
    this.client = new AssistantAPIClient(provider.baseUrl || '', {
      apiKey: provider.apiKey || '',
      providerId: provider.id // Pass provider ID for tool error tracking
    });
  }

  /**
   * Get available providers from database
   */
  public async getProviders(): Promise<ClaraProvider[]> {
    try {
      const dbProviders = await db.getAllProviders();
      
      // Convert DB providers to Clara providers
      const claraProviders: ClaraProvider[] = dbProviders.map(provider => ({
        id: provider.id,
        name: provider.name,
        type: provider.type as ClaraProviderType,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        isEnabled: provider.isEnabled,
        isPrimary: provider.isPrimary,
        config: provider.config
      }));

      // If no providers exist, create default ones
      if (claraProviders.length === 0) {
        await this.initializeDefaultProviders();
        return this.getProviders();
      }

      return claraProviders;
    } catch (error) {
      console.error('Failed to get providers:', error);
      return [];
    }
  }

  /**
   * Get available models from all providers or a specific provider
   */
  public async getModels(providerId?: string): Promise<ClaraModel[]> {
    const models: ClaraModel[] = [];
    const providers = await this.getProviders();
    
    // Filter providers based on providerId parameter
    const targetProviders = providerId 
      ? providers.filter(p => p.id === providerId && p.isEnabled)
      : providers.filter(p => p.isEnabled);

    for (const provider of targetProviders) {
      try {
        // Create temporary client for this provider
        const tempClient = new AssistantAPIClient(provider.baseUrl || '', {
          apiKey: provider.apiKey || '',
          providerId: provider.id // Pass provider ID for tool error tracking
        });
        
        const providerModels = await tempClient.listModels();
        
        for (const model of providerModels) {
          const claraModel: ClaraModel = {
            id: `${provider.id}:${model.id}`,
            name: model.name || model.id,
            provider: provider.id,
            type: this.detectModelType(model.name || model.id),
            size: model.size,
            supportsVision: this.supportsVision(model.name || model.id),
            supportsCode: this.supportsCode(model.name || model.id),
            supportsTools: this.supportsTools(model.name || model.id),
            metadata: {
              digest: model.digest,
              modified_at: model.modified_at
            }
          };
          
          models.push(claraModel);
        }
      } catch (error) {
        console.warn(`Failed to get models from provider ${provider.name}:`, error);
      }
    }

    return models;
  }

  /**
   * Get models from the currently selected provider only
   */
  public async getCurrentProviderModels(): Promise<ClaraModel[]> {
    if (!this.currentProvider) {
      return [];
    }
    
    return this.getModels(this.currentProvider.id);
  }

  /**
   * Send a chat message using the AssistantAPIClient with enhanced autonomous agent capabilities
   */
  public async sendChatMessage(
    message: string,
    config: ClaraAIConfig,
    attachments?: ClaraFileAttachment[],
    systemPrompt?: string,
    conversationHistory?: ClaraMessage[],
    onContentChunk?: (content: string) => void
  ): Promise<ClaraMessage> {
    if (!this.client) {
      throw new Error('No API client configured. Please select a provider.');
    }

    try {
      // Update agent config from session config
      console.log(`🔧 Original agent config:`, this.agentConfig);
      if (config.autonomousAgent) {
        console.log(`🔄 Updating agent config from session config:`, config.autonomousAgent);
        this.agentConfig = {
          maxRetries: config.autonomousAgent.maxRetries,
          retryDelay: config.autonomousAgent.retryDelay,
          enableSelfCorrection: config.autonomousAgent.enableSelfCorrection,
          enableToolGuidance: config.autonomousAgent.enableToolGuidance,
          enableProgressTracking: config.autonomousAgent.enableProgressTracking,
          maxToolCalls: config.autonomousAgent.maxToolCalls,
          confidenceThreshold: config.autonomousAgent.confidenceThreshold
        };
        console.log(`✅ Updated agent config:`, this.agentConfig);
      } else {
        console.log(`⚠️ No autonomousAgent config provided, using defaults`);
      }

      // Initialize agent execution context
      const agentContext: AgentExecutionContext = {
        originalQuery: message,
        attempts: [],
        toolsAvailable: [],
        currentStep: 0,
        maxSteps: this.agentConfig.maxToolCalls,
        progressLog: []
      };

      console.log(`🎯 Agent context initialized with maxSteps: ${agentContext.maxSteps}`);
      console.log(`🔧 Agent config maxToolCalls: ${this.agentConfig.maxToolCalls}`);

      // Process file attachments if any
      const processedAttachments = await this.processFileAttachments(attachments || []);

      // Get the model from config - extract the actual model name after provider prefix
      let modelId = config.models.text || 'llama2';
      
      // If the model ID includes the provider prefix (e.g., "ollama:qwen3:30b"), 
      // extract everything after the first colon to get the actual model name
      if (modelId.includes(':')) {
        const parts = modelId.split(':');
        // Remove the provider part (first element) and rejoin the rest
        const originalModelId = modelId;
        modelId = parts.slice(1).join(':');
        console.log(`Model ID extraction: "${originalModelId}" -> "${modelId}"`);
      }
      
      console.log(`🤖 Starting autonomous agent with model: "${modelId}"`);
      console.log('🔧 Agent configuration:', this.agentConfig);

      // Get tools if enabled
      let tools: Tool[] = [];
      if (config.features.enableTools) {
        const dbTools = await db.getEnabledTools();
        tools = dbTools;
        
        // Add MCP tools if enabled
        if (config.features.enableMCP && config.mcp?.enableTools) {
          console.log('🔧 MCP is enabled, attempting to add MCP tools...');
          try {
            // Ensure MCP service is ready
            if (claraMCPService.isReady()) {
              console.log('✅ MCP service is ready');
              
              // Get enabled servers from config
              const enabledServers = config.mcp.enabledServers || [];
              console.log('📋 Enabled MCP servers from config:', enabledServers);
              
              // Check server availability and provide feedback
              const serverSummary = claraMCPService.getServerAvailabilitySummary(enabledServers);
              console.log('🔍 Server availability summary:', serverSummary);
              
              // Provide UI feedback about server status
              if (onContentChunk && (serverSummary.unavailable.length > 0 || enabledServers.length === 0)) {
                let feedbackMessage = '\n🔧 **MCP Server Status:**\n';
                
                if (enabledServers.length === 0) {
                  feedbackMessage += '⚠️ No MCP servers configured. Using all available servers.\n';
                } else {
                  if (serverSummary.available.length > 0) {
                    feedbackMessage += `✅ Available: ${serverSummary.available.join(', ')} (${serverSummary.totalTools} tools)\n`;
                  }
                  
                  if (serverSummary.unavailable.length > 0) {
                    feedbackMessage += '❌ Unavailable servers:\n';
                    for (const unavailable of serverSummary.unavailable) {
                      feedbackMessage += `   • ${unavailable.server}: ${unavailable.reason}\n`;
                    }
                  }
                }
                
                feedbackMessage += '\n';
                onContentChunk(feedbackMessage);
              }
              
              // Get tools only from enabled and running servers
              const mcpTools = claraMCPService.getToolsFromEnabledServers(enabledServers.length > 0 ? enabledServers : undefined);
              console.log(`🛠️ Found ${mcpTools.length} MCP tools from enabled/running servers:`, mcpTools.map(t => `${t.server}:${t.name}`));
              
              if (mcpTools.length === 0) {
                console.warn('⚠️ No MCP tools available from enabled/running servers');
                if (onContentChunk) {
                  onContentChunk('⚠️ **No MCP tools available** - all configured servers are offline or disabled.\n\n');
                }
              } else {
                // Convert only the filtered tools to OpenAI format
                const mcpOpenAITools = claraMCPService.convertSpecificToolsToOpenAIFormat(mcpTools);
                console.log(`🔄 Converted and validated ${mcpOpenAITools.length} OpenAI format tools`);
                
                // Convert to Tool format for compatibility
                const mcpToolsFormatted: Tool[] = mcpOpenAITools.map(tool => ({
                  id: tool.function.name,
                  name: tool.function.name,
                  description: tool.function.description,
                  parameters: Object.entries(tool.function.parameters.properties || {}).map(([name, prop]: [string, any]) => ({
                    name,
                    type: prop.type || 'string',
                    description: prop.description || '',
                    required: tool.function.parameters.required?.includes(name) || false
                  })),
                  implementation: 'mcp', // Mark as MCP tool for special handling
                  isEnabled: true
                }));
                
                const beforeCount = tools.length;
                tools = [...tools, ...mcpToolsFormatted];
                console.log(`📈 Added ${mcpToolsFormatted.length} MCP tools to existing ${beforeCount} tools (total: ${tools.length})`);
                
                // Provide UI feedback about loaded tools
                if (onContentChunk && mcpToolsFormatted.length > 0) {
                  const toolsByServer = mcpToolsFormatted.reduce((acc, tool) => {
                    const serverName = tool.name.split('_')[1]; // Extract server name from mcp_server_tool format
                    acc[serverName] = (acc[serverName] || 0) + 1;
                    return acc;
                  }, {} as Record<string, number>);
                  
                  let toolsMessage = `🛠️ **Loaded ${mcpToolsFormatted.length} MCP tools:**\n`;
                  for (const [server, count] of Object.entries(toolsByServer)) {
                    toolsMessage += `   • ${server}: ${count} tools\n`;
                  }
                  toolsMessage += '\n';
                  onContentChunk(toolsMessage);
                }
                
                // Update agent context with available tools
                agentContext.toolsAvailable = tools.map(t => t.name);
              }
            } else {
              console.warn('⚠️ MCP service not ready, skipping MCP tools');
              if (onContentChunk) {
                onContentChunk('⚠️ **MCP service not ready** - skipping MCP tools. Please check your MCP configuration.\n\n');
              }
            }
          } catch (error) {
            console.error('❌ Error adding MCP tools:', error);
            if (onContentChunk) {
              onContentChunk(`❌ **Error loading MCP tools:** ${error instanceof Error ? error.message : 'Unknown error'}\n\n`);
            }
          }
        } else {
          console.log('🚫 MCP tools disabled:', {
            enableMCP: config.features.enableMCP,
            enableTools: config.mcp?.enableTools
          });
          if (onContentChunk && config.features.enableMCP === false) {
            onContentChunk('ℹ️ **MCP tools disabled** in configuration.\n\n');
          }
        }
      }

      // Check if autonomous agent mode is enabled
      const isAutonomousMode = config.autonomousAgent?.enabled !== false;
      
      if (isAutonomousMode) {
        console.log(`🤖 Autonomous agent mode enabled - using enhanced workflow`);
        
        // Add notification for autonomous mode start
        addInfoNotification(
          'Autonomous Mode Activated',
          'Clara is now operating in autonomous mode with enhanced capabilities.',
          3000
        );
        
        // Enhanced system prompt with autonomous agent capabilities
        const enhancedSystemPrompt = this.buildEnhancedSystemPrompt(systemPrompt, tools, agentContext);

        // Prepare initial messages array
        const messages: ChatMessage[] = [];
        
        // Add enhanced system prompt
        messages.push({
          role: 'system',
          content: enhancedSystemPrompt
        });

        // Add conversation history if provided
        if (conversationHistory && conversationHistory.length > 0) {
          // Convert Clara messages to ChatMessage format, excluding the last message since it's the current one
          const historyMessages = conversationHistory.slice(0, -1);
          for (const historyMessage of historyMessages) {
            const chatMessage: ChatMessage = {
              role: historyMessage.role,
              content: historyMessage.content
            };

            // Add images if the message has image attachments
            if (historyMessage.attachments) {
              const imageAttachments = historyMessage.attachments.filter(att => att.type === 'image');
              if (imageAttachments.length > 0) {
                chatMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
              }
            }

            messages.push(chatMessage);
          }
        }

        // Add the current user message
        const currentMessage = conversationHistory && conversationHistory.length > 0 
          ? conversationHistory[conversationHistory.length - 1] 
          : null;

        const userMessage: ChatMessage = {
          role: 'user',
          content: currentMessage?.content || message
        };

        // Add images if any attachments are images
        const imageAttachments = processedAttachments.filter(att => att.type === 'image');
        if (imageAttachments.length > 0) {
          userMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
        } else if (currentMessage?.attachments) {
          const historyImageAttachments = currentMessage.attachments.filter(att => att.type === 'image');
          if (historyImageAttachments.length > 0) {
            userMessage.images = historyImageAttachments.map(att => att.base64 || att.url || '');
          }
        }

        messages.push(userMessage);

        console.log(`🚀 Starting autonomous agent execution with ${messages.length} messages and ${tools.length} tools`);

        // Execute autonomous agent workflow
        const result = await this.executeAutonomousAgent(
          modelId, 
          messages, 
          tools, 
          config, 
          agentContext,
          onContentChunk
        );

        // Add completion notification for autonomous mode
        const toolsUsed = result.metadata?.toolsUsed || [];
        const agentSteps = result.metadata?.agentSteps || 1;
        
        addCompletionNotification(
          'Autonomous Agent Complete',
          `Completed in ${agentSteps} steps${toolsUsed.length > 0 ? ` using ${toolsUsed.length} tools` : ''}.`,
          5000
        );

        return result;
        
      } else {
        console.log(`💬 Standard chat mode - using direct execution`);
        
        // Standard system prompt without autonomous agent features
        const standardSystemPrompt = systemPrompt || 'You are Clara, a helpful AI assistant.';

        // Prepare messages array for standard chat
        const messages: ChatMessage[] = [];
        
        // Add standard system prompt
              messages.push({
          role: 'system',
          content: standardSystemPrompt
        });

        // Add conversation history if provided
        if (conversationHistory && conversationHistory.length > 0) {
          // Convert Clara messages to ChatMessage format, excluding the last message since it's the current one
          const historyMessages = conversationHistory.slice(0, -1);
          for (const historyMessage of historyMessages) {
            const chatMessage: ChatMessage = {
              role: historyMessage.role,
              content: historyMessage.content
            };

            // Add images if the message has image attachments
            if (historyMessage.attachments) {
              const imageAttachments = historyMessage.attachments.filter(att => att.type === 'image');
              if (imageAttachments.length > 0) {
                chatMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
              }
            }

            messages.push(chatMessage);
          }
        }

        // Add the current user message
        const currentMessage = conversationHistory && conversationHistory.length > 0 
          ? conversationHistory[conversationHistory.length - 1] 
          : null;

        const userMessage: ChatMessage = {
          role: 'user',
          content: currentMessage?.content || message
        };

        // Add images if any attachments are images
        const imageAttachments = processedAttachments.filter(att => att.type === 'image');
        if (imageAttachments.length > 0) {
          userMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
        } else if (currentMessage?.attachments) {
          const historyImageAttachments = currentMessage.attachments.filter(att => att.type === 'image');
          if (historyImageAttachments.length > 0) {
            userMessage.images = historyImageAttachments.map(att => att.base64 || att.url || '');
          }
        }

        messages.push(userMessage);

        console.log(`💬 Starting standard chat execution with ${messages.length} messages and ${tools.length} tools`);

        // Execute standard chat workflow
        const result = await this.executeStandardChat(
          modelId, 
          messages, 
          tools, 
          config,
          onContentChunk
        );

        return result;
      }

    } catch (error) {
      console.error('Autonomous agent execution failed:', error);
      
      // Check if this is an abort error (user stopped the stream)
      const isAbortError = error instanceof Error && (
        error.message.includes('aborted') ||
        error.message.includes('BodyStreamBuffer was aborted') ||
        error.message.includes('AbortError') ||
        error.name === 'AbortError'
      );
      
      if (isAbortError) {
        console.log('Stream was aborted by user, returning partial content');
        
        return {
          id: `${Date.now()}-aborted`,
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          metadata: {
            model: `${config.provider}:${config.models.text || 'unknown'}`,
            temperature: config.parameters.temperature,
            aborted: true,
            error: 'Stream was stopped by user'
          }
        };
      }
      
      // Return error message only for actual errors (not user aborts)
      return {
        id: `${Date.now()}-error`,
        role: 'assistant',
        content: 'I apologize, but I encountered an error while processing your request. Please try again.',
        timestamp: new Date(),
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        }
      };
    }
  }

  /**
   * Process file attachments by analyzing them locally
   */
  private async processFileAttachments(attachments: ClaraFileAttachment[]): Promise<ClaraFileAttachment[]> {
    const processed = [...attachments];

    for (const attachment of processed) {
      try {
        // For images, we already have base64 or URL - mark as processed
        if (attachment.type === 'image') {
          attachment.processed = true;
          attachment.processingResult = {
            success: true,
            metadata: {
              type: 'image',
              processedAt: new Date().toISOString()
            }
          };
        }

        // For PDFs and documents, we could add text extraction here
        // For now, mark as processed but note that extraction isn't implemented
        if (attachment.type === 'pdf' || attachment.type === 'document') {
          attachment.processed = true;
          attachment.processingResult = {
            success: true,
            extractedText: 'Text extraction not yet implemented in client-side processing.',
            metadata: {
              type: attachment.type,
              processedAt: new Date().toISOString(),
              note: 'Full document processing requires backend integration'
            }
          };
        }

        // For code files, we can analyze the structure
        if (attachment.type === 'code') {
          attachment.processed = true;
          attachment.processingResult = {
            success: true,
            codeAnalysis: {
              language: this.detectCodeLanguage(attachment.name),
              structure: {
                functions: [],
                classes: [],
                imports: []
              },
              metrics: {
                lines: 0,
                complexity: 0
              }
            },
            metadata: {
              type: 'code',
              processedAt: new Date().toISOString()
            }
          };
        }

      } catch (error) {
        attachment.processed = false;
        attachment.processingResult = {
          success: false,
          error: error instanceof Error ? error.message : 'Processing failed'
        };
      }
    }

    return processed;
  }

  /**
   * Execute tool calls using the Clara tools system
   */
  private async executeToolCalls(toolCalls: any[]): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      try {
        const functionName = toolCall.function?.name;
        
        // Add detailed debug logging for tool call structure
        console.log(`🔍 [DEBUG] Raw tool call object:`, JSON.stringify(toolCall, null, 2));
        console.log(`🔍 [DEBUG] Function name:`, functionName);
        console.log(`🔍 [DEBUG] Raw arguments:`, toolCall.function?.arguments);
        console.log(`🔍 [DEBUG] Arguments type:`, typeof toolCall.function?.arguments);
        
        // Safely parse arguments with better error handling
        let args = {};
        try {
          if (typeof toolCall.function?.arguments === 'string') {
            const argsString = toolCall.function.arguments.trim();
            console.log(`🔍 [DEBUG] Arguments string (trimmed):`, argsString);
            if (argsString === '' || argsString === 'null' || argsString === 'undefined') {
              args = {};
              console.log(`🔍 [DEBUG] Empty arguments, using empty object`);
            } else {
              args = JSON.parse(argsString);
              console.log(`🔍 [DEBUG] Parsed arguments:`, args);
            }
          } else if (toolCall.function?.arguments && typeof toolCall.function.arguments === 'object') {
            args = toolCall.function.arguments;
            console.log(`🔍 [DEBUG] Using object arguments directly:`, args);
          } else {
            args = {};
            console.log(`🔍 [DEBUG] No valid arguments, using empty object`);
          }
        } catch (parseError) {
          console.warn(`⚠️ Failed to parse tool arguments for ${functionName}:`, parseError);
          console.warn(`⚠️ Raw arguments:`, toolCall.function?.arguments);
          args = {};
        }

        // Check for malformed tool calls
        if (!functionName || functionName.trim() === '') {
          console.warn('⚠️ Skipping malformed tool call with empty function name:', toolCall);
          const result = {
            toolName: 'unknown',
            success: false,
            error: 'Tool call has empty or missing function name'
          };
          results.push(result);
          continue;
        }

        console.log(`🔧 Executing tool: ${functionName} with args:`, args);

        // Check if this is an MCP tool call
        if (functionName?.startsWith('mcp_')) {
          console.log(`🔧 [API] Processing MCP tool call: ${functionName}`);
          try {
            // Add debug logging before parsing
            console.log(`🔍 [API] Tool call before parsing:`, JSON.stringify(toolCall, null, 2));
            console.log(`🔍 [API] Parsed args before MCP:`, args);
            
            // Parse MCP tool calls and execute them
            console.log(`🔍 [API] Parsing tool call:`, toolCall);
            const mcpToolCalls = claraMCPService.parseOpenAIToolCalls([toolCall]);
            console.log(`📋 [API] Parsed MCP tool calls:`, mcpToolCalls);
            
            if (mcpToolCalls.length > 0) {
              console.log(`📡 [API] Executing MCP tool call:`, mcpToolCalls[0]);
              console.log(`🔍 [API] MCP tool call arguments:`, mcpToolCalls[0].arguments);
              const mcpResult = await claraMCPService.executeToolCall(mcpToolCalls[0]);
              console.log(`📥 [API] MCP execution result:`, mcpResult);
              
              // Process the MCP result comprehensively
              const processedResult = this.processMCPToolResult(mcpResult, functionName);
              
              const result = {
                toolName: functionName,
                success: mcpResult.success,
                result: processedResult.result,
                error: mcpResult.error,
                artifacts: processedResult.artifacts,
                images: processedResult.images,
                toolMessage: processedResult.toolMessage,
                metadata: {
                  type: 'mcp',
                  server: mcpToolCalls[0].server,
                  toolName: mcpToolCalls[0].name,
                  ...mcpResult.metadata
                }
              };

              console.log(`✅ MCP tool ${functionName} result:`, result);
              results.push(result);
            } else {
              console.error(`❌ [API] Failed to parse MCP tool call`);
              const result = {
                toolName: functionName,
                success: false,
                error: 'Failed to parse MCP tool call'
              };
              console.log(`❌ MCP tool ${functionName} failed:`, result);
              results.push(result);
            }
          } catch (mcpError) {
            console.error(`❌ [API] MCP tool execution error:`, mcpError);
            const result = {
              toolName: functionName,
              success: false,
              error: mcpError instanceof Error ? mcpError.message : 'MCP tool execution failed'
            };
            console.log(`❌ MCP tool ${functionName} error:`, result);
            results.push(result);
          }
          continue;
        }

        // Try to execute with Clara tools first
        const claraTool = defaultTools.find(tool => tool.name === functionName || tool.id === functionName);
        
        if (claraTool) {
          const result = await executeTool(claraTool.id, args);
          console.log(`✅ Clara tool ${functionName} result:`, result);
          results.push({
            toolName: functionName,
            success: result.success,
            result: result.result,
            error: result.error
          });
        } else {
          // Try database tools as fallback
          const dbTools = await db.getEnabledTools();
          const dbTool = dbTools.find(tool => tool.name === functionName);
          
          if (dbTool) {
            // Execute database tool (simplified implementation)
            try {
              const funcBody = `return (async () => {
                ${dbTool.implementation}
                return await implementation(args);
              })();`;
              const testFunc = new Function('args', funcBody);
              const result = await testFunc(args);
              
              console.log(`✅ Database tool ${functionName} result:`, result);
              results.push({
                toolName: functionName,
                success: true,
                result: result
              });
            } catch (error) {
              const result = {
                toolName: functionName,
                success: false,
                error: error instanceof Error ? error.message : 'Tool execution failed'
              };
              console.log(`❌ Database tool ${functionName} error:`, result);
              results.push(result);
            }
          } else {
            const result = {
              toolName: functionName,
              success: false,
              error: `Tool '${functionName}' not found`
            };
            console.log(`❌ Tool ${functionName} not found:`, result);
            results.push(result);
          }
        }
      } catch (error) {
        const result = {
          toolName: toolCall.function?.name || 'unknown',
          success: false,
          error: error instanceof Error ? error.message : 'Tool execution failed'
        };
        console.log(`❌ Tool execution error for ${toolCall.function?.name || 'unknown'}:`, result);
        results.push(result);
      }
    }

    console.log(`🔧 Tool execution summary: ${results.length} tools executed, ${results.filter(r => r.success).length} successful, ${results.filter(r => !r.success).length} failed`);
    return results;
  }

  /**
   * Parse tool results into artifacts if appropriate
   */
  private parseToolResultsToArtifacts(toolResults: any[]): ClaraArtifact[] {
    const artifacts: ClaraArtifact[] = [];

    for (const result of toolResults) {
      if (result.success) {
        // Add MCP artifacts if available
        if (result.artifacts && Array.isArray(result.artifacts)) {
          artifacts.push(...result.artifacts);
        }
        
        // Create artifacts for other tool results
        if (result.result && typeof result.result === 'object' && !result.artifacts) {
          artifacts.push({
            id: `tool-result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'json',
            title: `${result.toolName} Result`,
            content: JSON.stringify(result.result, null, 2),
            createdAt: new Date(),
            metadata: {
              toolName: result.toolName,
              toolExecuted: true
            }
          });
        }
      }
    }

    return artifacts;
  }

  /**
   * Detect code language from filename
   */
  private detectCodeLanguage(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop();
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'swift': 'swift',
      'kt': 'kotlin'
    };
    return langMap[ext || ''] || 'text';
  }

  /**
   * Detect model type based on model name
   */
  private detectModelType(modelName: string): 'text' | 'vision' | 'code' | 'embedding' | 'multimodal' {
    const name = modelName.toLowerCase();
    
    if (name.includes('vision') || name.includes('llava') || name.includes('gpt-4-vision')) {
      return 'vision';
    }
    
    if (name.includes('code') || name.includes('coder') || name.includes('codellama')) {
      return 'code';
    }
    
    if (name.includes('embed') || name.includes('embedding')) {
      return 'embedding';
    }
    
    if (name.includes('gpt-4') || name.includes('claude') || name.includes('multimodal')) {
      return 'multimodal';
    }
    
    return 'text';
  }

  /**
   * Check if model supports vision
   */
  private supportsVision(modelName: string): boolean {
    // Remove filter - allow all models to be used for vision tasks
    return true;
  }

  /**
   * Check if model supports code generation
   */
  private supportsCode(modelName: string): boolean {
    // Remove filter - allow all models to be used for code tasks  
    return true;
  }

  /**
   * Check if model supports tool calling
   */
  private supportsTools(modelName: string): boolean {
    const name = modelName.toLowerCase();
    return name.includes('gpt-4') || 
           name.includes('gpt-3.5-turbo') ||
           name.includes('claude-3') ||
           name.includes('gemini');
  }

  /**
   * Initialize default providers if none exist
   */
  private async initializeDefaultProviders(): Promise<void> {
    try {
      const defaultProviders = [
        {
          name: 'Ollama (Local)',
          type: 'ollama' as ClaraProviderType,
          baseUrl: 'http://localhost:11434',
          isEnabled: true,
          isPrimary: true
        },
        {
          name: 'OpenAI',
          type: 'openai' as ClaraProviderType,
          baseUrl: 'https://api.openai.com/v1',
          isEnabled: false,
          isPrimary: false
        },
        {
          name: 'OpenRouter',
          type: 'openrouter' as ClaraProviderType,
          baseUrl: 'https://openrouter.ai/api/v1',
          isEnabled: false,
          isPrimary: false
        }
      ];

      for (const provider of defaultProviders) {
        await db.addProvider(provider);
      }
    } catch (error) {
      console.error('Failed to initialize default providers:', error);
    }
  }

  /**
   * Get primary provider
   */
  public async getPrimaryProvider(): Promise<ClaraProvider | null> {
    try {
      const dbProvider = await db.getPrimaryProvider();
      if (!dbProvider) return null;

      return {
        id: dbProvider.id,
        name: dbProvider.name,
        type: dbProvider.type as ClaraProviderType,
        baseUrl: dbProvider.baseUrl,
        apiKey: dbProvider.apiKey,
        isEnabled: dbProvider.isEnabled,
        isPrimary: dbProvider.isPrimary,
        config: dbProvider.config
      };
    } catch (error) {
      console.error('Failed to get primary provider:', error);
      return null;
    }
  }

  /**
   * Set primary provider
   */
  public async setPrimaryProvider(providerId: string): Promise<void> {
    try {
      await db.setPrimaryProvider(providerId);
      
      // Update current client to use new primary provider
      const newPrimary = await this.getPrimaryProvider();
      if (newPrimary) {
        this.updateProvider(newPrimary);
      }
    } catch (error) {
      console.error('Failed to set primary provider:', error);
      throw error;
    }
  }

  /**
   * Health check for current provider
   */
  public async healthCheck(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      return await this.client.checkConnection();
    } catch (error) {
      console.warn('Provider health check failed:', error);
      return false;
    }
  }

  /**
   * Test connection to a provider
   */
  public async testProvider(provider: ClaraProvider): Promise<boolean> {
    try {
      const testClient = new AssistantAPIClient(provider.baseUrl || '', {
        apiKey: provider.apiKey || '',
        providerId: provider.id // Pass provider ID for tool error tracking
      });
      
      return await testClient.checkConnection();
    } catch (error) {
      console.warn(`Provider ${provider.name} connection test failed:`, error);
      return false;
    }
  }

  /**
   * Stop the current chat generation
   */
  public stop(): void {
    if (this.client) {
      // The client extends APIClient which has the abortStream method
      const apiClient = this.client as any;
      if (typeof apiClient.abortStream === 'function') {
        apiClient.abortStream();
        console.log('Stream aborted successfully');
      } else {
        console.warn('AbortStream method not available on client');
      }
    } else {
      console.warn('No client available to abort');
    }
  }

  /**
   * Get current API client instance
   */
  public getCurrentClient(): AssistantAPIClient | null {
    return this.client;
  }

  /**
   * Get current provider
   */
  public getCurrentProvider(): ClaraProvider | null {
    return this.currentProvider;
  }

  /**
   * Build enhanced system prompt with autonomous agent capabilities
   */
  private buildEnhancedSystemPrompt(
    originalPrompt: string | undefined, 
    tools: Tool[], 
    context: AgentExecutionContext
  ): string {
    const toolsList = tools.map(tool => {
      const requiredParams = tool.parameters.filter(p => p.required).map(p => p.name);
      const optionalParams = tool.parameters.filter(p => !p.required).map(p => p.name);
      
      return `- ${tool.name}: ${tool.description}
  Required: ${requiredParams.join(', ') || 'none'}
  Optional: ${optionalParams.join(', ') || 'none'}`;
    }).join('\n');

    const enhancedPrompt = `${originalPrompt || 'You are Clara, a helpful AI assistant.'} 

🤖 AUTONOMOUS AGENT MODE ACTIVATED 🤖

You are now operating as an advanced autonomous agent with the following capabilities:

CORE PRINCIPLES:
1. **Persistence**: If a tool call fails, analyze the error and retry with corrected parameters
2. **Self-Correction**: Learn from errors and adjust your approach automatically  
3. **Tool Mastery**: Use tools effectively by carefully reading their descriptions and requirements
4. **Progress Tracking**: Keep the user informed of your progress and reasoning

AVAILABLE TOOLS:
${toolsList || 'No tools available'}

TOOL USAGE GUIDELINES:
- **Always double-check tool names** - they must match exactly (case-sensitive)
- **Validate all required parameters** before making tool calls
- **If a tool fails**, analyze the error message and retry with corrections
- **Use descriptive reasoning** - explain what you're doing and why
- **Chain tools logically** - use outputs from one tool as inputs to another when appropriate

ERROR HANDLING PROTOCOL:
1. If a tool call fails due to misspelling, immediately retry with the correct spelling
2. If parameters are missing/invalid, retry with proper parameters
3. If a tool doesn't exist, suggest alternatives or explain limitations
4. Maximum ${this.agentConfig.maxRetries} retries per tool before moving to alternatives

RESPONSE FORMAT:
- Start with your reasoning and plan
- Clearly indicate when you're using tools
- Explain any errors and how you're fixing them
- Provide a comprehensive final answer

Remember: You are autonomous and capable. Take initiative, solve problems step by step, and don't give up easily!`;

    return enhancedPrompt;
  }

  /**
   * Execute autonomous agent workflow with retry mechanisms and self-correction
   */
  private async executeAutonomousAgent(
    modelId: string,
    messages: ChatMessage[],
    tools: Tool[],
    config: ClaraAIConfig,
    context: AgentExecutionContext,
    onContentChunk?: (content: string) => void
  ): Promise<ClaraMessage> {
    const options = {
      temperature: config.parameters.temperature,
      max_tokens: config.parameters.maxTokens,
      top_p: config.parameters.topP
    };

    let responseContent = '';
    let totalTokens = 0;
    let allToolResults: any[] = [];
    let conversationMessages = [...messages];
    
    // Track processed tool call IDs to prevent duplicates
    const processedToolCallIds = new Set<string>();

    // Progress tracking
    if (onContentChunk && this.agentConfig.enableProgressTracking) {
      onContentChunk('🤖 **Autonomous Agent Activated**\n\n');
    }

    console.log(`🔍 Starting autonomous agent loop with maxSteps: ${context.maxSteps}`);
    
    // Ensure we always make at least one call, even if maxSteps is 0
    // If tools are available, ensure at least 2 steps (initial call + follow-up after tools)
    const minStepsNeeded = tools.length > 0 ? 2 : 1;
    const actualMaxSteps = Math.max(context.maxSteps, minStepsNeeded);
    console.log(`🔧 Adjusted maxSteps from ${context.maxSteps} to ${actualMaxSteps} (min needed: ${minStepsNeeded} due to ${tools.length} tools available)`);

    // Main agent execution loop
    for (let step = 0; step < actualMaxSteps; step++) {
      context.currentStep = step;
      
      console.log(`🔄 Autonomous agent step ${step + 1}/${actualMaxSteps} starting...`);
      console.log(`📝 Current conversation messages:`, conversationMessages.length);
      console.log(`🛠️ Available tools:`, tools.length);
      
      try {
        if (onContentChunk && this.agentConfig.enableProgressTracking && step > 0) {
          onContentChunk(`\n🔄 **Step ${step + 1}**: Continuing analysis...\n\n`);
        }

        let stepResponse;
        let finishReason = '';

        console.log(`🚀 About to make LLM call with model: ${modelId}`);
        console.log(`⚙️ Options:`, options);
        console.log(`🔧 Streaming enabled:`, config.features.enableStreaming);

        // Try streaming first if enabled
        if (config.features.enableStreaming) {
          // Check if we should disable streaming for this provider when tools are present
          const shouldDisableStreamingForTools = this.shouldDisableStreamingForTools(tools);
          
          if (shouldDisableStreamingForTools) {
            console.log(`🔄 Disabling streaming for ${this.currentProvider?.type} provider with tools present`);
            if (onContentChunk) {
              onContentChunk('⚠️ Switching to non-streaming mode for better tool support with this provider...\n\n');
            }
            // Use non-streaming mode
            stepResponse = await this.client!.sendChat(modelId, conversationMessages, options, tools);
            const stepContent = stepResponse.message?.content || '';
            responseContent += stepContent;
            totalTokens = stepResponse.usage?.total_tokens || 0;
            
            if (onContentChunk && stepContent) {
              onContentChunk(stepContent);
            }
            console.log(`✅ Non-streaming completed. Content: ${stepContent.length} chars, Tool calls: ${stepResponse.message?.tool_calls?.length || 0}`);
          } else {
            // Use streaming mode
            try {
              console.log(`📡 Starting streaming chat...`);
              const collectedToolCalls: any[] = [];
              let stepContent = '';

              for await (const chunk of this.client!.streamChat(modelId, conversationMessages, options, tools)) {
                console.log(`📦 [STREAM-DEBUG] Received chunk:`, JSON.stringify(chunk, null, 2));
                if (chunk.message?.content) {
                  stepContent += chunk.message.content;
                  if (onContentChunk) {
                    onContentChunk(chunk.message.content);
                  }
                }

                // Collect tool calls
                if (chunk.message?.tool_calls) {
                  console.log(`🔧 [STREAM] Processing tool calls in chunk:`, chunk.message.tool_calls);
                  for (const toolCall of chunk.message.tool_calls) {
                    console.log(`🔧 [STREAM] Processing individual tool call:`, toolCall);
                    
                    // Skip tool calls without valid IDs or names
                    if (!toolCall.id && !toolCall.function?.name) {
                      console.log(`⚠️ [STREAM] Skipping tool call without ID or name:`, toolCall);
                      continue;
                    }
                    
                    let existingCall = collectedToolCalls.find(c => c.id === toolCall.id);
                    if (!existingCall) {
                      existingCall = {
                        id: toolCall.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        type: toolCall.type || 'function',
                        function: { name: '', arguments: '' }
                      };
                      collectedToolCalls.push(existingCall);
                      console.log(`✅ [STREAM] Created new tool call:`, existingCall);
                    }
                    
                    // Update function name if provided
                    if (toolCall.function?.name) {
                      console.log(`🔧 [STREAM] Updating function name from "${existingCall.function.name}" to "${toolCall.function.name}"`);
                      existingCall.function.name = toolCall.function.name;
                    }
                    
                    // Accumulate arguments if provided
                    if (toolCall.function?.arguments) {
                      console.log(`🔧 [STREAM] Accumulating arguments: "${existingCall.function.arguments}" + "${toolCall.function.arguments}"`);
                      existingCall.function.arguments += toolCall.function.arguments;
                      console.log(`🔧 [STREAM] New accumulated arguments: "${existingCall.function.arguments}"`);
                    }
                    
                    console.log(`📊 [STREAM] Current state of existingCall:`, existingCall);
                  }
                  console.log(`📊 [STREAM] Current collectedToolCalls:`, collectedToolCalls);
                }

                if (chunk.finish_reason) {
                  finishReason = chunk.finish_reason;
                  console.log(`🏁 Stream finished with reason:`, finishReason);
                }
                if (chunk.usage?.total_tokens) {
                  totalTokens = chunk.usage.total_tokens;
                }
              }

              stepResponse = {
                message: {
                  content: stepContent,
                  tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined
                },
                usage: { total_tokens: totalTokens }
              };
              responseContent += stepContent;
              console.log(`✅ Streaming completed. Content length: ${stepContent.length}, Tool calls: ${collectedToolCalls.length}`);
              console.log(`📊 [STREAM] Final collectedToolCalls:`, JSON.stringify(collectedToolCalls, null, 2));

              // Filter out incomplete tool calls
              if (stepResponse.message?.tool_calls) {
                stepResponse.message.tool_calls = stepResponse.message.tool_calls.filter(toolCall => {
                  // Must have a valid function name
                  if (!toolCall.function?.name || toolCall.function.name.trim() === '') {
                    console.warn('⚠️ Filtering out tool call with empty function name:', toolCall);
                    return false;
                  }
                  
                  // Must have valid arguments (at least empty object)
                  if (typeof toolCall.function.arguments !== 'string') {
                    console.warn('⚠️ Filtering out tool call with invalid arguments type:', toolCall);
                    return false;
                  }
                  
                  // Try to parse arguments to ensure they're valid JSON
                  try {
                    JSON.parse(toolCall.function.arguments || '{}');
                    return true;
                  } catch (parseError) {
                    console.warn('⚠️ Filtering out tool call with invalid JSON arguments:', toolCall, parseError);
                    return false;
                  }
                });
                
                // If no valid tool calls remain, remove the tool_calls property
                if (stepResponse.message.tool_calls.length === 0) {
                  stepResponse.message.tool_calls = undefined;
                }
              }

            } catch (streamError: any) {
              console.error(`❌ Streaming error:`, streamError);
              // Fallback to non-streaming if streaming fails with tools
              const errorMessage = streamError.message?.toLowerCase() || '';
              if (errorMessage.includes('stream') && errorMessage.includes('tool') && tools.length > 0) {
                console.log(`🔄 Falling back to non-streaming mode...`);
                if (onContentChunk) {
                  onContentChunk('\n⚠️ Switching to non-streaming mode for tool support... (Probably due to your server not supporting streaming with tools)\n\n');
                }
                stepResponse = await this.client!.sendChat(modelId, conversationMessages, options, tools);
                responseContent += stepResponse.message?.content || '';
                totalTokens = stepResponse.usage?.total_tokens || 0;
                console.log(`✅ Non-streaming fallback completed. Content: ${stepResponse.message?.content?.length || 0} chars`);
              } else {
                throw streamError;
              }
            }
          }
        } else {
          // Non-streaming mode
          console.log(`📞 Making non-streaming chat call...`);
          stepResponse = await this.client!.sendChat(modelId, conversationMessages, options, tools);
          const stepContent = stepResponse.message?.content || '';
          responseContent += stepContent;
          totalTokens = stepResponse.usage?.total_tokens || 0;
          
          console.log(`✅ Non-streaming completed. Content: ${stepContent.length} chars, Tool calls: ${stepResponse.message?.tool_calls?.length || 0}`);
          
          if (onContentChunk && stepContent) {
            onContentChunk(stepContent);
          }
        }

        console.log(`📊 Step ${step + 1} response:`, {
          contentLength: stepResponse.message?.content?.length || 0,
          toolCallsCount: stepResponse.message?.tool_calls?.length || 0,
          finishReason
        });

        // Handle tool calls with retry mechanism
        if (stepResponse.message?.tool_calls && stepResponse.message.tool_calls.length > 0) {
          console.log(`🔧 Processing ${stepResponse.message.tool_calls.length} tool calls...`);
          console.log(`🔧 Tool call IDs:`, stepResponse.message.tool_calls.map((tc: any) => ({ id: tc.id, name: tc.function?.name })));
          console.log(`🔧 Already processed IDs:`, Array.from(processedToolCallIds));
          
          if (onContentChunk) {
            onContentChunk('\n\n🔧 **Executing tools...**\n\n');
          }

          // Add assistant message with tool calls
          conversationMessages.push({
            role: 'assistant',
            content: stepResponse.message.content || '',
            tool_calls: stepResponse.message.tool_calls
          });

          // Execute tools with enhanced retry logic
          const toolResults = await this.executeToolCallsWithRetry(
            stepResponse.message.tool_calls, 
            context,
            onContentChunk
          );

          // Add tool results to conversation with deduplication
          // IMPORTANT: OpenAI requires a tool message for EVERY tool call ID, even if the tool fails
          for (const toolCall of stepResponse.message.tool_calls) {
            // Check if we've already processed this tool call ID
            if (processedToolCallIds.has(toolCall.id)) {
              console.warn(`⚠️ Skipping duplicate tool call ID: ${toolCall.id} for tool: ${toolCall.function?.name}`);
              continue;
            }

            // Mark this tool call ID as processed
            processedToolCallIds.add(toolCall.id);

            // Find the corresponding result for this tool call
            const result = toolResults.find(r => r.toolName === toolCall.function?.name);
            
            if (result) {
              // Use the processed tool message if available, otherwise fallback to basic format
              if (result.toolMessage) {
                // Use the comprehensive tool message with images and proper formatting
                const toolMessage = {
                  ...result.toolMessage,
                  tool_call_id: toolCall.id
                };
                conversationMessages.push(toolMessage);
                console.log(`✅ Added MCP tool message for ${result.toolName} with tool_call_id: ${toolCall.id}`);
              } else {
                // Fallback to basic format for non-MCP tools
                // Ensure we always have valid content for OpenAI
                let content: string;
                if (result.success && result.result !== undefined && result.result !== null) {
                  content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
                } else {
                  // For failed tools or tools with no result
                  content = result.error || `Tool ${result.toolName} execution failed`;
                }
                
                const toolMessage = {
                  role: 'tool' as const,
                  content: content,
                  name: result.toolName,
                  tool_call_id: toolCall.id
                };
                conversationMessages.push(toolMessage);
                console.log(`✅ Added basic tool message for ${result.toolName} with tool_call_id: ${toolCall.id}`);
              }
            } else {
              // No result found for this tool call - create a failure message
              // This ensures every tool call ID has a corresponding tool message
              console.warn(`⚠️ No result found for tool call ${toolCall.id} (${toolCall.function?.name}), creating failure message`);
              
              const failureMessage = {
                role: 'tool' as const,
                content: `Tool execution failed: No result returned for ${toolCall.function?.name || 'unknown tool'}`,
                name: toolCall.function?.name || 'unknown_tool',
                tool_call_id: toolCall.id
              };
              conversationMessages.push(failureMessage);
              console.log(`✅ Added failure tool message for ${toolCall.function?.name} with tool_call_id: ${toolCall.id}`);
            }
          }

          allToolResults.push(...toolResults);
          
          console.log(`🔧 After processing tools, conversation has ${conversationMessages.length} messages`);
          console.log(`🔧 Processed tool call IDs now:`, Array.from(processedToolCallIds));

          if (onContentChunk) {
            onContentChunk('✅ **Tools executed successfully**\n\n');
          }

          console.log(`🔄 Continuing to next step after tool execution...`);
          console.log(`📊 Current step: ${step}, actualMaxSteps: ${actualMaxSteps}, will continue: ${step + 1 < actualMaxSteps}`);
          // Continue to next iteration for follow-up response
          continue;
        }

        console.log(`🏁 No tool calls found, autonomous agent execution complete.`);
        // If no tool calls, we're done
        break;

      } catch (error) {
        console.error(`❌ Agent step ${step + 1} failed:`, error);
        
        // Check if this is a duplicate tool_call_id error
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Duplicate value for \'tool_call_id\'') || errorMessage.includes('duplicate')) {
          console.error(`🚨 Detected duplicate tool_call_id error. Processed IDs:`, Array.from(processedToolCallIds));
          
          if (onContentChunk) {
            onContentChunk(`\n❌ **Error**: Duplicate tool call detected. This indicates a system issue that has been logged for debugging.\n\n`);
          }
          
          // Try to recover by clearing processed IDs and continuing
          processedToolCallIds.clear();
          console.log(`🔄 Cleared processed tool call IDs, attempting to continue...`);
          
          // If we have tool results, try to provide a meaningful response
          if (allToolResults.length > 0) {
            const successfulResults = allToolResults.filter(r => r.success);
            const failedResults = allToolResults.filter(r => !r.success);
            
            let errorSummary = `I encountered a technical issue while processing the tools, but I was able to execute ${successfulResults.length} tools successfully`;
            if (failedResults.length > 0) {
              errorSummary += ` and ${failedResults.length} tools failed`;
            }
            errorSummary += '. Here\'s what I found:\n\n';
            
            // Add successful results
            for (const result of successfulResults) {
              if (result.result) {
                errorSummary += `**${result.toolName}**: ${typeof result.result === 'string' ? result.result : JSON.stringify(result.result)}\n\n`;
              }
            }
            
            // Add failed results
            for (const result of failedResults) {
              errorSummary += `**${result.toolName}** (failed): ${result.error || 'Unknown error'}\n\n`;
            }
            
            responseContent += errorSummary;
            
            if (onContentChunk) {
              onContentChunk(errorSummary);
            }
          }
          
          break; // Exit the loop to prevent further errors
        }
        
        if (onContentChunk) {
          onContentChunk(`\n❌ **Error in step ${step + 1}**: ${errorMessage}\n\n`);
        }

        // Try to recover or break if too many failures
        if (step >= this.agentConfig.maxRetries) {
          console.log(`💥 Max retries reached, breaking out of agent loop`);
          
          // Add error notification for max retries reached
          addErrorNotification(
            'Autonomous Mode Error',
            `Maximum retries reached. Some operations may have failed.`,
            8000
          );
          
          // Provide a meaningful error message to the user
          // Provide a meaningful error message to the user
          const errorSummary = `I encountered repeated errors during execution. Here's what I was able to accomplish:\n\n`;
          let finalSummary = errorSummary;
          
          if (allToolResults.length > 0) {
            const successfulResults = allToolResults.filter(r => r.success);
            const failedResults = allToolResults.filter(r => !r.success);
            
            finalSummary += `✅ Successfully executed ${successfulResults.length} tools\n`;
            finalSummary += `❌ Failed to execute ${failedResults.length} tools\n\n`;
            
            if (successfulResults.length > 0) {
              finalSummary += `**Successful results:**\n`;
              for (const result of successfulResults) {
                if (result.result) {
                  finalSummary += `- **${result.toolName}**: ${typeof result.result === 'string' ? result.result.substring(0, 200) : JSON.stringify(result.result).substring(0, 200)}...\n`;
                }
              }
            }
          } else {
            finalSummary += `Unfortunately, I wasn't able to execute any tools successfully due to technical issues.`;
          }
          
          responseContent += finalSummary;
          
          if (onContentChunk) {
            onContentChunk(finalSummary);
          }
          
          break;
        }
      }
    }

    console.log(`🎯 Autonomous agent execution completed. Response content length: ${responseContent.length}, Tool results: ${allToolResults.length}`);
    console.log(`🔚 Loop ended at step ${context.currentStep + 1}/${actualMaxSteps}`);

    // Create final Clara message with better error handling
    const claraMessage: ClaraMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      content: responseContent || 'I completed the autonomous agent execution, but encountered some technical issues. Please try again or contact support if the problem persists.',
      timestamp: new Date(),
      metadata: {
        model: `${config.provider}:${modelId}`,
        tokens: totalTokens,
        temperature: config.parameters.temperature,
        toolsUsed: allToolResults.map(tc => tc.toolName),
        agentSteps: context.currentStep + 1,
        autonomousMode: true,
        processedToolCallIds: Array.from(processedToolCallIds),
        toolResultsSummary: {
          total: allToolResults.length,
          successful: allToolResults.filter(r => r.success).length,
          failed: allToolResults.filter(r => !r.success).length
        }
      }
    };

    // Add artifacts if any were generated from tool calls
    if (allToolResults.length > 0) {
      claraMessage.artifacts = this.parseToolResultsToArtifacts(allToolResults);
    }

    return claraMessage;
  }

  /**
   * Execute tool calls with enhanced retry mechanism and error correction
   */
  private async executeToolCallsWithRetry(
    toolCalls: any[], 
    context: AgentExecutionContext,
    onContentChunk?: (content: string) => void
  ): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      const functionName = toolCall.function?.name;
      
      // Safely parse arguments with better error handling
      let args = {};
      try {
        if (typeof toolCall.function?.arguments === 'string') {
          const argsString = toolCall.function.arguments.trim();
          if (argsString === '' || argsString === 'null' || argsString === 'undefined') {
            args = {};
          } else {
            args = JSON.parse(argsString);
          }
        } else if (toolCall.function?.arguments && typeof toolCall.function.arguments === 'object') {
          args = toolCall.function.arguments;
        } else {
          args = {};
        }
      } catch (parseError) {
        console.warn(`⚠️ Failed to parse tool arguments for ${functionName}:`, parseError);
        console.warn(`⚠️ Raw arguments:`, toolCall.function?.arguments);
        if (onContentChunk) {
          onContentChunk(`⚠️ **Argument parsing failed for ${functionName}**: ${parseError}\n`);
        }
        results.push({
          toolName: functionName,
          success: false,
          error: `Failed to parse arguments: ${parseError}`
        });
        continue;
      }

      // Retry mechanism for each tool call
      let lastError = '';
      let success = false;
      let result = null;

      for (let attempt = 1; attempt <= this.agentConfig.maxRetries; attempt++) {
        try {
          // Track attempt
          const attemptRecord: ToolExecutionAttempt = {
            attempt,
            toolName: functionName,
            arguments: args,
            success: false,
            timestamp: new Date()
          };

          if (onContentChunk && attempt > 1) {
            onContentChunk(`🔄 **Retry ${attempt}/${this.agentConfig.maxRetries}** for ${functionName}\n`);
          }

          // Check if this is an MCP tool call
          if (functionName?.startsWith('mcp_')) {
            const mcpToolCalls = claraMCPService.parseOpenAIToolCalls([toolCall]);
            
            if (mcpToolCalls.length > 0) {
              const mcpResult = await claraMCPService.executeToolCall(mcpToolCalls[0]);
              
              if (mcpResult.success) {
                // Process the MCP result comprehensively
                const processedResult = this.processMCPToolResult(mcpResult, functionName);
                
                result = {
                  toolName: functionName,
                  success: true,
                  result: processedResult.result,
                  artifacts: processedResult.artifacts,
                  images: processedResult.images,
                  toolMessage: processedResult.toolMessage,
                  metadata: {
                    type: 'mcp',
                    server: mcpToolCalls[0].server,
                    toolName: mcpToolCalls[0].name,
                    attempts: attempt,
                    ...mcpResult.metadata
                  }
                };
                success = true;
                attemptRecord.success = true;
                console.log(`✅ MCP tool ${functionName} succeeded on attempt ${attempt}:`, result);
              } else {
                lastError = mcpResult.error || 'MCP tool execution failed';
                attemptRecord.error = lastError;
                console.log(`❌ MCP tool ${functionName} failed on attempt ${attempt}:`, lastError);
              }
            } else {
              lastError = 'Failed to parse MCP tool call';
              attemptRecord.error = lastError;
            }
          } else {
            // Regular tool execution
            const claraTool = defaultTools.find(tool => tool.name === functionName || tool.id === functionName);
            
            if (claraTool) {
              const toolResult = await executeTool(claraTool.id, args);
              if (toolResult.success) {
                result = {
                  toolName: functionName,
                  success: true,
                  result: toolResult.result,
                  metadata: { attempts: attempt }
                };
                success = true;
                attemptRecord.success = true;
                console.log(`✅ Clara tool ${functionName} succeeded on attempt ${attempt}:`, result);
              } else {
                lastError = toolResult.error || 'Tool execution failed';
                attemptRecord.error = lastError;
                console.log(`❌ Clara tool ${functionName} failed on attempt ${attempt}:`, lastError);
              }
            } else {
              // Try database tools
              const dbTools = await db.getEnabledTools();
              const dbTool = dbTools.find(tool => tool.name === functionName);
              
              if (dbTool) {
                try {
                  const funcBody = `return (async () => {
                    ${dbTool.implementation}
                    return await implementation(args);
                  })();`;
                  const testFunc = new Function('args', funcBody);
                  const dbResult = await testFunc(args);
                  
                  result = {
                    toolName: functionName,
                    success: true,
                    result: dbResult,
                    metadata: { attempts: attempt }
                  };
                  success = true;
                  attemptRecord.success = true;
                  console.log(`✅ Database tool ${functionName} succeeded on attempt ${attempt}:`, result);
                } catch (dbError) {
                  lastError = dbError instanceof Error ? dbError.message : 'Database tool execution failed';
                  attemptRecord.error = lastError;
                  console.log(`❌ Database tool ${functionName} failed on attempt ${attempt}:`, lastError);
                }
              } else {
                lastError = `Tool '${functionName}' not found. Available tools: ${context.toolsAvailable.join(', ')}`;
                attemptRecord.error = lastError;
              }
            }
          }

          context.attempts.push(attemptRecord);

          if (success) {
            if (onContentChunk && attempt > 1) {
              onContentChunk(`✅ **Success** on attempt ${attempt}\n`);
            }
            break;
          }

          // Wait before retry
          if (attempt < this.agentConfig.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, this.agentConfig.retryDelay));
          }

        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Unknown error occurred';
          context.attempts.push({
            attempt,
            toolName: functionName,
            arguments: args,
            error: lastError,
            success: false,
            timestamp: new Date()
          });

          if (onContentChunk) {
            onContentChunk(`❌ **Attempt ${attempt} failed**: ${lastError}\n`);
          }
        }
      }

      // Add final result
      if (success && result) {
        console.log(`🎯 Final result for ${functionName}:`, result);
        results.push(result);
      } else {
        const finalResult = {
          toolName: functionName,
          success: false,
          error: lastError,
          metadata: { attempts: this.agentConfig.maxRetries }
        };
        console.log(`💥 Final failure for ${functionName}:`, finalResult);
        results.push(finalResult);
        
        if (onContentChunk) {
          onContentChunk(`💥 **Tool ${functionName} failed after ${this.agentConfig.maxRetries} attempts**: ${lastError}\n\n`);
        }
      }
    }

    console.log(`🔧 Autonomous tool execution summary: ${results.length} tools executed, ${results.filter(r => r.success).length} successful, ${results.filter(r => !r.success).length} failed`);
    return results;
  }

  /**
   * Execute standard chat workflow (non-autonomous mode)
   */
  private async executeStandardChat(
    modelId: string,
    messages: ChatMessage[],
    tools: Tool[],
    config: ClaraAIConfig,
    onContentChunk?: (content: string) => void
  ): Promise<ClaraMessage> {
    const options = {
      temperature: config.parameters.temperature,
      max_tokens: config.parameters.maxTokens,
      top_p: config.parameters.topP
    };

    let responseContent = '';
    let totalTokens = 0;
    let toolResults: any[] = [];

    try {
      let response;

      // Try streaming first if enabled
      if (config.features.enableStreaming) {
        // Check if we should disable streaming for this provider when tools are present
        const shouldDisableStreamingForTools = this.shouldDisableStreamingForTools(tools);
        
        if (shouldDisableStreamingForTools) {
          console.log(`🔄 Disabling streaming for ${this.currentProvider?.type} provider with tools present`);
          if (onContentChunk) {
            onContentChunk('⚠️ Switching to non-streaming mode for better tool support with this provider...\n\n');
          }
          // Use non-streaming mode
          response = await this.client!.sendChat(modelId, messages, options, tools);
          responseContent = response.message?.content || '';
          totalTokens = response.usage?.total_tokens || 0;
          
          if (onContentChunk && responseContent) {
            onContentChunk(responseContent);
          }
          console.log(`✅ Non-streaming completed. Content: ${responseContent.length} chars, Tool calls: ${response.message?.tool_calls?.length || 0}`);
        } else {
          // Use streaming mode
          try {
            const collectedToolCalls: any[] = [];
            let streamContent = '';

            for await (const chunk of this.client!.streamChat(modelId, messages, options, tools)) {
              console.log(`📦 [STREAM-DEBUG] Received chunk:`, JSON.stringify(chunk, null, 2));
              if (chunk.message?.content) {
                streamContent += chunk.message.content;
                responseContent += chunk.message.content;
                if (onContentChunk) {
                  onContentChunk(chunk.message.content);
                }
              }

              // Collect tool calls
              if (chunk.message?.tool_calls) {
                console.log(`🔧 [STANDARD-STREAM] Processing tool calls in chunk:`, chunk.message.tool_calls);
                for (const toolCall of chunk.message.tool_calls) {
                  console.log(`🔧 [STANDARD-STREAM] Processing individual tool call:`, toolCall);
                  
                  // Skip tool calls without valid IDs or names
                  if (!toolCall.id && !toolCall.function?.name) {
                    console.log(`⚠️ [STANDARD-STREAM] Skipping tool call without ID or name:`, toolCall);
                    continue;
                  }
                  
                  let existingCall = collectedToolCalls.find(c => c.id === toolCall.id);
                  if (!existingCall) {
                    existingCall = {
                      id: toolCall.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                      type: toolCall.type || 'function',
                      function: { name: '', arguments: '' }
                    };
                    collectedToolCalls.push(existingCall);
                    console.log(`✅ [STANDARD-STREAM] Created new tool call:`, existingCall);
                  }
                  
                  // Update function name if provided
                  if (toolCall.function?.name) {
                    console.log(`🔧 [STANDARD-STREAM] Updating function name from "${existingCall.function.name}" to "${toolCall.function.name}"`);
                    existingCall.function.name = toolCall.function.name;
                  }
                  
                  // Accumulate arguments if provided
                  if (toolCall.function?.arguments) {
                    console.log(`🔧 [STANDARD-STREAM] Accumulating arguments: "${existingCall.function.arguments}" + "${toolCall.function.arguments}"`);
                    existingCall.function.arguments += toolCall.function.arguments;
                    console.log(`🔧 [STANDARD-STREAM] New accumulated arguments: "${existingCall.function.arguments}"`);
                  }
                  
                  console.log(`📊 [STANDARD-STREAM] Current state of existingCall:`, existingCall);
                }
                console.log(`📊 [STANDARD-STREAM] Current collectedToolCalls:`, collectedToolCalls);
              }

              if (chunk.usage?.total_tokens) {
                totalTokens = chunk.usage.total_tokens;
              }
            }

            response = {
              message: {
                content: streamContent,
                tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined
              },
              usage: { total_tokens: totalTokens }
            };

            // Filter out incomplete tool calls
            if (response.message?.tool_calls) {
              response.message.tool_calls = response.message.tool_calls.filter(toolCall => {
                // Must have a valid function name
                if (!toolCall.function?.name || toolCall.function.name.trim() === '') {
                  console.warn('⚠️ Filtering out tool call with empty function name:', toolCall);
                  return false;
                }
                
                // Must have valid arguments (at least empty object)
                if (typeof toolCall.function.arguments !== 'string') {
                  console.warn('⚠️ Filtering out tool call with invalid arguments type:', toolCall);
                  return false;
                }
                
                // Try to parse arguments to ensure they're valid JSON
                try {
                  JSON.parse(toolCall.function.arguments || '{}');
                  return true;
                } catch (parseError) {
                  console.warn('⚠️ Filtering out tool call with invalid JSON arguments:', toolCall, parseError);
                  return false;
                }
              });
              
              // If no valid tool calls remain, remove the tool_calls property
              if (response.message.tool_calls.length === 0) {
                response.message.tool_calls = undefined;
              }
            }

          } catch (streamError: any) {
            // Fallback to non-streaming if streaming fails with tools
            const errorMessage = streamError.message?.toLowerCase() || '';
            if (errorMessage.includes('stream') && errorMessage.includes('tool') && tools.length > 0) {
              if (onContentChunk) {
                onContentChunk('\n⚠️ Switching to non-streaming mode for tool support... (Probably due to your server not supporting streaming with tools)\n\n');
              }
              response = await this.client!.sendChat(modelId, messages, options, tools);
              responseContent = response.message?.content || '';
              totalTokens = response.usage?.total_tokens || 0;
              
              if (onContentChunk && responseContent) {
                onContentChunk(responseContent);
              }
            } else {
              throw streamError;
            }
          }
        }
      } else {
        // Non-streaming mode
        response = await this.client!.sendChat(modelId, messages, options, tools);
        responseContent = response.message?.content || '';
        totalTokens = response.usage?.total_tokens || 0;
        
        if (onContentChunk && responseContent) {
          onContentChunk(responseContent);
        }
      }

      // Handle tool calls if any (simple execution, no retry logic)
      if (response.message?.tool_calls && response.message.tool_calls.length > 0) {
        if (onContentChunk) {
          onContentChunk('\n\n🔧 **Executing tools...**\n\n');
        }

        toolResults = await this.executeToolCalls(response.message.tool_calls);

        if (onContentChunk) {
          onContentChunk('✅ **Tools executed**\n\n');
        }

        // After tool execution, make a follow-up request to process the results
        if (toolResults.length > 0) {
          console.log(`🔄 Making follow-up request to process ${toolResults.length} tool results`);
          
          // Build conversation with tool results
          const followUpMessages = [...messages];
          
          // Add the assistant's message with tool calls
          followUpMessages.push({
            role: 'assistant',
            content: response.message.content || '',
            tool_calls: response.message.tool_calls
          });
          
          // Add tool results - IMPORTANT: OpenAI requires a tool message for EVERY tool call ID
          for (const toolCall of response.message.tool_calls) {
            // Find the corresponding result for this tool call
            const result = toolResults.find(r => r.toolName === toolCall.function?.name);
            
            if (result) {
              // Use the processed tool message if available, otherwise fallback to basic format
              if (result.toolMessage) {
                // Use the comprehensive tool message with images and proper formatting
                const toolMessage = {
                  ...result.toolMessage,
                  tool_call_id: toolCall.id
                };
                followUpMessages.push(toolMessage);
                console.log(`✅ Added MCP tool message for ${result.toolName} with tool_call_id: ${toolCall.id}`);
              } else {
                // Fallback to basic format for non-MCP tools
                // Ensure we always have valid content for OpenAI
                let content: string;
                if (result.success && result.result !== undefined && result.result !== null) {
                  content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
                } else {
                  // For failed tools or tools with no result
                  content = result.error || `Tool ${result.toolName} execution failed`;
                }
                
                followUpMessages.push({
                  role: 'tool',
                  content: content,
                  name: result.toolName,
                  tool_call_id: toolCall.id
                });
                console.log(`✅ Added basic tool message for ${result.toolName} with tool_call_id: ${toolCall.id}`);
              }
            } else {
              // No result found for this tool call - create a failure message
              // This ensures every tool call ID has a corresponding tool message
              console.warn(`⚠️ No result found for tool call ${toolCall.id} (${toolCall.function?.name}), creating failure message`);
              
              followUpMessages.push({
                role: 'tool',
                content: `Tool execution failed: No result returned for ${toolCall.function?.name || 'unknown tool'}`,
                name: toolCall.function?.name || 'unknown_tool',
                tool_call_id: toolCall.id
              });
              console.log(`✅ Added failure tool message for ${toolCall.function?.name} with tool_call_id: ${toolCall.id}`);
            }
          }

          console.log(`📤 Sending follow-up request with ${followUpMessages.length} messages`);
          
          // Make follow-up request (always non-streaming to avoid complexity)
          try {
            const followUpResponse = await this.client!.sendChat(modelId, followUpMessages, options);
            const followUpContent = followUpResponse.message?.content || '';
            
            if (followUpContent) {
              responseContent += followUpContent;
              totalTokens += followUpResponse.usage?.total_tokens || 0;
              
              if (onContentChunk) {
                onContentChunk(followUpContent);
              }
              
              console.log(`✅ Follow-up response received: ${followUpContent.length} chars`);
            }
          } catch (followUpError) {
            console.error('❌ Follow-up request failed:', followUpError);
            if (onContentChunk) {
              onContentChunk('\n⚠️ Failed to process tool results, but tools were executed successfully.\n');
            }
          }
        }
      }

    } catch (error) {
      console.error('Standard chat execution failed:', error);
      responseContent = 'I apologize, but I encountered an error while processing your request. Please try again.';
    }

    // Create final Clara message
    const claraMessage: ClaraMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      content: responseContent || 'I apologize, but I was unable to generate a response.',
      timestamp: new Date(),
      metadata: {
        model: `${config.provider}:${modelId}`,
        tokens: totalTokens,
        temperature: config.parameters.temperature,
        toolsUsed: toolResults.map(tc => tc.toolName),
        autonomousMode: false
      }
    };

    // Add artifacts if any were generated from tool calls
    if (toolResults.length > 0) {
      claraMessage.artifacts = this.parseToolResultsToArtifacts(toolResults);
    }

    return claraMessage;
  }

  /**
   * Check if we should disable streaming for this provider when tools are present
   */
  private shouldDisableStreamingForTools(tools: Tool[]): boolean {
    // If no tools are present, streaming is fine
    if (!tools || tools.length === 0) {
      return false;
    }

    // If no current provider, default to disabling streaming with tools
    if (!this.currentProvider) {
      return true;
    }

    // Check provider type and base URL to determine if it's OpenAI-like
    const providerType = this.currentProvider.type?.toLowerCase();
    const baseUrl = this.currentProvider.baseUrl?.toLowerCase() || '';

    // Disable streaming for OpenAI-like providers when tools are present
    // These providers stream tool call arguments incrementally which causes issues
    const isOpenAILike = 
      providerType === 'openai' ||
      providerType === 'openrouter' ||
      baseUrl.includes('openai.com') ||
      baseUrl.includes('openrouter.ai') ||
      baseUrl.includes('api.anthropic.com') ||
      baseUrl.includes('generativelanguage.googleapis.com'); // Google AI

    if (isOpenAILike) {
      console.log(`🔧 Detected OpenAI-like provider (${providerType}, ${baseUrl}), disabling streaming with tools`);
      return true;
    }

    // Keep streaming enabled for local providers like Ollama/llama.cpp
    // These providers handle tool calls correctly in streaming mode
    const isLocalProvider = 
      providerType === 'ollama' ||
      baseUrl.includes('localhost') ||
      baseUrl.includes('127.0.0.1') ||
      baseUrl.includes('0.0.0.0');

    if (isLocalProvider) {
      console.log(`🔧 Detected local provider (${providerType}, ${baseUrl}), keeping streaming enabled with tools`);
      return false;
    }

    // For unknown providers, default to disabling streaming with tools to be safe
    console.log(`🔧 Unknown provider type (${providerType}, ${baseUrl}), defaulting to disable streaming with tools`);
    return true;
  }

  /**
   * Process MCP tool results to handle all content types (text, images, files, etc.)
   */
  private processMCPToolResult(mcpResult: ClaraMCPToolResult, toolName: string): {
    result: any;
    artifacts: ClaraArtifact[];
    images: string[];
    toolMessage: ChatMessage;
  } {
    const artifacts: ClaraArtifact[] = [];
    const images: string[] = [];
    let textContent = '';
    let structuredResult: any = {};

    if (mcpResult.success && mcpResult.content) {
      console.log(`🔍 [MCP-PROCESS] Processing ${mcpResult.content.length} content items for ${toolName}`);
      
      for (let i = 0; i < mcpResult.content.length; i++) {
        const contentItem = mcpResult.content[i];
        console.log(`🔍 [MCP-PROCESS] Content item ${i}:`, contentItem);
        
        switch (contentItem.type) {
          case 'text':
            if (contentItem.text) {
              textContent += (textContent ? '\n\n' : '') + contentItem.text;
              structuredResult.text = contentItem.text;
            }
            break;
            
          case 'image':
            if (contentItem.data && contentItem.mimeType) {
              console.log(`🖼️ [MCP-PROCESS] Processing image: ${contentItem.mimeType}`);
              
              // Add to images array for AI model
              const imageData = contentItem.data.startsWith('data:') 
                ? contentItem.data 
                : `data:${contentItem.mimeType};base64,${contentItem.data}`;
              images.push(imageData);
              
              // Create artifact for the image using 'json' type since 'image' is not supported
              artifacts.push({
                id: `mcp-image-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type: 'json',
                title: `${toolName} - Image Result`,
                content: JSON.stringify({
                  type: 'image',
                  mimeType: contentItem.mimeType,
                  data: imageData,
                  description: `Image generated by ${toolName}`
                }, null, 2),
                createdAt: new Date(),
                metadata: {
                  toolName,
                  mimeType: contentItem.mimeType,
                  source: 'mcp',
                  contentIndex: i,
                  originalType: 'image'
                }
              });
              
              // Add to structured result
              if (!structuredResult.images) structuredResult.images = [];
              structuredResult.images.push({
                mimeType: contentItem.mimeType,
                data: contentItem.data,
                url: imageData
              });
              
              // Add description to text content
              textContent += (textContent ? '\n\n' : '') + `📷 Image generated (${contentItem.mimeType})`;
            }
            break;
            
          case 'resource':
            if ((contentItem as any).resource) {
              console.log(`📄 [MCP-PROCESS] Processing resource:`, (contentItem as any).resource);
              
              // Create artifact for the resource
              artifacts.push({
                id: `mcp-resource-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type: 'json',
                title: `${toolName} - Resource Result`,
                content: JSON.stringify((contentItem as any).resource, null, 2),
                createdAt: new Date(),
                metadata: {
                  toolName,
                  source: 'mcp',
                  contentIndex: i,
                  originalType: 'resource'
                }
              });
              
              // Add to structured result
              structuredResult.resource = (contentItem as any).resource;
              
              // Add description to text content
              textContent += (textContent ? '\n\n' : '') + `📄 Resource: ${JSON.stringify((contentItem as any).resource, null, 2)}`;
            }
            break;
            
          default:
            // Handle any additional content types that might be returned by MCP servers
            // even if they're not in the official type definition
            console.log(`🔍 [MCP-PROCESS] Processing additional content type: ${contentItem.type}`);
            
            if ((contentItem as any).data) {
              console.log(`📊 [MCP-PROCESS] Processing data content`);
              
              let contentData = (contentItem as any).data;
              if (typeof contentData === 'string') {
                try {
                  contentData = JSON.parse(contentData);
                } catch (e) {
                  console.warn('Failed to parse data content:', e);
                }
              }
              
              // Create artifact for the data
              artifacts.push({
                id: `mcp-data-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type: 'json',
                title: `${toolName} - ${contentItem.type} Result`,
                content: JSON.stringify(contentData, null, 2),
                createdAt: new Date(),
                metadata: {
                  toolName,
                  source: 'mcp',
                  contentIndex: i,
                  originalType: contentItem.type
                }
              });
              
              // Add to structured result
              structuredResult.data = contentData;
              
              // Add description to text content
              textContent += (textContent ? '\n\n' : '') + `📊 ${contentItem.type}: ${JSON.stringify(contentData, null, 2)}`;
            } else if (contentItem.text || (contentItem as any).data) {
              // Handle any other content with text or data
              const content = contentItem.text || JSON.stringify((contentItem as any).data);
              textContent += (textContent ? '\n\n' : '') + `❓ ${contentItem.type}: ${content}`;
              structuredResult[`${contentItem.type}_${i}`] = contentItem;
            }
            break;
        }
      }
    }

    // Fallback if no content was processed
    if (!textContent && Object.keys(structuredResult).length === 0) {
      textContent = mcpResult.success ? 'MCP tool executed successfully' : (mcpResult.error || 'MCP tool execution failed');
      structuredResult = { message: textContent };
    }

    // Create the tool message for the conversation
    const toolMessage: ChatMessage = {
      role: 'tool',
      content: textContent,
      name: toolName
    };

    // Add images to the tool message if any
    if (images.length > 0) {
      toolMessage.images = images;
      console.log(`🖼️ [MCP-PROCESS] Added ${images.length} images to tool message`);
    }

    console.log(`✅ [MCP-PROCESS] Processed MCP result for ${toolName}:`, {
      textLength: textContent.length,
      artifactsCount: artifacts.length,
      imagesCount: images.length,
      structuredKeys: Object.keys(structuredResult)
    });

    return {
      result: Object.keys(structuredResult).length > 1 ? structuredResult : textContent,
      artifacts,
      images,
      toolMessage
    };
  }

  /**
   * Validate and sanitize OpenAI tools to prevent schema errors
   */
  private validateAndSanitizeOpenAITools(tools: any[]): any[] {
    const validatedTools: any[] = [];

    for (const tool of tools) {
      try {
        console.log(`🔍 [TOOL-VALIDATION] Validating tool: ${tool.function?.name}`);
        
        // Basic structure validation
        if (!tool.type || tool.type !== 'function') {
          console.warn(`⚠️ [TOOL-VALIDATION] Skipping tool with invalid type: ${tool.type}`);
          continue;
        }

        if (!tool.function) {
          console.warn(`⚠️ [TOOL-VALIDATION] Skipping tool without function property`);
          continue;
        }

        const func = tool.function;

        // Validate function name
        if (!func.name || typeof func.name !== 'string' || func.name.trim() === '') {
          console.warn(`⚠️ [TOOL-VALIDATION] Skipping tool with invalid name: ${func.name}`);
          continue;
        }

        // Validate description
        if (!func.description || typeof func.description !== 'string') {
          console.warn(`⚠️ [TOOL-VALIDATION] Tool ${func.name} missing description, adding default`);
          func.description = `Tool: ${func.name}`;
        }

        // Validate and fix parameters
        if (!func.parameters) {
          console.warn(`⚠️ [TOOL-VALIDATION] Tool ${func.name} missing parameters, adding default`);
          func.parameters = {
            type: 'object',
            properties: {},
            required: []
          };
        } else {
          // Sanitize parameters schema
          func.parameters = this.sanitizeParametersSchema(func.parameters, func.name);
        }

        // Validate the final tool structure
        const validation = this.validateToolStructure(tool);
        if (!validation.isValid) {
          console.error(`❌ [TOOL-VALIDATION] Tool ${func.name} failed final validation:`, validation.errors);
          
          // Create a minimal fallback tool
          const fallbackTool = {
            type: 'function',
            function: {
              name: func.name,
              description: `${func.description} (Schema validation failed)`,
              parameters: {
                type: 'object',
                properties: {},
                required: []
              }
            }
          };
          
          console.log(`🔧 [TOOL-VALIDATION] Created fallback tool for ${func.name}`);
          validatedTools.push(fallbackTool);
        } else {
          console.log(`✅ [TOOL-VALIDATION] Tool ${func.name} passed validation`);
          validatedTools.push(tool);
        }

      } catch (error) {
        console.error(`❌ [TOOL-VALIDATION] Error validating tool:`, error, tool);
        // Skip this tool entirely if we can't even process it
      }
    }

    console.log(`🔧 [TOOL-VALIDATION] Validated ${validatedTools.length}/${tools.length} tools`);
    return validatedTools;
  }

  /**
   * Sanitize parameters schema to ensure OpenAI compatibility
   */
  private sanitizeParametersSchema(schema: any, toolName: string): any {
    if (!schema || typeof schema !== 'object') {
      console.warn(`⚠️ [SCHEMA-SANITIZE] Tool ${toolName}: Invalid schema, using default`);
      return {
        type: 'object',
        properties: {},
        required: []
      };
    }

    // Deep clone to avoid modifying original
    const sanitized = JSON.parse(JSON.stringify(schema));

    // Ensure required top-level properties
    if (!sanitized.type) {
      sanitized.type = 'object';
    }
    if (sanitized.type !== 'object') {
      console.warn(`⚠️ [SCHEMA-SANITIZE] Tool ${toolName}: Top-level type must be 'object', fixing`);
      sanitized.type = 'object';
    }
    if (!sanitized.properties) {
      sanitized.properties = {};
    }
    if (!sanitized.required) {
      sanitized.required = [];
    }

    // Sanitize properties
    if (sanitized.properties && typeof sanitized.properties === 'object') {
      for (const [propName, propSchema] of Object.entries(sanitized.properties)) {
        if (propSchema && typeof propSchema === 'object') {
          const prop = propSchema as any;
          
          // Fix array properties missing 'items'
          if (prop.type === 'array' && !prop.items) {
            console.log(`🔧 [SCHEMA-SANITIZE] Tool ${toolName}: Adding missing 'items' for array property '${propName}'`);
            
            // Smart type detection for items
            let itemsType = 'string'; // Default
            if (propName.toLowerCase().includes('number') || propName.toLowerCase().includes('id')) {
              itemsType = 'number';
            } else if (propName.toLowerCase().includes('boolean') || propName.toLowerCase().includes('flag')) {
              itemsType = 'boolean';
            }
            
            prop.items = { type: itemsType };
          }

          // Ensure all properties have a type
          if (!prop.type) {
            console.log(`🔧 [SCHEMA-SANITIZE] Tool ${toolName}: Adding missing type for property '${propName}'`);
            prop.type = 'string'; // Default to string
          }

          // Validate array items
          if (prop.type === 'array' && prop.items) {
            if (typeof prop.items !== 'object') {
              console.log(`🔧 [SCHEMA-SANITIZE] Tool ${toolName}: Fixing invalid items for array property '${propName}'`);
              prop.items = { type: 'string' };
            } else if (!prop.items.type) {
              console.log(`🔧 [SCHEMA-SANITIZE] Tool ${toolName}: Adding missing type for items in array property '${propName}'`);
              prop.items.type = 'string';
            }
          }

          // Recursively sanitize nested objects
          if (prop.type === 'object' && prop.properties) {
            prop.properties = this.sanitizeParametersSchema(prop, `${toolName}.${propName}`).properties;
          }
        }
      }
    }

    // Validate required array
    if (sanitized.required && Array.isArray(sanitized.required)) {
      sanitized.required = sanitized.required.filter((reqProp: any) => {
        if (typeof reqProp !== 'string') {
          console.warn(`⚠️ [SCHEMA-SANITIZE] Tool ${toolName}: Removing non-string required property: ${reqProp}`);
          return false;
        }
        if (!sanitized.properties || !sanitized.properties[reqProp]) {
          console.warn(`⚠️ [SCHEMA-SANITIZE] Tool ${toolName}: Removing non-existent required property: ${reqProp}`);
          return false;
        }
        return true;
      });
    }

    return sanitized;
  }

  /**
   * Validate tool structure for OpenAI compatibility
   */
  private validateToolStructure(tool: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
      // Check top-level structure
      if (!tool.type || tool.type !== 'function') {
        errors.push('Tool must have type "function"');
      }

      if (!tool.function) {
        errors.push('Tool must have a function property');
        return { isValid: false, errors };
      }

      const func = tool.function;

      // Check function properties
      if (!func.name || typeof func.name !== 'string' || func.name.trim() === '') {
        errors.push('Function must have a valid name');
      }

      if (!func.description || typeof func.description !== 'string') {
        errors.push('Function must have a description');
      }

      if (!func.parameters) {
        errors.push('Function must have parameters');
        return { isValid: false, errors };
      }

      // Validate parameters schema
      const paramErrors = this.validateParametersStructure(func.parameters);
      errors.push(...paramErrors);

    } catch (error) {
      errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate parameters structure recursively
   */
  private validateParametersStructure(schema: any, path: string = 'parameters'): string[] {
    const errors: string[] = [];

    if (!schema || typeof schema !== 'object') {
      errors.push(`${path}: Schema must be an object`);
      return errors;
    }

    // Check required top-level properties
    if (!schema.type) {
      errors.push(`${path}: Missing 'type' property`);
    } else if (schema.type !== 'object') {
      errors.push(`${path}: Top-level type must be 'object'`);
    }

    if (schema.properties !== undefined && typeof schema.properties !== 'object') {
      errors.push(`${path}: 'properties' must be an object`);
    }

    if (schema.required !== undefined && !Array.isArray(schema.required)) {
      errors.push(`${path}: 'required' must be an array`);
    }

    // Validate each property
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (propSchema && typeof propSchema === 'object') {
          const prop = propSchema as any;
          const propPath = `${path}.properties.${propName}`;

          // Check property type
          if (!prop.type) {
            errors.push(`${propPath}: Missing 'type' property`);
          } else {
            // Validate array properties
            if (prop.type === 'array') {
              if (!prop.items) {
                errors.push(`${propPath}: Array type must have 'items' property`);
              } else if (typeof prop.items !== 'object') {
                errors.push(`${propPath}: 'items' must be an object`);
              } else if (!prop.items.type) {
                errors.push(`${propPath}.items: Missing 'type' property`);
              }
            }

            // Validate object properties recursively
            if (prop.type === 'object' && prop.properties) {
              const nestedErrors = this.validateParametersStructure(prop, propPath);
              errors.push(...nestedErrors);
            }
          }
        }
      }
    }

    // Validate required array references existing properties
    if (schema.required && Array.isArray(schema.required) && schema.properties) {
      for (const reqProp of schema.required) {
        if (typeof reqProp !== 'string') {
          errors.push(`${path}: Required property names must be strings`);
        } else if (!schema.properties[reqProp]) {
          errors.push(`${path}: Required property '${reqProp}' does not exist in properties`);
        }
      }
    }

    return errors;
  }
}

// Export singleton instance
export const claraApiService = new ClaraApiService(); 