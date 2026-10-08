import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProviderError, type MarketplaceBackend } from './backend.js';
import type { ProviderSessionAssessment } from './browser.js';
import {
  fetchInputSchema,
  fetchOutputSchema,
  SCHEMA_VERSION,
  searchInputSchema,
  searchOutputSchema,
  SERVICE_VERSION,
  statusInputSchema,
  statusOutputSchema,
  providerErrorSchema,
  type RuntimeFailure
} from './domain.js';

const TOOLS = [
  {
    name: 'marketplace_search',
    description: 'Search marketplace listings.',
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema
  },
  {
    name: 'marketplace_fetch',
    description: 'Fetch one marketplace listing by ID or canonical URL. Does not fetch remote URLs.',
    inputSchema: fetchInputSchema,
    outputSchema: fetchOutputSchema
  },
  {
    name: 'marketplace_status',
    description: 'Report service and schema versions, the configured backend name, and the Facebook session state.',
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

export interface MarketplaceToolOptions {
  backendName?: string;
  backendTimeoutMs?: number;
  shutdownSignal?: AbortSignal;
  sessionAssessment?: () => ProviderSessionAssessment;
}

export function registerMarketplaceTools(
  server: Server,
  backend: MarketplaceBackend,
  logger: Pick<Console, 'error'> = console,
  options: MarketplaceToolOptions = {}
): void {
  const backendName = options.backendName ?? backend.name;
  const backendTimeoutMs = options.backendTimeoutMs ?? 30_000;
  const shutdownSignal = options.shutdownSignal;
  server.registerCapabilities({ tools: {} });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ name, description, inputSchema, outputSchema }) => ({
      name,
      description,
      inputSchema: toMcpObjectSchema(inputSchema, 'input', name),
      outputSchema: toMcpObjectSchema(outputSchema, 'output')
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
        const listings = await runBackendOperation(
          (signal) => backend.search(parsed.data as z.infer<typeof searchInputSchema>, signal),
          backendTimeoutMs,
          extra.signal,
          shutdownSignal
        );
        output = { ok: true, backend: backendName, listings };
      } else if (name === 'marketplace_fetch') {
        const listing = await runBackendOperation(
          (signal) => backend.fetch(parsed.data as z.infer<typeof fetchInputSchema>, signal),
          backendTimeoutMs,
          extra.signal,
          shutdownSignal
        );
        output = listing === null
          ? runtimeFailure('NOT_FOUND', 'No listing matched the supplied identifier.')
          : { ok: true, backend: backendName, listing };
      } else {
        const sessionAssessment = options.sessionAssessment;
        output = {
          ok: true,
          service_version: SERVICE_VERSION,
          schema_version: SCHEMA_VERSION,
          backend: backendName,
          ...(sessionAssessment ? { facebook_session: { status: sessionAssessment() } } : {})
        };
      }
      validatedOutput = outputSchema.parse(output);
    } catch (error) {
      if (extra.signal.aborted || shutdownSignal?.aborted) throw error;
      const providerFailure = getProviderFailure(error);
      if (providerFailure && name !== 'marketplace_status') {
        validatedOutput = { ok: false, error: providerFailure };
      } else {
        const requestId = (request as { id?: unknown }).id;
        const idSuffix = requestId !== undefined ? ` [request id: ${String(requestId)}]` : '';
        logger.error(`Marketplace service failure (tool: ${name})${idSuffix}:`, error);
        validatedOutput = runtimeFailure('INTERNAL_ERROR', 'The backend could not complete the request.');
      }
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

function runtimeFailure(code: 'NOT_FOUND' | 'INTERNAL_ERROR', message: string): RuntimeFailure {
  return { ok: false, error: { code, message } };
}

function getProviderFailure(error: unknown): RuntimeFailure['error'] | undefined {
  if (!(error instanceof ProviderError)) return undefined;
  try {
    const parsed = providerErrorSchema.safeParse({ ...error.metadata, code: error.code, message: error.message });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function runBackendOperation<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  requestSignal: AbortSignal,
  shutdownSignal?: AbortSignal
): Promise<T> {
  if (requestSignal.aborted) throw requestSignal.reason ?? new Error('MCP request was cancelled');
  if (shutdownSignal?.aborted) throw shutdownSignal.reason ?? new Error('Service is shutting down');

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => controller.abort(signal.reason);
  const onRequestAbort = (): void => abortFrom(requestSignal);
  const onShutdownAbort = (): void => shutdownSignal && abortFrom(shutdownSignal);
  const onControllerAbort = (): void => {
    rejectAborted(controller.signal.reason ?? new Error('Backend operation aborted'));
  };
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  controller.signal.addEventListener('abort', onControllerAbort, { once: true });
  requestSignal.addEventListener('abort', onRequestAbort, { once: true });
  shutdownSignal?.addEventListener('abort', onShutdownAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveTimeout!: (error: ProviderError) => void;
  const timeout = new Promise<never>((_, reject) => {
    resolveTimeout = (error) => reject(error);
  });
  const work = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Backend operation aborted');
    return operation(controller.signal);
  });
  try {
    timer = setTimeout(() => {
      resolveTimeout(new ProviderError('TIMEOUT', 'The backend operation exceeded its deadline.'));
      controller.abort(new Error('Backend operation timed out'));
    }, timeoutMs);
    timer.unref?.();
    return await Promise.race([work, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener('abort', onControllerAbort);
    requestSignal.removeEventListener('abort', onRequestAbort);
    shutdownSignal?.removeEventListener('abort', onShutdownAbort);
  }
}

function formatValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid tool arguments';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}
