import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { MarketplaceBackend } from './backend.js';
import {
  fetchInputSchema,
  fetchOutputSchema,
  SCHEMA_VERSION,
  searchInputSchema,
  searchOutputSchema,
  SERVICE_VERSION,
  statusInputSchema,
  statusOutputSchema,
  type RuntimeFailure
} from './domain.js';

const TOOLS = [
  {
    name: 'marketplace_search',
    description: 'Search synthetic fixture Marketplace listings. Results always identify their fixture backend.',
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema
  },
  {
    name: 'marketplace_fetch',
    description: 'Fetch one synthetic fixture listing by ID or its canonical example.com URL. Does not fetch remote URLs.',
    inputSchema: fetchInputSchema,
    outputSchema: fetchOutputSchema
  },
  {
    name: 'marketplace_status',
    description: 'Report service and schema versions and the fixture backend.',
    inputSchema: statusInputSchema,
    outputSchema: statusOutputSchema
  }
] as const;

type ToolName = typeof TOOLS[number]['name'];
const inputSchemas: Record<ToolName, z.ZodType> = {
  marketplace_search: searchInputSchema,
  marketplace_fetch: fetchInputSchema,
  marketplace_status: statusInputSchema
};

export function registerMarketplaceTools(
  server: Server,
  backend: MarketplaceBackend,
  logger: Pick<Console, 'error'> = console
): void {
  server.registerCapabilities({ tools: {} });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ name, description, inputSchema, outputSchema }) => ({
      name,
      description,
      inputSchema: toMcpObjectSchema(inputSchema, 'input', name),
      outputSchema: toMcpObjectSchema(outputSchema, 'output')
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const schema = Object.hasOwn(inputSchemas, name) ? inputSchemas[name] : undefined;
    if (!schema) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);

    // Validate here instead of returning an MCP tool-error result for malformed arguments.
    const args = request.params.arguments ?? {};
    const parsed = schema.safeParse(args);
    if (parsed.success && (name === 'marketplace_search' || name === 'marketplace_fetch') && request.params.arguments === undefined) {
      throw new McpError(ErrorCode.InvalidParams, 'Tool arguments are required');
    }
    if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, formatValidationError(parsed.error));

    const outputSchema = name === 'marketplace_search'
      ? searchOutputSchema
      : name === 'marketplace_fetch'
        ? fetchOutputSchema
        : statusOutputSchema;
    let validatedOutput: z.infer<typeof searchOutputSchema | typeof fetchOutputSchema | typeof statusOutputSchema>;
    try {
      let output: unknown;
      if (name === 'marketplace_search') {
        output = { ok: true, backend: 'fixture', listings: await backend.search(parsed.data as z.infer<typeof searchInputSchema>) };
      } else if (name === 'marketplace_fetch') {
        const listing = await backend.fetch(parsed.data as z.infer<typeof fetchInputSchema>);
        output = listing === null
          ? runtimeFailure('NOT_FOUND', 'No fixture listing matched the supplied identifier.')
          : { ok: true, backend: 'fixture', listing };
      } else {
        output = { ok: true, service_version: SERVICE_VERSION, schema_version: SCHEMA_VERSION, backend: 'fixture' };
      }
      validatedOutput = outputSchema.parse(output);
    } catch (error) {
      const requestId = (request as { id?: unknown }).id;
      const idSuffix = requestId !== undefined ? ` [request id: ${String(requestId)}]` : '';
      logger.error(`Marketplace fixture backend failed (tool: ${name})${idSuffix}:`, error);
      validatedOutput = runtimeFailure('INTERNAL_ERROR', 'The fixture backend could not complete the request.');
    }
    const serialized = JSON.stringify(validatedOutput);
    return {
      content: [{ type: 'text', text: serialized }],
      structuredContent: validatedOutput,
      isError: 'ok' in validatedOutput && validatedOutput.ok === false
    };
  });
}

function toMcpObjectSchema(schema: z.ZodType, io: 'input' | 'output', toolName?: ToolName): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', io, unrepresentable: 'any' });
  if (jsonSchema.type === 'object') {
    if (toolName === 'marketplace_search') {
      jsonSchema.description = 'min_price must be less than or equal to max_price.';
    }
    if (io === 'input' && toolName === 'marketplace_fetch') {
      jsonSchema.oneOf = [
        { required: ['id'], not: { required: ['url'] } },
        { required: ['url'], not: { required: ['id'] } }
      ];
    }
    return jsonSchema as Record<string, unknown>;
  }

  const branches = Array.isArray(jsonSchema.anyOf) ? jsonSchema.anyOf : [];
  return { type: 'object', anyOf: branches };
}

function runtimeFailure(code: string, message: string): RuntimeFailure {
  return { ok: false, error: { code, message } };
}

function formatValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid tool arguments';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}
