import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProviderError, type ConversationBackend, type MarketplaceBackend, type ShoppingBackend } from './backend.js';
import type { ProviderSessionAssessment } from './browser.js';
import {
  authorizeAction,
  DenyAllAuthorizer,
  subjectDigest,
  type ActionAuthorizer,
  type ActionDefinition,
  type ActionRequest
} from './authorization.js';
import {
  fetchInputSchema,
  fetchOutputSchema,
  threadsListInputSchema,
  threadsListOutputSchema,
  threadReadInputSchema,
  threadReadOutputSchema,
  threadSendInputSchema,
  sendOutputSchema,
  SCHEMA_VERSION,
  searchInputSchema,
  searchOutputSchema,
  SERVICE_VERSION,
  statusInputSchema,
  statusOutputSchema,
  providerErrorSchema,
  runtimeFailureSchema,
  type RuntimeFailure,
  type ThreadSendInput,
  type ConversationThreadMessages,
  shoppingSearchInputSchema,
  shoppingFetchInputSchema,
  shoppingSearchOutputSchema,
  shoppingFetchOutputSchema
} from './domain.js';

const marketplaceScope = { provider: 'facebook', account: 'default', surface: 'marketplace' } as const;
const messengerScope = { provider: 'facebook', account: 'default', surface: 'messenger' } as const;
const shoppingScope = { provider: 'ebay', account: 'default', surface: 'shopping' } as const;

const TOOLS = [
  {
    name: 'marketplace_search',
    description: 'Search marketplace listings.',
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    definition: { riskClass: 'read', scope: marketplaceScope }
  },
  {
    name: 'marketplace_fetch',
    description: 'Fetch one marketplace listing by ID or canonical URL. Does not fetch remote URLs.',
    inputSchema: fetchInputSchema,
    outputSchema: fetchOutputSchema,
    definition: { riskClass: 'read', scope: marketplaceScope }
  },
  {
    name: 'marketplace_status',
    description: 'Report service and schema versions, the configured backend name, and the Facebook session state.',
    inputSchema: statusInputSchema,
    outputSchema: statusOutputSchema,
    definition: { riskClass: 'read', scope: marketplaceScope }
  },
  {
    name: 'shopping_search',
    description: 'Search one configured shopping source for products with prices, availability, and provenance. Read-only.',
    inputSchema: shoppingSearchInputSchema,
    outputSchema: shoppingSearchOutputSchema,
    definition: { riskClass: 'read', scope: shoppingScope }
  },
  {
    name: 'shopping_fetch',
    description: 'Fetch one product offer by canonical ID or URL from the configured shopping source. Read-only.',
    inputSchema: shoppingFetchInputSchema,
    outputSchema: shoppingFetchOutputSchema,
    definition: { riskClass: 'read', scope: shoppingScope }
  },
  {
    name: 'messenger_threads_list',
    description: 'List recent seller conversation threads from the Facebook Marketplace inbox. Read-only.',
    inputSchema: threadsListInputSchema,
    outputSchema: threadsListOutputSchema,
    definition: { riskClass: 'read', scope: messengerScope }
  },
  {
    name: 'messenger_thread_read',
    description: 'Read the messages of one marketplace conversation thread by ID. Read-only, but opening the thread marks it "Seen" for the other participant.',
    inputSchema: threadReadInputSchema,
    outputSchema: threadReadOutputSchema,
    definition: { riskClass: 'read', scope: messengerScope }
  },
  {
    name: 'messenger_send',
    description: 'Send one approval-grant-bound message into a conversation thread. Requires a single-use signed approval grant. Delivery is confirmed by reading the thread for the idempotency token; unconfirmed sends are reported as unknown and are never resent.',
    inputSchema: threadSendInputSchema,
    outputSchema: sendOutputSchema,
    definition: { riskClass: 'send', scope: messengerScope }
  }
] as const;

export const TOOL_DEFINITIONS: Readonly<Record<ToolName, ActionDefinition>> = Object.fromEntries(
  TOOLS.map(({ name, definition }) => [name, definition])
) as Record<ToolName, ActionDefinition>;

type ToolName = typeof TOOLS[number]['name'];

export interface MarketplaceToolOptions {
  backendName?: string;
  backendTimeoutMs?: number;
  shutdownSignal?: AbortSignal;
  sessionAssessment?: () => ProviderSessionAssessment;
  /** Per-call host seam for approval grants; receives the validated action request (including the payload digest) so a host can correlate it with its own approval records. Grants must come from the host, never from tool arguments. This service does not issue grants. */
  approvalGrant?: (request: ActionRequest) => unknown;
  authorizer?: ActionAuthorizer;
  conversations?: ConversationBackend;
  shopping?: ShoppingBackend;
}

export function assertWritableToolsHaveAuthorizer(
  tools: ReadonlyArray<{ readonly name: string; readonly definition: ActionDefinition }>,
  authorizer: ActionAuthorizer | undefined
): void {
  for (const { name, definition } of tools) {
    if ((definition.riskClass === 'send' || definition.riskClass === 'high_consequence') && !authorizer) {
      throw new Error(`Tool ${name} requires an authorizer for write actions`);
    }
  }
}

export function registerMarketplaceTools(
  server: Server,
  backend: MarketplaceBackend,
  logger: Pick<Console, 'error'> = console,
  options: MarketplaceToolOptions = {}
): void {
  // messenger_send is only live where the conversation surface exists; elsewhere it is an
  // unknown tool and a call fails InvalidParams like any unregistered tool.
  const activeTools = options.conversations ? TOOLS : TOOLS.filter((tool) => tool.name !== 'messenger_send');
  assertWritableToolsHaveAuthorizer(activeTools, options.authorizer);

  const backendName = options.backendName ?? backend.name;
  const backendTimeoutMs = options.backendTimeoutMs ?? 30_000;
  const shutdownSignal = options.shutdownSignal;
  const authorizer = options.authorizer ?? new DenyAllAuthorizer();
  const inputSchemas = Object.fromEntries(activeTools.map(({ name, inputSchema }) => [name, inputSchema])) as unknown as Record<ToolName, z.ZodType>;
  server.registerCapabilities({ tools: {} });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: activeTools.map(({ name, description, inputSchema, outputSchema }) => ({
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

    const definition = TOOL_DEFINITIONS[name];
    const actionRequest: ActionRequest = {
      ...definition.scope,
      action: name,
      subjectDigest: subjectDigest(parsed.data)
    };
    let grant: unknown;
    if (definition.riskClass === 'send') {
      try {
        grant = options.approvalGrant?.(actionRequest);
      } catch {
        // A host that cannot produce a grant must never authorize a send; fail closed below.
        grant = undefined;
      }
    }
    const decision = authorizeAction(definition, actionRequest, authorizer, grant);

    const outputSchema = name === 'marketplace_search'
      ? searchOutputSchema
      : name === 'marketplace_fetch'
        ? fetchOutputSchema
        : name === 'messenger_threads_list'
          ? threadsListOutputSchema
          : name === 'messenger_thread_read'
            ? threadReadOutputSchema
            : name === 'messenger_send'
              ? sendOutputSchema
              : name === 'shopping_search'
                ? shoppingSearchOutputSchema
                : name === 'shopping_fetch'
                  ? shoppingFetchOutputSchema
                  : statusOutputSchema;
    let validatedOutput: z.infer<typeof searchOutputSchema | typeof fetchOutputSchema | typeof statusOutputSchema | typeof threadsListOutputSchema | typeof threadReadOutputSchema | typeof sendOutputSchema | typeof shoppingSearchOutputSchema | typeof shoppingFetchOutputSchema>;
    if (!decision.ok) {
      // Refusals parse against the shared runtime failure schema so the uniform refusal shape
      // does not depend on each tool's success-oriented output schema.
      validatedOutput = runtimeFailureSchema.parse({ ok: false, error: { code: decision.code, message: decision.message } });
    } else {
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
        } else if (name === 'messenger_threads_list') {
          const conversations = options.conversations;
          if (!conversations) throw new ProviderError('UPSTREAM_ERROR', 'The messenger surface is not configured on this deployment.');
          const threads = await runBackendOperation(
            (signal) => conversations.listThreads(parsed.data as z.infer<typeof threadsListInputSchema>, signal),
            backendTimeoutMs,
            extra.signal,
            shutdownSignal
          );
          output = { ok: true, backend: backendName, threads };
        } else if (name === 'messenger_thread_read') {
          const conversations = options.conversations;
          if (!conversations) throw new ProviderError('UPSTREAM_ERROR', 'The messenger surface is not configured on this deployment.');
          const thread = await runBackendOperation(
            (signal) => conversations.readThread(parsed.data as z.infer<typeof threadReadInputSchema>, signal),
            backendTimeoutMs,
            extra.signal,
            shutdownSignal
          );
          output = thread === null
            ? runtimeFailure('NOT_FOUND', 'No conversation thread matched the supplied identifier.')
            : { ok: true, backend: backendName, thread_id: thread.thread_id, messages: thread.messages };
        } else if (name === 'messenger_send') {
          const conversations = options.conversations;
          if (!conversations) throw new ProviderError('UPSTREAM_ERROR', 'The messenger surface is not configured on this deployment.');
          const sendInput = parsed.data as ThreadSendInput;
          // A DOM interaction succeeding is not delivery confirmation, so a resolved send is
          // never reported 'sent' directly; a failure whose submit was already dispatched is
          // likewise never reported as unsent. Both are reconciled with one thread read.
          try {
            await runBackendOperation((signal) => conversations.sendThread(sendInput, signal), backendTimeoutMs, extra.signal, shutdownSignal);
          } catch (error) {
            const reconcilable = error instanceof ProviderError
              && (error.code === 'TIMEOUT' || error.metadata.submit_triggered === true);
            if (!reconcilable) throw error;
          }
          // The single observation reads the thread for the idempotency token bound to this
          // grant; a missing token or a failed read yields 'unknown', and the message is never
          // resent (provider-action-boundaries: any retry is a new approval decision).
          const delivered = await reconcileSentThread(conversations, sendInput, backendTimeoutMs, extra.signal, shutdownSignal);
          output = { ok: true, backend: backendName, thread_id: sendInput.thread_id, status: delivered ? 'sent' : 'unknown' };
        } else if (name === 'shopping_search') {
          const shopping = options.shopping;
          if (!shopping) throw new ProviderError('UPSTREAM_ERROR', 'The shopping surface is not configured on this deployment.');
          const offers = await runBackendOperation(
            (signal) => shopping.search(parsed.data as z.infer<typeof shoppingSearchInputSchema>, signal),
            backendTimeoutMs,
            extra.signal,
            shutdownSignal
          );
          output = { ok: true, backend: shopping.name, offers };
        } else if (name === 'shopping_fetch') {
          const shopping = options.shopping;
          if (!shopping) throw new ProviderError('UPSTREAM_ERROR', 'The shopping surface is not configured on this deployment.');
          const offer = await runBackendOperation(
            (signal) => shopping.fetch(parsed.data as z.infer<typeof shoppingFetchInputSchema>, signal),
            backendTimeoutMs,
            extra.signal,
            shutdownSignal
          );
          output = offer === null
            ? runtimeFailure('NOT_FOUND', 'No product offer matched the supplied identifier.')
            : { ok: true, backend: shopping.name, offer };
        } else {
          const sessionAssessment = options.sessionAssessment;
          output = {
            ok: true,
            service_version: SERVICE_VERSION,
            schema_version: SCHEMA_VERSION,
            backend: backendName,
            shopping_backend: options.shopping?.name,
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

async function reconcileSentThread(
  conversations: ConversationBackend,
  sendInput: ThreadSendInput,
  timeoutMs: number,
  requestSignal: AbortSignal,
  shutdownSignal?: AbortSignal
): Promise<boolean> {
  let thread: ConversationThreadMessages | null;
  try {
    thread = await runBackendOperation(
      (signal) => conversations.readThread({ thread_id: sendInput.thread_id }, signal),
      timeoutMs,
      requestSignal,
      shutdownSignal
    );
  } catch (error) {
    if (requestSignal.aborted || shutdownSignal?.aborted) throw error;
    return false;
  }
  if (thread === null) return false;
  return thread.messages.some(({ text }) => text.includes(`[${sendInput.idempotency_token}]`));
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
