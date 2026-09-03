/**
 * Provider-neutral External Agent platform seam.
 *
 * Standalone ESM with no runtime dependencies. Shared by independently
 * installed provider plugins and DSH-side consumers (primary session and
 * subagent): provider registration, exact model route resolution, native
 * session lifetime, turn-scoped hosts, permission and user-input round trips,
 * canonical activity events, and a bounded event log.
 *
 * Out of scope: ACP transports, subprocesses, authentication, filesystem
 * mediation, UI rendering, DSH Session projection, and concrete providers.
 * Those live in provider plugins and the DSH host integration.
 */

// ---------------------------------------------------------------------------
// Opaque ids
// ---------------------------------------------------------------------------

declare const brand: unique symbol;

/**
 * Opaque string id: comparable and loggable, never interchangeable across kinds.
 */
export type BrandedId<Kind extends string> = string & { readonly [brand]: Kind };

/** Provider instance name, unique within one registry. */
export type ProviderName = BrandedId<"ProviderName">;

/**
 * Provider-scoped native session id and resume cursor owner. Never shared
 * across providers: each provider keeps its own private history.
 */
export type NativeSessionId = BrandedId<"NativeSessionId">;

/** Wrap a validated provider name. */
export function providerName(value: string): ProviderName {
  return value as ProviderName;
}

/** Wrap a provider-issued native session id. */
export function nativeSessionId(value: string): NativeSessionId {
  return value as NativeSessionId;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A second provider registered under an occupied name. */
export class DuplicateProviderError extends Error {
  constructor(readonly provider: string) {
    super("duplicate external-agent provider: " + provider);
    this.name = "DuplicateProviderError";
  }
}

/** A route specifier was malformed or named no exact provider/model. Never falls back. */
export class RouteResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteResolutionError";
  }
}

/** A turn was attempted on a disposed session. */
export class SessionDisposedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionDisposedError";
  }
}

/** The turn AbortSignal fired before or during the turn. Fails closed: no approval. */
export class TurnAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnAbortedError";
  }
}

/** A provider used its turn host after the turn settled. Hosts are turn-scoped. */
export class HostExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostExpiredError";
  }
}

/** The requested permission mode is not advertised for this model. */
export class UnsupportedModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedModeError";
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Runtime selected for the next turn. Raw LLM calls and complete
 * external-agent turns stay distinct; no invisible fallback between them.
 */
export type RouteKind = "llm" | "external-agent";

/** Raw LLM route: the current DSH agent loop owns the turn. */
export interface LlmRoute {
  readonly kind: "llm";
  readonly model: string;
}

/** External-agent route: the named provider owns planning, tools, and history. */
export interface ExternalAgentRoute {
  readonly kind: "external-agent";
  readonly provider: string;
  readonly model: string;
}

/** Either runtime a model selector entry may resolve to. */
export type ModelRoute = LlmRoute | ExternalAgentRoute;

const LLM_PREFIX = "llm:";
const AGENT_PREFIX = "external-agent:";

/**
 * Parse an explicit selector entry. Accepted forms are llm:model and
 * external-agent:provider/model. Anything else throws RouteResolutionError.
 * @param specifier selector entry text
 * @returns the parsed route, unchecked against the registry
 */
export function parseRouteSpecifier(specifier: string): ModelRoute {
  if (specifier.startsWith(LLM_PREFIX)) {
    const model = specifier.slice(LLM_PREFIX.length);
    if (model.length === 0) {
      throw new RouteResolutionError("empty model in route specifier: " + specifier);
    }
    return { kind: "llm", model };
  }
  if (specifier.startsWith(AGENT_PREFIX)) {
    const rest = specifier.slice(AGENT_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      throw new RouteResolutionError(
        "external-agent route must be external-agent:provider/model, got: " + specifier,
      );
    }
    return {
      kind: "external-agent",
      provider: rest.slice(0, slash),
      model: rest.slice(slash + 1),
    };
  }
  throw new RouteResolutionError("unknown route specifier: " + specifier);
}

// ---------------------------------------------------------------------------
// Permission modes, options, outcomes
// ---------------------------------------------------------------------------

/**
 * Generic permission mode. Providers advertise the subset they support and map
 * each to a native value. Full access selects the highest native permission
 * mode; it never answers user questions or bypasses host filesystem policy.
 */
export type PermissionMode = "approval-required" | "auto-accept-edits" | "full-access";

/** Every generic mode, for providers that support the full set. */
export const ALL_PERMISSION_MODES: readonly PermissionMode[] = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

/** Option kinds a provider may offer for one approval request. */
export type PermissionOptionKind = "allow-once" | "allow-always" | "reject";

/**
 * One approval choice offered by the provider. allow-always appears only when
 * the native provider offers it, is labelled with session or thread scope,
 * and is enforced by the native session, never replayed from DSH logs.
 */
export interface PermissionOption {
  readonly id: string;
  readonly kind: PermissionOptionKind;
  readonly label: string;
  /** Grant scope for allow-always; absent for other kinds. */
  readonly scope?: "session" | "thread";
  /** Provider security warning to show alongside the choice, if any. */
  readonly warning?: string;
}

/**
 * Outcome of one approval request. allowed-for-session answers an offered
 * allow-always; unavailable and cancelled fail closed and grant nothing.
 */
export type PermissionOutcome =
  | "allowed-once"
  | "allowed-for-session"
  | "rejected"
  | "cancelled"
  | "unavailable";

/** Sensitive action awaiting a DSH approval decision. */
export interface PermissionRequest {
  readonly tool: string;
  readonly summary: string;
  readonly detail?: string;
  readonly options: readonly PermissionOption[];
}

/**
 * Map a chosen option to its outcome.
 * @param option the option the approver picked
 * @returns allowed-once for allow-once, allowed-for-session for allow-always, rejected for reject
 */
export function outcomeForOption(option: PermissionOption): PermissionOutcome {
  switch (option.kind) {
    case "allow-once":
      return "allowed-once";
    case "allow-always":
      return "allowed-for-session";
    case "reject":
      return "rejected";
  }
}

/**
 * Whether the provider offered a native allow-always choice for this request.
 * @param options the options carried by the request
 * @returns true when at least one option has kind allow-always
 */
export function offersAllowAlways(options: readonly PermissionOption[]): boolean {
  return options.some((option) => option.kind === "allow-always");
}

// ---------------------------------------------------------------------------
// User input
// ---------------------------------------------------------------------------

/** One question the native agent pauses for. */
export interface UserInputQuestion {
  readonly id: string;
  readonly question: string;
  readonly options?: readonly string[];
}

/** Native agent paused for answers through the DSH question UI. */
export interface UserInputRequest {
  readonly questions: readonly UserInputQuestion[];
}

/** Answer to a user-input request. Only answered carries choices. */
export type UserInputAnswer =
  | { readonly status: "answered"; readonly answers: Readonly<Record<string, string>> }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable" };

// ---------------------------------------------------------------------------
// Canonical activity events
// ---------------------------------------------------------------------------

/** Terminal status of one native turn. */
export type TurnStatus = "completed" | "cancelled" | "failed";

/**
 * Provider-neutral activity vocabulary. One implementation serves the primary
 * and subagent consumers. Native tool activity is already-executing work and
 * is never translated into a DSH tool call.
 */
export type ActivityEvent =
  | { readonly type: "assistant-delta"; readonly delta: string }
  | { readonly type: "thought-delta"; readonly delta: string }
  | { readonly type: "tool-start"; readonly tool: string; readonly detail?: string }
  | { readonly type: "tool-end"; readonly tool: string; readonly exit: "ok" | "error"; readonly detail?: string }
  | { readonly type: "plan-update"; readonly plan: readonly string[] }
  | { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: "notice"; readonly level: "info" | "warning" | "error"; readonly message: string }
  | { readonly type: "session-state"; readonly cursor: string | null }
  | { readonly type: "turn-result"; readonly status: TurnStatus; readonly message?: string };

/** Result of one native turn, returned to the owning consumer. */
export interface TurnResult {
  readonly status: TurnStatus;
  /** Native resume cursor; null when the provider offers none. */
  readonly cursor: string | null;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Turn-scoped host
// ---------------------------------------------------------------------------

/** Turn-scoped host handed to the provider for exactly one turn. */
export interface TurnHost {
  /** Fires when the owning consumer cancels the turn. */
  readonly signal: AbortSignal;
  /**
   * Publish one activity event. Throws HostExpiredError after the turn
   * settles and TurnAbortedError once the turn is cancelled.
   */
  publish(event: ActivityEvent): void;
  /** Ask DSH for an approval decision. Rejects closed on abort or settle. */
  requestPermission(request: PermissionRequest): Promise<PermissionOutcome>;
  /** Ask DSH for user answers. Rejects closed on abort or settle. */
  requestUserInput(request: UserInputRequest): Promise<UserInputAnswer>;
}

/** Consumer-side callbacks behind a TurnHost. */
export interface TurnHostCallbacks {
  onEvent(event: ActivityEvent): void;
  onPermission(request: PermissionRequest): Promise<PermissionOutcome>;
  onUserInput(request: UserInputRequest): Promise<UserInputAnswer>;
}

/** A TurnHost with an explicit end of life, owned by the session runner. */
export interface TurnHostController extends TurnHost {
  readonly expired: boolean;
  /** Reject every pending interaction and refuse further use. Idempotent. */
  expire(): void;
}

/**
 * Build the host for one turn. The session runner expires it when the turn
 * settles; providers must not retain it.
 * @param signal the turn AbortSignal, owned by the consumer
 * @param callbacks consumer handlers for events, approvals, and questions
 * @returns the controller wrapping the live host
 */
export function createTurnHost(signal: AbortSignal, callbacks: TurnHostCallbacks): TurnHostController {
  let done = false;
  const pending = new Set<(error: unknown) => void>();

  function checkUsable(): void {
    if (done) {
      throw new HostExpiredError("turn host used after the turn settled; providers must not retain it");
    }
    if (signal.aborted) {
      throw new TurnAbortedError("turn aborted");
    }
  }

  function raceAbort<T>(promise: Promise<T>): Promise<T> {
    let rejectPending: (error: unknown) => void = () => undefined;
    const guard = new Promise<T>((_resolve, reject) => {
      rejectPending = reject;
    });
    pending.add(rejectPending);
    const cleanup = (): void => {
      pending.delete(rejectPending);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      rejectPending(new TurnAbortedError("turn aborted while waiting for the host"));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    return Promise.race([promise, guard]).then(
      (value) => {
        cleanup();
        return value;
      },
      (error) => {
        cleanup();
        throw error;
      },
    );
  }

  return {
    signal,
    get expired(): boolean {
      return done;
    },
    expire(): void {
      if (done) {
        return;
      }
      done = true;
      const error = new HostExpiredError("turn settled; pending host interaction rejected");
      for (const rejectPending of Array.from(pending)) {
        rejectPending(error);
      }
      pending.clear();
    },
    publish(event: ActivityEvent): void {
      checkUsable();
      callbacks.onEvent(event);
    },
    requestPermission(request: PermissionRequest): Promise<PermissionOutcome> {
      checkUsable();
      return raceAbort(callbacks.onPermission(request));
    },
    requestUserInput(request: UserInputRequest): Promise<UserInputAnswer> {
      checkUsable();
      return raceAbort(callbacks.onUserInput(request));
    },
  };
}

// ---------------------------------------------------------------------------
// Provider and session
// ---------------------------------------------------------------------------

/** One model entry advertised by a provider. */
export interface ModelInfo {
  readonly id: string;
  readonly label?: string;
  readonly supportedModes: readonly PermissionMode[];
}

/** Arguments for opening a native session. */
export interface OpenSessionArgs {
  /** Exact model id; unknown ids throw, never fall back. */
  readonly model: string;
  /** Resume cursor from a previous turn of the same provider, if any. */
  readonly resumeCursor?: string | null;
}

/** Consumer-side arguments for running one complete native turn. */
export interface RunTurnArgs {
  readonly prompt: string;
  readonly mode: PermissionMode;
  readonly signal: AbortSignal;
  readonly onEvent: (event: ActivityEvent) => void;
  readonly onPermission: (request: PermissionRequest) => Promise<PermissionOutcome>;
  readonly onUserInput: (request: UserInputRequest) => Promise<UserInputAnswer>;
}

/** Native session owned by one provider. */
export interface ExternalAgentSession {
  readonly id: NativeSessionId;
  readonly provider: string;
  readonly model: string;
  readonly supportedModes: readonly PermissionMode[];
  readonly isDisposed: boolean;
  /**
   * Run one complete native turn. A pre-aborted signal reports cancelled
   * without executing. Throws SessionDisposedError after dispose and
   * UnsupportedModeError for unadvertised modes. Zero automatic retries:
   * transport failures propagate to the consumer.
   */
  runTurn(args: RunTurnArgs): Promise<TurnResult>;
  /** Mark disposed and release native resources. Idempotent. */
  dispose(): Promise<void>;
}

/** Provider plugin surface: model listing plus native session opening. */
export interface ExternalAgentProvider {
  readonly name: string;
  listModels(): Promise<readonly ModelInfo[]> | readonly ModelInfo[];
  openSession(args: OpenSessionArgs): Promise<ExternalAgentSession> | ExternalAgentSession;
}

/**
 * Shared session runner. Enforces abort-before-run, advertised modes,
 * disposal, and turn-scoped host expiry so providers implement only
 * runTurnImpl and optional disposeImpl.
 */
export abstract class ManagedExternalAgentSession implements ExternalAgentSession {
  abstract readonly id: NativeSessionId;
  abstract readonly provider: string;
  abstract readonly model: string;
  abstract readonly supportedModes: readonly PermissionMode[];
  private disposedFlag = false;

  get isDisposed(): boolean {
    return this.disposedFlag;
  }

  async runTurn(args: RunTurnArgs): Promise<TurnResult> {
    if (this.disposedFlag) {
      throw new SessionDisposedError("session " + this.id + " is disposed");
    }
    if (!this.supportedModes.includes(args.mode)) {
      throw new UnsupportedModeError("mode " + args.mode + " is not supported by " + this.model);
    }
    if (args.signal.aborted) {
      return { status: "cancelled", cursor: null };
    }
    const host = createTurnHost(args.signal, {
      onEvent: args.onEvent,
      onPermission: args.onPermission,
      onUserInput: args.onUserInput,
    });
    try {
      return await this.runTurnImpl(args.prompt, args.mode, host);
    } finally {
      host.expire();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposedFlag) {
      return;
    }
    this.disposedFlag = true;
    await this.disposeImpl();
  }

  protected abstract runTurnImpl(prompt: string, mode: PermissionMode, host: TurnHost): Promise<TurnResult>;

  protected disposeImpl(): Promise<void> | void {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Provider registry. Owns registration with duplicate-name rejection,
 * exact route resolution, and unregister disposers for HMR and shutdown.
 */
export class ExternalAgentProviderRegistry {
  private readonly providers = new Map<string, ExternalAgentProvider>();

  /**
   * Register one provider instance. Throws DuplicateProviderError on a name
   * clash. Returns an idempotent disposer removing this registration.
   * @param provider the provider instance to register
   * @returns disposer removing exactly this registration
   */
  register(provider: ExternalAgentProvider): () => void {
    if (this.providers.has(provider.name)) {
      throw new DuplicateProviderError(provider.name);
    }
    this.providers.set(provider.name, provider);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      if (this.providers.get(provider.name) === provider) {
        this.providers.delete(provider.name);
      }
    };
  }

  /** Whether a provider is registered under this name. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Registered provider names. */
  names(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Look up a registered provider.
   * @param name exact provider name
   * @returns the registered provider
   */
  get(name: string): ExternalAgentProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new RouteResolutionError("unknown external-agent provider: " + name);
    }
    return provider;
  }

  /**
   * Resolve an external-agent route exactly: the provider must be registered
   * and the model must be advertised. No silent fallback.
   * @param provider exact provider name
   * @param model exact model id
   * @returns the resolved route
   */
  async resolveExternalRoute(provider: string, model: string): Promise<ExternalAgentRoute> {
    const found = this.get(provider);
    const models = await found.listModels();
    const match = models.find((candidate) => candidate.id === model);
    if (!match) {
      throw new RouteResolutionError(
        "unknown model " + model + " for provider " + provider + "; no fallback applied",
      );
    }
    return { kind: "external-agent", provider, model };
  }
}

// ---------------------------------------------------------------------------
// Bounded event log
// ---------------------------------------------------------------------------

/** Limits for a BoundedEventLog. */
export interface BoundedEventLogOptions {
  /** Oldest events drop past this count. Defaults to 500. */
  readonly maxEvents?: number;
  /** Per-string cap in Unicode code points. Defaults to 4000. */
  readonly maxCharsPerString?: number;
}

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_CHARS = 4000;

function truncateText(value: string, maxChars: number): string {
  const limit = Math.max(0, maxChars);
  const points = Array.from(value);
  if (points.length <= limit) {
    return value;
  }
  return points.slice(0, limit).join("");
}

function truncateEvent(event: ActivityEvent, maxChars: number): ActivityEvent {
  switch (event.type) {
    case "assistant-delta":
      return { type: "assistant-delta", delta: truncateText(event.delta, maxChars) };
    case "thought-delta":
      return { type: "thought-delta", delta: truncateText(event.delta, maxChars) };
    case "tool-start":
      return {
        type: "tool-start",
        tool: event.tool,
        detail: event.detail === undefined ? undefined : truncateText(event.detail, maxChars),
      };
    case "tool-end":
      return {
        type: "tool-end",
        tool: event.tool,
        exit: event.exit,
        detail: event.detail === undefined ? undefined : truncateText(event.detail, maxChars),
      };
    case "plan-update":
      return { type: "plan-update", plan: event.plan.map((step) => truncateText(step, maxChars)) };
    case "usage":
      return event;
    case "notice":
      return { type: "notice", level: event.level, message: truncateText(event.message, maxChars) };
    case "session-state":
      return event;
    case "turn-result":
      return {
        type: "turn-result",
        status: event.status,
        message: event.message === undefined ? undefined : truncateText(event.message, maxChars),
      };
  }
}

/**
 * Bounded sink for activity events. Truncates oversized strings at code-point
 * boundaries and drops the oldest events past the cap, counting them.
 */
export class BoundedEventLog {
  private readonly buffer: ActivityEvent[] = [];
  private droppedCount = 0;
  private readonly maxEvents: number;
  private readonly maxChars: number;

  constructor(options: BoundedEventLogOptions = {}) {
    this.maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
    this.maxChars = Math.max(0, options.maxCharsPerString ?? DEFAULT_MAX_CHARS);
  }

  /** Push one event, applying string caps and the event cap. */
  push(event: ActivityEvent): void {
    if (this.buffer.length >= this.maxEvents) {
      this.buffer.shift();
      this.droppedCount += 1;
    }
    this.buffer.push(truncateEvent(event, this.maxChars));
  }

  /** Stored events, oldest first. */
  events(): readonly ActivityEvent[] {
    return this.buffer.slice();
  }

  /** Stored event count. */
  get size(): number {
    return this.buffer.length;
  }

  /** Events dropped to the cap so far. */
  get dropped(): number {
    return this.droppedCount;
  }
}

// ---------------------------------------------------------------------------
// Scripted fake provider
// ---------------------------------------------------------------------------

/** What a scripted fake turn receives. */
export interface FakeTurnContext {
  readonly prompt: string;
  readonly mode: PermissionMode;
  readonly host: TurnHost;
  readonly signal: AbortSignal;
}

/** Scripted behavior for one fake turn. */
export type FakeTurnBehavior = (ctx: FakeTurnContext) => Promise<TurnResult>;

/** Fake native session: managed lifetime over a queue of scripted behaviors. */
export class FakeExternalAgentSession extends ManagedExternalAgentSession {
  readonly id: NativeSessionId;
  readonly provider: string;
  readonly model: string;
  readonly supportedModes: readonly PermissionMode[];
  private currentCursor: string | null;
  private readonly takeBehavior: () => FakeTurnBehavior | undefined;

  constructor(args: {
    readonly id: NativeSessionId;
    readonly provider: string;
    readonly model: string;
    readonly resumeCursor?: string | null;
    readonly supportedModes?: readonly PermissionMode[];
    readonly takeBehavior: () => FakeTurnBehavior | undefined;
  }) {
    super();
    this.id = args.id;
    this.provider = args.provider;
    this.model = args.model;
    this.currentCursor = args.resumeCursor ?? null;
    this.supportedModes = args.supportedModes ?? ALL_PERMISSION_MODES;
    this.takeBehavior = args.takeBehavior;
  }

  /** Latest cursor returned by a turn of this session. */
  get cursor(): string | null {
    return this.currentCursor;
  }

  protected async runTurnImpl(prompt: string, mode: PermissionMode, host: TurnHost): Promise<TurnResult> {
    const behavior = this.takeBehavior();
    if (behavior === undefined) {
      if (host.signal.aborted) {
        return { status: "cancelled", cursor: this.currentCursor };
      }
      host.publish({ type: "assistant-delta", delta: "echo: " + prompt });
      return { status: "completed", cursor: this.currentCursor };
    }
    const result = await behavior({ prompt, mode, host, signal: host.signal });
    this.currentCursor = result.cursor;
    return result;
  }
}

/**
 * Scripted fake provider. Exercises discovery, exact open, resume cursors,
 * activity, permissions, questions, cancellation, errors, and disposal
 * through the real public interface.
 */
export class FakeExternalAgentProvider implements ExternalAgentProvider {
  readonly name: string;
  private readonly models: ModelInfo[];
  private readonly behaviors: FakeTurnBehavior[] = [];
  private sessionCounter = 0;
  /** Sessions opened so far, for lifecycle assertions. */
  readonly sessions: FakeExternalAgentSession[] = [];

  constructor(name: string, models: ModelInfo[]) {
    this.name = name;
    this.models = models.slice();
  }

  listModels(): ModelInfo[] {
    return this.models.slice();
  }

  openSession(args: OpenSessionArgs): FakeExternalAgentSession {
    const spec = this.models.find((candidate) => candidate.id === args.model);
    if (!spec) {
      throw new RouteResolutionError(
        "unknown model " + args.model + " for provider " + this.name + "; no fallback applied",
      );
    }
    this.sessionCounter += 1;
    const session = new FakeExternalAgentSession({
      id: nativeSessionId(this.name + ":session-" + String(this.sessionCounter)),
      provider: this.name,
      model: args.model,
      resumeCursor: args.resumeCursor,
      supportedModes: spec.supportedModes,
      takeBehavior: () => this.behaviors.shift(),
    });
    this.sessions.push(session);
    return session;
  }

  /** Queue one scripted turn behavior, consumed FIFO. */
  enqueueTurn(behavior: FakeTurnBehavior): void {
    this.behaviors.push(behavior);
  }

  /** Queued but unconsumed behaviors. */
  get pendingTurns(): number {
    return this.behaviors.length;
  }

  /** Queue a turn publishing one assistant delta and completing. */
  enqueueTextTurn(text: string, cursor?: string | null): void {
    this.enqueueTurn((ctx) => {
      ctx.host.publish({ type: "assistant-delta", delta: text });
      return Promise.resolve({ status: "completed", cursor: cursor ?? null });
    });
  }
}
