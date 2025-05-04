#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

// Determine the directory of the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file
const envPath = join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  config({ path: envPath });
} else {
  console.error("Warning: .env file not found at", envPath);
}

// Default host
let host = process.env.MCP_HOST || "stage.adenin.com"; // "localhost:44367"

// Helper function to check if debug mode is enabled
function isDebugMode() {
  return !!process.env.DEBUG || process.env.NODE_ENV === 'development';
}

// Parse command line arguments
const args = process.argv.slice(2);
let endpointIds = [];
let bearerToken = "";

// Parse arguments
for (const arg of args) {
  if (arg.startsWith("--endpoints=")) {
    endpointIds = arg.replace("--endpoints=", "").split(",");
  } else if (arg.startsWith("--token=")) {
    bearerToken = arg.replace("--token=", "");
  } else if (arg.startsWith("--host=")) {
    host = arg.replace("--host=", "");
  }
}

// Use environment variables if not specified in command line arguments
if (endpointIds.length === 0 && process.env.MCP_ENDPOINTS) {
  endpointIds = process.env.MCP_ENDPOINTS.split(",");
}

if (!bearerToken && process.env.MCP_TOKEN) {
  bearerToken = process.env.MCP_TOKEN;
}

// Check if we have the required parameters
if (endpointIds.length === 0 || !bearerToken) {
  console.error("Error: Missing required parameters (endpoints or token)");
  console.error("Usage: node mcp-server.js --endpoints=endpoint1,endpoint2 --token=your_bearer_token [--host=hostname]");
  console.error("Or create a .env file with MCP_ENDPOINTS, MCP_TOKEN, and optionally MCP_HOST");
  
  // Create a sample .env file if it doesn't exist
  const envPath = join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    const sampleEnv = `# MCP Server Configuration
# Host for the API gateway
MCP_HOST=stage.adenin.com

# Comma-separated list of endpoint IDs
MCP_ENDPOINTS=endpoint1,endpoint2

# Bearer token for authentication
MCP_TOKEN=your_bearer_token
`;
    try {
      fs.writeFileSync(envPath, sampleEnv);
      console.error(`Created sample .env file at ${envPath}`);
    } catch (error) {
      console.error("Failed to create sample .env file:", error.message);
    }
  }
  
  process.exit(1);
}

// Create an MCP server
const server = new McpServer({
  name: "Platform API Gateway",
  version: "1.0.0",
  capabilities: {
    tools: {
      listChanged: true
    }
  }
});


// Cache for schemas
const schemaCache = new Map();

// Helper function to fetch schema for an endpoint
async function fetchSchema(endpointId) {
  if (schemaCache.has(endpointId)) {
    return schemaCache.get(endpointId);
  }

  try {
    const response = await fetch(`https://${host}/api/mcp/schema/${endpointId}`, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch schema: ${response.statusText}`);
    }

    const responseData = await response.json();
    
    // Extract the schema from the Data property of the response
    const schema = responseData.Data || responseData;
    
    schemaCache.set(endpointId, schema);
    return schema;
  } catch (error) {
    console.error(`Error fetching schema for ${endpointId}:`, error.message);
    throw error;
  }
}

// Helper function to call an endpoint
async function callEndpoint(endpointId, args) {  try {
    const response = await fetch(`https://${host}/api/mcp/proxy/${endpointId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(args)
    });

    if (!response.ok) {
      throw new Error(`API call failed: ${response.statusText}`);
    }

    const jsonResponse = await response.json();
    
    // Log JSON responses when debug mode is enabled
    if (isDebugMode()) {
      console.error(`Response from ${endpointId}:`, JSON.stringify(jsonResponse, null, 2));
    }

    return jsonResponse;
  } catch (error) {
    console.error(`Error calling endpoint ${endpointId}:`, error.message);
    throw error;
  }
}

// Build tools array based on schema retrieval
const buildToolsArray = async () => {
  const tools = [];
  
  for (const endpointId of endpointIds) {
    try {
      console.error(`Retrieving schema for ${endpointId}...`);
      
      // Fetch the schema for this endpoint
      const schema = await fetchSchema(endpointId);
      
      // Create a zod schema from the JSON schema
      const paramSchema = {};
      
      if (schema.properties) {
        for (const [key, prop] of Object.entries(schema.properties)) {
          // Basic type conversion from JSON schema to Zod
          if (prop.type === "string") {
            let stringSchema = z.string();
            
            // Handle string formats if specified
            if (prop.format === "email") {
              stringSchema = z.string().email();
            } else if (prop.format === "date-time" || prop.format === "date") {
              // Keep as string but describe the format
              stringSchema = stringSchema.describe(`${prop.description || ""} (Format: ${prop.format})`);
            } else if (prop.pattern) {
              // Add regex pattern if specified
              try {
                const regex = new RegExp(prop.pattern);
                stringSchema = z.string().regex(regex);
              } catch (error) {
                console.error(`Invalid regex pattern for ${key}:`, error.message);
              }
            }
            
            paramSchema[key] = stringSchema;
          } else if (prop.type === "number" || prop.type === "integer") {
            let numberSchema = z.number();
            
            // Add min/max constraints if specified
            if (prop.minimum !== undefined) {
              numberSchema = numberSchema.min(prop.minimum);
            }
            if (prop.maximum !== undefined) {
              numberSchema = numberSchema.max(prop.maximum);
            }
            
            paramSchema[key] = numberSchema;
          } else if (prop.type === "boolean") {
            paramSchema[key] = z.boolean();
          } else if (prop.type === "array") {
            // Handle arrays with improved item type handling
            if (prop.items && prop.items.type === "string") {
              paramSchema[key] = z.array(z.string());
            } else if (prop.items && prop.items.type === "number") {
              paramSchema[key] = z.array(z.number());
            } else if (prop.items && prop.items.type === "boolean") {
              paramSchema[key] = z.array(z.boolean());
            } else {
              paramSchema[key] = z.array(z.any());
            }
            
            // Add min/max items constraints if specified
            if (prop.minItems !== undefined) {
              paramSchema[key] = paramSchema[key].min(prop.minItems);
            }
            if (prop.maxItems !== undefined) {
              paramSchema[key] = paramSchema[key].max(prop.maxItems);
            }
          } else if (prop.enum) {
            // Handle enumerated values
            paramSchema[key] = z.enum(prop.enum);
          } else {
            // Default to any
            paramSchema[key] = z.any();
          }
          
          // Add description, combining with example if available
          let description = prop.description || "";
          if (prop.example !== undefined) {
            description += ` (Example: ${JSON.stringify(prop.example)})`;
          }
          if (description) {
            paramSchema[key] = paramSchema[key].describe(description);
          }
          
          // Add default value if specified
          if (prop.default !== undefined) {
            paramSchema[key] = paramSchema[key].default(prop.default);
          }
          
          // Handle required fields
          if (schema.required && !schema.required.includes(key)) {
            paramSchema[key] = paramSchema[key].optional();
          }
        }
      }

      // Add tool definition to array
      tools.push({
        id: endpointId,
        paramSchema: paramSchema,
        description: schema.description || `Tool for ${endpointId}`,
        schema: schema
      });
      
      console.error(`✅ Successfully prepared tool definition for ${endpointId}`);
    } catch (error) {
      console.error(`Failed to prepare tool definition for ${endpointId}:`, error);
    }
  }
  
  return tools;
};

// Register tools with the server
const registerTools = (toolsArray) => {
  for (const tool of toolsArray) {
    try {
      console.error(`Registering tool for ${tool.id}...`);
      
      // Register the tool with the server
      server.tool(
        tool.id,
        tool.description,
        tool.paramSchema,
        async (args) => {
          try {
            const result = await callEndpoint(tool.id, args);
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify(result, null, 2) 
              }]
            };
          } catch (error) {
            return {
              content: [{ 
                type: "text", 
                text: `Error: ${error.message}` 
              }],
              isError: true
            };
          }
        }
      );
      
      console.error(`✅ Successfully registered tool for ${tool.id}`);
       if (isDebugMode()) console.error("schema", tool.schema);
    } catch (error) {
      console.error(`Failed to register tool for ${tool.id}:`, error);
    }
  }
};

// Replace the original setupTools function
const setupTools = async () => {
  const toolsArray = await buildToolsArray();
  registerTools(toolsArray);
};

// Set up the tools and start the server
const start = async () => {
  try {
    // Set up all tools
    await setupTools();
      // Start the server with stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    
    // Display debug mode status
    console.error(`Debug mode: ${isDebugMode() ? 'ENABLED' : 'DISABLED'}`);
    console.error("MCP Server started and ready for connections");
    console.error(`Endpoints available: ${endpointIds.join(", ")}`);
    console.error("To use this server in Claude Desktop:");
    console.error("1. Open your Claude Desktop App configuration at:");
    console.error("   - macOS: ~/Library/Application Support/Claude/claude_desktop_config.json");
    console.error("   - Windows: %APPDATA%\\Claude\\claude_desktop_config.json");
    console.error("2. Add the following to your configuration:");
    console.error(`{
      "mcpServers": {
        "platform-api": {
          "command": "node",
          "args": ["${process.argv[1]}", "--endpoints=${endpointIds.join(',')}", "--token=${bearerToken}"]
        }
      }
    }`);
    console.error("3. Restart Claude Desktop");
    console.error("4. The tools will be available through Claude");


  } catch (error) {
    console.error("Failed to start server:", error);
    // Log but don't exit to prevent restarts
    console.error("Server encountered an error but will attempt to continue");
  }
};

// Add a global error handler
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  // Don't exit the process
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process
});

process.on('exit', (code) => {
  console.error(`Process is about to exit with code: ${code}`);
});

process.on('SIGINT', () => {
  console.error('Received SIGINT signal (likely Ctrl+C)');
  process.exit(130);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM signal (likely process being terminated)');
  process.exit(143);
});

start();