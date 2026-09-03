import { describe, expect, it } from "vitest";
import {
  BoundedEventLog,
  DuplicateProviderError,
  ExternalAgentProviderRegistry,
  FakeExternalAgentProvider,
  HostExpiredError,
  RouteResolutionError,
  SessionDisposedError,
  TurnAbortedError,
  UnsupportedModeError,
  offersAllowAlways,
  outcomeForOption,
  parseRouteSpecifier,
  type ActivityEvent,
  type ExternalAgentSession,
  type PermissionOutcome,
  type PermissionRequest,
  type RunTurnArgs,
} from "../src/index.js";

function quietTurn(prompt = "do it"): RunTurnArgs {
  return {
    prompt,
    mode: "approval-required",
    signal: new AbortController().signal,
    onEvent: () => undefined,
    onPermission: () => Promise.resolve("rejected" as PermissionOutcome),
    onUserInput: () => Promise.resolve({ status: "unavailable" as const }),
  };
}

describe("route specifiers", () => {
  it("parses llm routes", () => {
    expect(parseRouteSpecifier("llm:deepseek-chat")).toEqual({ kind: "llm", model: "deepseek-chat" });
  });

  it("parses external-agent routes", () => {
    expect(parseRouteSpecifier("external-agent:acme/coder")).toEqual({
      kind: "external-agent",
      provider: "acme",
      model: "coder",
    });
  });

  it("rejects unknown or malformed specifiers without fallback", () => {
    expect(() => parseRouteSpecifier("acme/coder")).toThrow(RouteResolutionError);
    expect(() => parseRouteSpecifier("llm:")).toThrow(RouteResolutionError);
    expect(() => parseRouteSpecifier("external-agent:only-provider")).toThrow(RouteResolutionError);
    expect(() => parseRouteSpecifier("external-agent:/no-provider")).toThrow(RouteResolutionError);
  });
});

describe("registry", () => {
  it("rejects duplicate registration", () => {
    const registry = new ExternalAgentProviderRegistry();
    const provider = new FakeExternalAgentProvider("acme", [{ id: "coder", supportedModes: ["approval-required"] }]);
    registry.register(provider);
    expect(() => registry.register(provider)).toThrow(DuplicateProviderError);
  });

  it("resolves exact provider/model pairs and rejects unknown models", async () => {
    const registry = new ExternalAgentProviderRegistry();
    registry.register(new FakeExternalAgentProvider("acme", [{ id: "coder", supportedModes: ["approval-required"] }]));
    await expect(registry.resolveExternalRoute("acme", "coder")).resolves.toEqual({
      kind: "external-agent",
      provider: "acme",
      model: "coder",
    });
    await expect(registry.resolveExternalRoute("acme", "other")).rejects.toThrow(RouteResolutionError);
    await expect(registry.resolveExternalRoute("missing", "coder")).rejects.toThrow(RouteResolutionError);
  });

  it("disposer unregisters and is idempotent", () => {
    const registry = new ExternalAgentProviderRegistry();
    const provider = new FakeExternalAgentProvider("acme", []);
    const dispose = registry.register(provider);
    expect(registry.has("acme")).toBe(true);
    dispose();
    dispose();
    expect(registry.has("acme")).toBe(false);
    expect(registry.names()).toEqual([]);
  });

  it("reregistration after dispose works for HMR replacement", () => {
    const registry = new ExternalAgentProviderRegistry();
    const first = new FakeExternalAgentProvider("acme", []);
    const dispose = registry.register(first);
    dispose();
    const second = new FakeExternalAgentProvider("acme", []);
    expect(() => registry.register(second)).not.toThrow();
    expect(registry.get("acme")).toBe(second);
  });
});

describe("sessions", () => {
  it("opens the exact model and rejects unknown models", () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    const session = provider.openSession({ model: "coder" });
    expect(session.model).toBe("coder");
    expect(session.provider).toBe("acme");
    expect(() => provider.openSession({ model: "other" })).toThrow(RouteResolutionError);
  });

  it("rejects unadvertised modes", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    const session = provider.openSession({ model: "coder" });
    await expect(session.runTurn({ ...quietTurn(), mode: "full-access" })).rejects.toThrow(UnsupportedModeError);
  });

  it("reports cancelled for a pre-aborted signal without executing", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    const session = provider.openSession({ model: "coder" });
    let executed = false;
    provider.enqueueTurn(() => {
      executed = true;
      return Promise.resolve({ status: "completed" as const, cursor: null });
    });
    const controller = new AbortController();
    controller.abort();
    const result = await session.runTurn({ ...quietTurn(), signal: controller.signal });
    expect(result).toEqual({ status: "cancelled", cursor: null });
    expect(executed).toBe(false);
    expect(provider.pendingTurns).toBe(1);
  });

  it("disposal is idempotent and later turns throw", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    const session: ExternalAgentSession = provider.openSession({ model: "coder" });
    expect(session.isDisposed).toBe(false);
    await session.dispose();
    await session.dispose();
    expect(session.isDisposed).toBe(true);
    await expect(session.runTurn(quietTurn())).rejects.toThrow(SessionDisposedError);
  });

  it("aborts a pending permission request when the turn is cancelled", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    provider.enqueueTurn(async (ctx) => {
      await expect(ctx.host.requestPermission({ tool: "rm", summary: "delete", options: [] })).rejects.toThrow(
        TurnAbortedError,
      );
      return { status: "cancelled", cursor: null };
    });
    const session = provider.openSession({ model: "coder" });
    const controller = new AbortController();
    const pending = session.runTurn({
      ...quietTurn(),
      signal: controller.signal,
      onPermission: () => new Promise<PermissionOutcome>(() => undefined),
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled", cursor: null });
  });

  it("resumes a cursor from the previous turn of the same provider", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    provider.enqueueTextTurn("first", "cursor-1");
    const first = provider.openSession({ model: "coder" });
    const one = await first.runTurn(quietTurn("first"));
    expect(one.cursor).toBe("cursor-1");
    const resumed = provider.openSession({ model: "coder", resumeCursor: one.cursor });
    expect(resumed.cursor).toBe("cursor-1");
    provider.enqueueTextTurn("second", "cursor-2");
    const two = await resumed.runTurn(quietTurn("second"));
    expect(two.cursor).toBe("cursor-2");
  });

  it("keeps native histories separate across providers", async () => {
    const left = new FakeExternalAgentProvider("left", [{ id: "coder", supportedModes: ["approval-required"] }]);
    const right = new FakeExternalAgentProvider("right", [{ id: "coder", supportedModes: ["approval-required"] }]);
    left.enqueueTextTurn("left", "left-1");
    right.enqueueTextTurn("right", "right-1");
    const a = await left.openSession({ model: "coder" }).runTurn(quietTurn());
    const b = await right.openSession({ model: "coder" }).runTurn(quietTurn());
    expect(a.cursor).toBe("left-1");
    expect(b.cursor).toBe("right-1");
  });
});

describe("turn host", () => {
  it("publishes activity and answers permission from the consumer", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required", "auto-accept-edits"] },
    ]);
    provider.enqueueTurn(async (ctx) => {
      ctx.host.publish({ type: "assistant-delta", delta: "hello" });
      ctx.host.publish({ type: "tool-start", tool: "edit" });
      const outcome = await ctx.host.requestPermission({
        tool: "edit",
        summary: "edit file",
        options: [{ id: "once", kind: "allow-once", label: "Allow once" }],
      });
      ctx.host.publish({ type: "tool-end", tool: "edit", exit: "ok" });
      ctx.host.publish({ type: "plan-update", plan: ["done"] });
      ctx.host.publish({ type: "usage", inputTokens: 3, outputTokens: 4 });
      return { status: "completed", cursor: "cursor-9", message: outcome };
    });
    const session = provider.openSession({ model: "coder" });
    const seen: ActivityEvent[] = [];
    const result = await session.runTurn({
      ...quietTurn(),
      mode: "auto-accept-edits",
      onEvent: (event) => seen.push(event),
      onPermission: (request: PermissionRequest) => {
        expect(request.tool).toBe("edit");
        return Promise.resolve("allowed-once" as PermissionOutcome);
      },
    });
    expect(result.status).toBe("completed");
    expect(result.message).toBe("allowed-once");
    expect(seen.map((event) => event.type)).toEqual([
      "assistant-delta",
      "tool-start",
      "tool-end",
      "plan-update",
      "usage",
    ]);
  });

  it("routes user questions through the consumer and returns answers", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    provider.enqueueTurn(async (ctx) => {
      const answer = await ctx.host.requestUserInput({
        questions: [{ id: "q1", question: "proceed?", options: ["yes", "no"] }],
      });
      return {
        status: "completed",
        cursor: null,
        message: answer.status === "answered" ? answer.answers["q1"] : answer.status,
      };
    });
    const session = provider.openSession({ model: "coder" });
    const result = await session.runTurn({
      ...quietTurn(),
      onUserInput: (request) => {
        expect(request.questions).toHaveLength(1);
        return Promise.resolve({ status: "answered", answers: { q1: "yes" } });
      },
    });
    expect(result.message).toBe("yes");
  });

  it("refuses retained host use after the turn settles", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    let retained: { publish: (event: ActivityEvent) => void } | undefined;
    provider.enqueueTurn(async (ctx) => {
      retained = ctx.host;
      return { status: "completed", cursor: null };
    });
    const session = provider.openSession({ model: "coder" });
    await session.runTurn(quietTurn());
    expect(retained).toBeDefined();
    expect(() => retained!.publish({ type: "assistant-delta", delta: "late" })).toThrow(HostExpiredError);
  });

  it("propagates provider failures with zero retries", async () => {
    const provider = new FakeExternalAgentProvider("acme", [
      { id: "coder", supportedModes: ["approval-required"] },
    ]);
    let calls = 0;
    provider.enqueueTurn(() => {
      calls += 1;
      return Promise.reject(new Error("transport blew up"));
    });
    const session = provider.openSession({ model: "coder" });
    await expect(session.runTurn(quietTurn())).rejects.toThrow("transport blew up");
    expect(calls).toBe(1);
  });
});

describe("permission options and outcomes", () => {
  it("maps options to outcomes", () => {
    expect(outcomeForOption({ id: "a", kind: "allow-once", label: "once" })).toBe("allowed-once");
    expect(outcomeForOption({ id: "b", kind: "allow-always", label: "always", scope: "session" })).toBe(
      "allowed-for-session",
    );
    expect(outcomeForOption({ id: "c", kind: "reject", label: "no" })).toBe("rejected");
  });

  it("detects offered allow-always", () => {
    expect(offersAllowAlways([{ id: "a", kind: "allow-once", label: "once" }])).toBe(false);
    expect(
      offersAllowAlways([{ id: "b", kind: "allow-always", label: "always", scope: "session" }]),
    ).toBe(true);
  });
});

describe("bounded event log", () => {
  it("drops the oldest events past the cap", () => {
    const log = new BoundedEventLog({ maxEvents: 2 });
    log.push({ type: "assistant-delta", delta: "one" });
    log.push({ type: "assistant-delta", delta: "two" });
    log.push({ type: "assistant-delta", delta: "three" });
    expect(log.size).toBe(2);
    expect(log.dropped).toBe(1);
    expect(log.events()).toEqual([
      { type: "assistant-delta", delta: "two" },
      { type: "assistant-delta", delta: "three" },
    ]);
  });

  it("truncates oversized strings at code-point boundaries", () => {
    const log = new BoundedEventLog({ maxCharsPerString: 2 });
    log.push({ type: "assistant-delta", delta: "abc" });
    log.push({ type: "plan-update", plan: ["abcdef"] });
    log.push({ type: "notice", level: "warning", message: "\u{1F600}xyz" });
    const stored = log.events();
    expect(stored[0]).toEqual({ type: "assistant-delta", delta: "ab" });
    expect(stored[1]).toEqual({ type: "plan-update", plan: ["ab"] });
    expect(stored[2]).toEqual({ type: "notice", level: "warning", message: "\u{1F600}x" });
  });

  it("leaves numeric usage events intact", () => {
    const log = new BoundedEventLog({ maxCharsPerString: 0 });
    log.push({ type: "usage", inputTokens: 7, outputTokens: 8 });
    expect(log.events()).toEqual([{ type: "usage", inputTokens: 7, outputTokens: 8 }]);
  });
});
