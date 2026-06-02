import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

type JsonRpcId = string;

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type StoredCodexState = {
  threadId?: string;
  forkFromThreadId?: string;
  preferredModel?: string;
  currentModel?: string;
  reasoningEffort?: ReasoningEffort;
  cwd?: string;
  approvalPolicy?: string;
  sandboxPolicy?: string;
  modelProvider?: string;
  modelProviderBaseUrl?: string;
  permissions?: string;
  collaborationMode?: string;
  agentsFile?: string;
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexModelOption = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts: Array<{
    id: ReasoningEffort;
    label: string;
    description?: string;
  }>;
};

export type CodexTurnUpdate = {
  threadId: string;
  turnId: string;
  prompt: string;
  text: string;
  status: "completed" | "interrupted" | "failed";
  model?: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  error?: string;
};

export type CodexProcessUpdate = {
  title: string;
  body?: string;
};

export type CodexApprovalRequest = {
  kind: "commandExecution" | "fileChange" | "permissions";
  requestId: string;
  title: string;
  body: string;
  allowForSession: boolean;
};

export type CodexInputRequest = {
  kind: "toolInput";
  requestId: string;
  title: string;
  body: string;
  questionId: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowsFreeform: boolean;
};

export type CodexPendingRequest = CodexApprovalRequest | CodexInputRequest;

export type CodexSessionStatus = {
  threadId?: string;
  currentModel?: string;
  preferredModel?: string;
  reasoningEffort?: ReasoningEffort;
  cwd: string;
  approvalPolicy?: string;
  sandboxPolicy?: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  goal?: CodexGoal | null;
};

export type CodexGoal = {
  threadId?: string;
  objective: string;
  status?: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAt?: number;
  updatedAt?: number;
};

export type CodexMcpServerStatus = {
  name: string;
  status?: string;
  details?: string;
};

export type CodexOfficialStatus = {
  threadId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  cwd: string;
  approvalPolicy?: string;
  sandboxPolicy?: string;
  modelProvider?: string;
  modelProviderBaseUrl?: string;
  permissions?: string;
  collaborationMode?: string;
  agentsFile?: string;
  account?: Record<string, unknown>;
  rateLimits?: Record<string, unknown>;
  config?: Record<string, unknown>;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};

type ActiveTurn = {
  prompt: string;
  turnId?: string;
  text: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  error?: string;
};

type PendingApprovalRequest = {
  kind: "commandExecution" | "fileChange" | "permissions";
  requestId: string;
  params: Record<string, unknown>;
};

type PendingInputRequest = {
  kind: "toolInput";
  requestId: string;
  questionId: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowsFreeform: boolean;
};

const defaultApprovalPolicy = "never";
const defaultSandboxPolicy = "danger-full-access";

type Callbacks = {
  onPendingRequest?: (request: CodexPendingRequest) => Promise<void> | void;
  onProcessUpdate?: (update: CodexProcessUpdate) => Promise<void> | void;
  onAssistantDelta?: (delta: string, fullText: string) => Promise<void> | void;
  onTurnCompleted?: (update: CodexTurnUpdate) => Promise<void> | void;
  onError?: (message: string) => Promise<void> | void;
};

const optOutNotificationMethods = [
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "thread/realtime/outputAudio/delta"
];

export class CodexAppServerClient {
  private readonly sessionName: string;
  private readonly workingDir: string;
  private readonly bridgeDir: string;
  private readonly callbacks: Callbacks;
  private readonly statePath: string;
  private readonly stderrPath: string;
  private child?: ChildProcessWithoutNullStreams;
  private stderrStream?: fs.WriteStream;
  private startPromise?: Promise<void>;
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, PendingRpc>();
  private threadId?: string;
  private currentModel?: string;
  private preferredModel?: string;
  private reasoningEffort?: ReasoningEffort;
  private approvalPolicy?: string;
  private sandboxPolicy?: string;
  private modelProvider?: string;
  private modelProviderBaseUrl?: string;
  private permissions?: string;
  private collaborationMode?: string;
  private contextUsedTokens?: number;
  private contextWindowTokens?: number;
  private tokenUsageBreakdown: {
    totalTokens?: number;
    lastTokens?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  } = {};
  private goal?: CodexGoal | null;
  private activeTurn?: ActiveTurn;
  private pendingRequest?: PendingApprovalRequest | PendingInputRequest;

  constructor(input: {
    sessionName: string;
    workingDir: string;
    bridgeDir: string;
    preferredModel?: string;
    callbacks?: Callbacks;
  }) {
    this.sessionName = input.sessionName;
    this.workingDir = input.workingDir;
    this.bridgeDir = input.bridgeDir;
    this.statePath = path.join(this.bridgeDir, "app-server-state.json");
    this.stderrPath = path.join(this.bridgeDir, "app-server.stderr.log");
    this.preferredModel = input.preferredModel;
    this.callbacks = input.callbacks ?? {};
  }

  get status(): CodexSessionStatus {
    return {
      threadId: this.threadId,
      currentModel: this.currentModel,
      preferredModel: this.preferredModel,
      reasoningEffort: this.reasoningEffort,
      cwd: this.workingDir,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy,
      contextUsedTokens: this.contextUsedTokens,
      contextWindowTokens: this.contextWindowTokens,
      goal: this.goal
    };
  }

  get isTurnActive(): boolean {
    return Boolean(this.activeTurn);
  }

  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.startInternal();
    }
    await this.startPromise;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.activeTurn = undefined;
    this.pendingRequest = undefined;
    if (!child) {
      if (this.stderrStream) {
        this.stderrStream.end();
        this.stderrStream = undefined;
      }
      return;
    }
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000);
    });
    if (this.stderrStream) {
      this.stderrStream.end();
      this.stderrStream = undefined;
    }
  }

  async listModels(): Promise<CodexModelOption[]> {
    await this.start();
    const models: CodexModelOption[] = [];
    let cursor: string | null | undefined;
    do {
      const result = await this.request("model/list", {
        cursor: cursor ?? null,
        limit: 100,
        includeHidden: false
      }) as { data?: Array<Record<string, unknown>>; nextCursor?: string | null };
      for (const item of result.data ?? []) {
        const hidden = item.hidden === true;
        if (hidden) {
          continue;
        }
        const id = stringValue(item.id);
        const label = stringValue(item.displayName) ?? stringValue(item.model) ?? id;
        if (!id || !label) {
          continue;
        }
        const defaultReasoningEffort = reasoningEffortValue(item.defaultReasoningEffort);
        const supportedReasoningEfforts = Array.isArray(item.supportedReasoningEfforts)
          ? parseReasoningEffortOptions(item.supportedReasoningEfforts)
          : [];
        models.push({
          id,
          label,
          description: stringValue(item.description),
          isDefault: item.isDefault === true,
          defaultReasoningEffort,
          supportedReasoningEfforts
        });
      }
      cursor = result.nextCursor;
    } while (cursor);
    return models;
  }

  async setPreferredModel(modelId: string): Promise<void> {
    this.preferredModel = modelId;
    this.currentModel = modelId;
    await this.persistState();
  }

  async setReasoningEffort(effort: ReasoningEffort | undefined): Promise<void> {
    this.reasoningEffort = effort;
    await this.persistState();
  }

  async getGoal(): Promise<CodexGoal | null> {
    await this.start();
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }
    const result = await this.request("thread/goal/get", {
      threadId: this.threadId
    }) as Record<string, unknown>;
    this.goal = parseGoal(result.goal);
    return this.goal;
  }

  async setGoal(objective: string, tokenBudget?: number): Promise<CodexGoal> {
    await this.start();
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }
    const trimmed = objective.trim();
    if (!trimmed) {
      throw new Error("Goal objective must not be empty.");
    }
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      objective: trimmed
    };
    if (tokenBudget != null) {
      params.tokenBudget = tokenBudget;
    }
    const result = await this.request("thread/goal/set", params) as Record<string, unknown>;
    const goal = parseGoal(result.goal);
    if (!goal) {
      throw new Error("Codex did not return the updated goal.");
    }
    this.goal = goal;
    return goal;
  }

  async clearGoal(): Promise<boolean> {
    await this.start();
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }
    const result = await this.request("thread/goal/clear", {
      threadId: this.threadId
    }) as Record<string, unknown>;
    this.goal = null;
    return result.cleared === true;
  }

  async setThreadName(name: string): Promise<void> {
    await this.start();
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Thread name must not be empty.");
    }
    await this.request("thread/name/set", {
      threadId: this.threadId,
      name: trimmed
    });
  }

  async compactThread(): Promise<void> {
    await this.start();
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }
    await this.request("thread/compact/start", {
      threadId: this.threadId
    });
  }

  async setMemoryMode(enabled: boolean): Promise<void> {
    await this.start();
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }
    await this.request("thread/memoryMode/set", {
      threadId: this.threadId,
      enabled
    });
  }

  async resetMemory(): Promise<void> {
    await this.start();
    await this.request("memory/reset", {});
  }

  async listMcpServerStatus(): Promise<CodexMcpServerStatus[]> {
    await this.start();
    const result = await this.request("mcpServerStatus/list", {}) as Record<string, unknown>;
    const candidates = Array.isArray(result.servers)
      ? result.servers
      : Array.isArray(result.data)
        ? result.data
        : Array.isArray(result.statuses)
          ? result.statuses
          : [];
    return candidates.flatMap((item) => {
      const value = objectValue(item);
      const name = stringValue(value?.name) ?? stringValue(value?.serverName) ?? stringValue(value?.id);
      if (!name) {
        return [];
      }
      return [{
        name,
        status: stringValue(value?.status) ?? stringValue(value?.state),
        details: stringValue(value?.details) ?? stringValue(value?.message)
      }];
    });
  }

  async getOfficialStatus(): Promise<CodexOfficialStatus> {
    await this.start();
    await this.refreshTokenUsageFromRollout();
    const [account, rateLimits, config] = await Promise.all([
      this.optionalRequest("account/read", {}),
      this.optionalRequest("account/rateLimits/read", {}),
      this.optionalRequest("config/read", {})
    ]);
    const configBody = objectValue(objectValue(config)?.config) ?? objectValue(config);
    const providerName = this.modelProvider
      ?? stringValue(configBody?.model_provider)
      ?? stringValue(configBody?.modelProvider);
    const providers = objectValue(configBody?.model_providers) ?? objectValue(configBody?.modelProviders);
    const providerConfig = providerName ? objectValue(providers?.[providerName]) : undefined;
    const configSandbox = stringValue(configBody?.sandbox_mode) ?? stringValue(configBody?.sandboxMode);
    return {
      threadId: this.threadId,
      model: this.currentModel ?? this.preferredModel ?? stringValue(configBody?.model),
      reasoningEffort: this.reasoningEffort ?? reasoningEffortValue(configBody?.model_reasoning_effort),
      cwd: this.workingDir,
      approvalPolicy: stringValue(configBody?.approval_policy) ?? this.approvalPolicy,
      sandboxPolicy: configSandbox ?? this.sandboxPolicy,
      modelProvider: providerName,
      modelProviderBaseUrl: this.modelProviderBaseUrl
        ?? stringValue(providerConfig?.base_url)
        ?? stringValue(providerConfig?.baseUrl),
      permissions: this.permissions,
      collaborationMode: this.collaborationMode ?? "Default",
      agentsFile: await this.findAgentsFile(),
      account: objectValue(account),
      rateLimits: objectValue(rateLimits),
      config: configBody,
      contextUsedTokens: this.contextUsedTokens,
      contextWindowTokens: this.contextWindowTokens,
      ...this.tokenUsageBreakdown
    };
  }

  async startNewThread(): Promise<void> {
    await this.start();
    await this.resetThreadState();
    await this.ensureThread();
  }

  async seedThreadState(input: {
    threadId?: string;
    forkFromThreadId?: string;
    preferredModel?: string;
    currentModel?: string;
    reasoningEffort?: ReasoningEffort;
    approvalPolicy?: string;
    sandboxPolicy?: string;
  }): Promise<void> {
    const payload: StoredCodexState = {
      threadId: input.threadId,
      forkFromThreadId: input.forkFromThreadId,
      preferredModel: input.preferredModel,
      currentModel: input.currentModel,
      reasoningEffort: input.reasoningEffort,
      cwd: this.workingDir,
      approvalPolicy: input.approvalPolicy,
      sandboxPolicy: input.sandboxPolicy
    };
    await mkdir(this.bridgeDir, { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    this.preferredModel = input.preferredModel ?? this.preferredModel;
    this.currentModel = input.currentModel ?? input.preferredModel ?? this.currentModel;
    this.reasoningEffort = input.reasoningEffort ?? this.reasoningEffort;
    this.approvalPolicy = input.approvalPolicy ?? this.approvalPolicy;
    this.sandboxPolicy = input.sandboxPolicy ?? this.sandboxPolicy;
  }

  async startTurn(prompt: string): Promise<void> {
    await this.start();
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }
    if (this.activeTurn) {
      throw new Error("Codex is still working on the previous request.");
    }

    this.activeTurn = {
      prompt,
      text: "",
      status: "inProgress"
    };

    try {
      await this.startTurnRequest(prompt);
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        this.activeTurn = undefined;
        throw error;
      }
      await this.resetThreadState();
      await this.ensureThread();
      if (!this.threadId) {
        this.activeTurn = undefined;
        throw new Error("Codex thread is not ready after recovery.");
      }
      await this.startTurnRequest(prompt);
    }
  }

  async interruptActiveTurn(): Promise<boolean> {
    await this.start();
    if (!this.threadId || !this.activeTurn?.turnId) {
      return false;
    }
    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.activeTurn.turnId
    });
    return true;
  }

  async steerActiveTurn(text: string): Promise<boolean> {
    await this.start();
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Steer text must not be empty.");
    }
    if (!this.threadId || !this.activeTurn?.turnId) {
      return false;
    }
    await this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurn.turnId,
      input: [
        {
          type: "text",
          text: trimmed,
          text_elements: []
        }
      ]
    });
    return true;
  }

  getPendingRequest(): CodexPendingRequest | undefined {
    const request = this.pendingRequest;
    if (!request) {
      return undefined;
    }

    if (request.kind === "toolInput") {
      const body = stringValue((request as PendingInputRequest & { body?: unknown }).body) ?? "Codex needs more input.";
      return {
        kind: "toolInput",
        requestId: request.requestId,
        title: "Codex input required",
        body,
        questionId: request.questionId,
        options: request.options,
        allowsFreeform: request.allowsFreeform
      };
    }

    const params = request.params;
    const reason = stringValue(params.reason) ?? "Codex needs approval to continue.";
    const command = stringValue(params.command);
    const cwd = stringValue(params.cwd);
    const body = [reason, command ? `Command: ${command}` : undefined, cwd ? `Directory: ${cwd}` : undefined]
      .filter(Boolean)
      .join("\n");

    return {
      kind: request.kind,
      requestId: request.requestId,
      title: request.kind === "fileChange"
        ? "Approve file changes"
        : request.kind === "permissions"
          ? "Approve permissions"
          : "Approve command",
      body,
      allowForSession: request.kind !== "permissions"
        && Array.isArray(params.availableDecisions)
        && params.availableDecisions.some((value) => value === "acceptForSession")
    };
  }

  async approvePendingRequest(scope: "turn" | "session" = "turn"): Promise<boolean> {
    const request = this.pendingRequest;
    if (!request) {
      return false;
    }

    if (request.kind === "toolInput") {
      return false;
    }

    if (request.kind === "permissions") {
      const permissions = request.params.permissions as Record<string, unknown> | null | undefined;
      await this.respond(request.requestId, {
        permissions: {
          network: permissions?.network ?? null,
          fileSystem: permissions?.fileSystem ?? null
        },
        scope
      });
      this.pendingRequest = undefined;
      return true;
    }

    const decision = scope === "session" ? "acceptForSession" : "accept";
    await this.respond(request.requestId, { decision });
    this.pendingRequest = undefined;
    return true;
  }

  async declinePendingRequest(): Promise<boolean> {
    const request = this.pendingRequest;
    if (!request) {
      return false;
    }

    if (request.kind === "toolInput") {
      await this.respond(request.requestId, {
        answers: {
          [request.questionId]: {
            answers: []
          }
        }
      });
      this.pendingRequest = undefined;
      return true;
    }

    if (request.kind === "permissions") {
      await this.respond(request.requestId, {
        permissions: {
          network: null,
          fileSystem: null
        },
        scope: "turn"
      });
      this.pendingRequest = undefined;
      return true;
    }

    await this.respond(request.requestId, { decision: "cancel" });
    this.pendingRequest = undefined;
    return true;
  }

  async answerPendingInput(answer: string): Promise<boolean> {
    const request = this.pendingRequest;
    if (!request || request.kind !== "toolInput") {
      return false;
    }

    const trimmed = answer.trim();
    if (!trimmed) {
      throw new Error("Please enter a value before submitting.");
    }

    await this.respond(request.requestId, {
      answers: {
        [request.questionId]: {
          answers: [trimmed]
        }
      }
    });
    this.pendingRequest = undefined;
    return true;
  }

  async selectPendingOption(optionId: string): Promise<boolean> {
    const request = this.pendingRequest;
    if (!request || request.kind !== "toolInput") {
      return false;
    }

    const option = request.options.find((item) => item.id === optionId);
    if (!option) {
      throw new Error("Invalid Codex option selected.");
    }

    await this.respond(request.requestId, {
      answers: {
        [request.questionId]: {
          answers: [option.label]
        }
      }
    });
    this.pendingRequest = undefined;
    return true;
  }

  private async startInternal(): Promise<void> {
    await mkdir(this.bridgeDir, { recursive: true });
    await rm(this.stderrPath, { force: true });
    await this.loadState();
    this.stderrStream = fs.createWriteStream(this.stderrPath, { flags: "a" });
    const child = spawn("codex", ["app-server"], {
      cwd: this.workingDir,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stderr.on("data", (chunk) => {
      this.stderrStream?.write(chunk);
    });
    child.once("error", (error) => {
      void this.reportError(`Codex app-server failed: ${error.message}`);
      this.rejectAll(error);
    });
    child.once("close", (code) => {
      this.child = undefined;
      this.rejectAll(new Error(`Codex app-server exited with code ${code ?? 0}.`));
    });

    const lineReader = createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      void this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "project-iris-codex-bridge",
        title: "Project Iris Codex Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods
      }
    });
    this.send({
      method: "initialized"
    });
    await this.ensureThread();
  }

  private async ensureThread(): Promise<void> {
    if (this.threadId) {
      return;
    }

    const stored = await this.loadState();
    if (stored.forkFromThreadId) {
      try {
        const forked = await this.request("thread/fork", {
          threadId: stored.forkFromThreadId,
          model: stored.preferredModel ?? null,
          modelProvider: null,
          serviceTier: null,
          cwd: this.workingDir,
          approvalPolicy: defaultApprovalPolicy,
          approvalsReviewer: null,
          sandbox: defaultSandboxPolicy,
          config: null,
          baseInstructions: null,
          developerInstructions: null,
          threadSource: "user",
          ephemeral: false
        }) as Record<string, unknown>;
        this.applyThreadEnvelope(forked);
        await this.persistState();
        return;
      } catch (error) {
        await this.reportError(
          error instanceof Error
            ? `Codex fork failed for ${this.sessionName}: ${error.message}`
            : `Codex fork failed for ${this.sessionName}.`
        );
        await this.resetThreadState();
      }
    }

    if (stored.threadId) {
      try {
        const resumed = await this.request("thread/resume", {
          threadId: stored.threadId,
          model: stored.preferredModel ?? null,
          modelProvider: null,
          serviceTier: null,
          cwd: this.workingDir,
          approvalPolicy: defaultApprovalPolicy,
          approvalsReviewer: null,
          sandbox: defaultSandboxPolicy,
          config: null,
          baseInstructions: null,
          developerInstructions: null,
          personality: null,
          persistExtendedHistory: false
        }) as Record<string, unknown>;
        this.applyThreadEnvelope(resumed);
        return;
      } catch (error) {
        await this.reportError(
          error instanceof Error
            ? `Codex resume failed for ${this.sessionName}: ${error.message}`
            : `Codex resume failed for ${this.sessionName}.`
        );
        if (isThreadNotFoundError(error)) {
          await this.resetThreadState();
        }
      }
    }

    const started = await this.request("thread/start", {
      model: this.preferredModel ?? null,
      modelProvider: null,
      serviceTier: null,
      cwd: this.workingDir,
      approvalPolicy: defaultApprovalPolicy,
      approvalsReviewer: null,
      sandbox: defaultSandboxPolicy,
      config: null,
      serviceName: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    }) as Record<string, unknown>;
    this.applyThreadEnvelope(started);
  }

  private applyThreadEnvelope(payload: Record<string, unknown>): void {
    const thread = objectValue(payload.thread);
    if (!thread) {
      throw new Error("Codex did not return a thread.");
    }
    this.threadId = stringValue(thread.id);
    this.currentModel = stringValue(payload.model) ?? this.currentModel ?? this.preferredModel;
    this.approvalPolicy = stringValue(payload.approvalPolicy) ?? this.approvalPolicy;
    this.sandboxPolicy = stringValue(payload.sandbox) ?? stringValue(payload.sandboxPolicy) ?? this.sandboxPolicy ?? defaultSandboxPolicy;
    this.applyRuntimeSettings(payload);
    void this.persistState();
  }

  private async loadState(): Promise<StoredCodexState> {
    try {
      const content = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(content) as StoredCodexState;
      this.preferredModel = this.preferredModel ?? parsed.preferredModel;
      this.currentModel = this.currentModel ?? parsed.currentModel ?? parsed.preferredModel;
      this.reasoningEffort = this.reasoningEffort ?? reasoningEffortValue(parsed.reasoningEffort);
      this.approvalPolicy = this.approvalPolicy ?? parsed.approvalPolicy;
      this.sandboxPolicy = this.sandboxPolicy ?? parsed.sandboxPolicy;
      return parsed;
    } catch {
      return {};
    }
  }

  private async persistState(): Promise<void> {
    const payload: StoredCodexState = {
      threadId: this.threadId,
      preferredModel: this.preferredModel,
      currentModel: this.currentModel,
      reasoningEffort: this.reasoningEffort,
      cwd: this.workingDir,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy
    };
    await writeFile(this.statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private async resetThreadState(): Promise<void> {
    this.threadId = undefined;
    this.activeTurn = undefined;
    this.pendingRequest = undefined;
    await rm(this.statePath, { force: true });
  }

  private async findAgentsFile(): Promise<string | undefined> {
    const filePath = path.join(this.workingDir, "AGENTS.md");
    try {
      await access(filePath);
      return "AGENTS.md";
    } catch {
      return undefined;
    }
  }

  private async refreshTokenUsageFromRollout(): Promise<void> {
    if (!this.threadId) {
      return;
    }
    const readResult = await this.optionalRequest("thread/read", {
      threadId: this.threadId
    });
    const thread = objectValue(objectValue(readResult)?.thread);
    const rolloutPath = stringValue(thread?.path);
    if (!rolloutPath) {
      return;
    }
    let content = "";
    try {
      content = await readFile(rolloutPath, "utf8");
    } catch {
      return;
    }
    for (const line of content.trimEnd().split("\n").reverse()) {
      if (!line.includes("\"token_count\"")) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const payload = objectValue(entry.payload);
        if (payload?.type !== "token_count") {
          continue;
        }
        this.applyTokenUsageFromEvent(payload);
        return;
      } catch {
        continue;
      }
    }
  }

  private applyTokenUsageFromEvent(payload: Record<string, unknown>): void {
    const info = objectValue(payload.info);
    const total = objectValue(info?.total_token_usage) ?? objectValue(info?.totalTokenUsage);
    const last = objectValue(info?.last_token_usage) ?? objectValue(info?.lastTokenUsage);
    const totalTokens = numberValue(total?.total_tokens) ?? numberValue(total?.totalTokens);
    const lastTokens = numberValue(last?.total_tokens) ?? numberValue(last?.totalTokens);
    const modelContextWindow = numberValue(info?.model_context_window)
      ?? numberValue(info?.modelContextWindow)
      ?? numberValue(payload.model_context_window)
      ?? numberValue(payload.modelContextWindow);
    this.contextUsedTokens = lastTokens ?? totalTokens ?? this.contextUsedTokens;
    this.contextWindowTokens = modelContextWindow ?? this.contextWindowTokens;
    this.tokenUsageBreakdown = {
      totalTokens,
      lastTokens,
      inputTokens: numberValue(total?.input_tokens) ?? numberValue(total?.inputTokens),
      cachedInputTokens: numberValue(total?.cached_input_tokens) ?? numberValue(total?.cachedInputTokens),
      outputTokens: numberValue(total?.output_tokens) ?? numberValue(total?.outputTokens),
      reasoningOutputTokens: numberValue(total?.reasoning_output_tokens) ?? numberValue(total?.reasoningOutputTokens)
    };
  }

  private applyRuntimeSettings(value: unknown): void {
    const object = objectValue(value);
    if (!object) {
      return;
    }
    const settings = objectValue(object.settings)
      ?? objectValue(object.threadSettings)
      ?? objectValue(object.thread_settings)
      ?? object;
    this.currentModel = stringValue(settings.model) ?? stringValue(object.model) ?? this.currentModel;
    this.reasoningEffort = reasoningEffortValue(settings.effort ?? settings.reasoningEffort ?? settings.reasoning_effort) ?? this.reasoningEffort;
    this.approvalPolicy = stringValue(settings.approvalPolicy) ?? stringValue(settings.approval_policy) ?? stringValue(object.approvalPolicy) ?? this.approvalPolicy;
    this.sandboxPolicy = stringValue(settings.sandbox) ?? stringValue(settings.sandboxPolicy) ?? stringValue(settings.sandbox_policy) ?? stringValue(object.sandbox) ?? this.sandboxPolicy;
    this.modelProvider = stringValue(settings.modelProvider)
      ?? stringValue(settings.model_provider)
      ?? stringValue(settings.modelProviderId)
      ?? stringValue(settings.model_provider_id)
      ?? stringValue(object.modelProvider)
      ?? stringValue(object.model_provider)
      ?? this.modelProvider;
    const provider = objectValue(settings.modelProviderInfo) ?? objectValue(settings.model_provider_info);
    this.modelProviderBaseUrl = stringValue(provider?.baseUrl)
      ?? stringValue(provider?.base_url)
      ?? stringValue(settings.modelProviderBaseUrl)
      ?? stringValue(settings.model_provider_base_url)
      ?? this.modelProviderBaseUrl;
    this.permissions = stringValue(settings.permissionProfile)
      ?? stringValue(settings.permission_profile)
      ?? stringValue(settings.activePermissionProfile)
      ?? stringValue(settings.active_permission_profile)
      ?? this.permissions;
    this.collaborationMode = stringValue(settings.collaborationMode)
      ?? stringValue(settings.collaboration_mode)
      ?? this.collaborationMode;
  }

  private async startTurnRequest(prompt: string): Promise<void> {
    await this.request("turn/start", {
      threadId: this.threadId,
      input: [
        {
          type: "text",
          text: prompt,
          text_elements: []
        }
      ],
      cwd: null,
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      model: this.preferredModel ?? null,
      effort: this.reasoningEffort ?? null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null
    });
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    } catch {
      await this.reportError(`Invalid Codex app-server message: ${trimmed}`);
      return;
    }

    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      this.handleResponse(message);
      return;
    }

    if ("id" in message && typeof (message as { method?: unknown }).method === "string") {
      await this.handleServerRequest(message as JsonRpcRequest);
      return;
    }

    if ("method" in message) {
      await this.handleNotification(message);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(formatRpcError(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    switch (message.method) {
      case "item/commandExecution/requestApproval":
        await this.storeApprovalRequest("commandExecution", message);
        return;
      case "item/fileChange/requestApproval":
        await this.storeApprovalRequest("fileChange", message);
        return;
      case "item/permissions/requestApproval":
        await this.storeApprovalRequest("permissions", message);
        return;
      case "item/tool/requestUserInput":
        await this.storeInputRequest(message);
        return;
      default:
        await this.respondError(message.id, `Unsupported Codex server request: ${message.method}`);
    }
  }

  private async storeApprovalRequest(
    kind: PendingApprovalRequest["kind"],
    message: JsonRpcRequest
  ): Promise<void> {
    this.pendingRequest = {
      kind,
      requestId: message.id,
      params: objectValue(message.params) ?? {}
    };
    const request = this.getPendingRequest();
    if (request) {
      await this.callbacks.onPendingRequest?.(request);
    }
  }

  private async storeInputRequest(message: JsonRpcRequest): Promise<void> {
    const params = objectValue(message.params) ?? {};
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const question = objectValue(questions[0]);
    if (!question) {
      await this.respondError(message.id, "Codex input request did not include any question.");
      return;
    }

    const options: Array<{ id: string; label: string; description?: string }> = [];
    if (Array.isArray(question.options)) {
      for (const [index, value] of question.options.entries()) {
        const option = objectValue(value);
        const label = stringValue(option?.label);
        if (!label) {
          continue;
        }
        options.push({
          id: `option_${index}`,
          label,
          description: stringValue(option?.description)
        });
      }
    }

    this.pendingRequest = {
      kind: "toolInput",
      requestId: message.id,
      questionId: stringValue(question.id) ?? "answer",
      options,
      allowsFreeform: options.length === 0 || question.isOther === true
    };
    const requestBody = [
      stringValue(question.header),
      stringValue(question.question)
    ].filter(Boolean).join("\n");
    (this.pendingRequest as PendingInputRequest & { body?: string }).body = requestBody || "Codex needs more input.";
    const request = this.getPendingRequest();
    if (request) {
      await this.callbacks.onPendingRequest?.(request);
    }
  }

  private async handleNotification(message: JsonRpcNotification): Promise<void> {
    const params = objectValue(message.params) ?? {};
    switch (message.method) {
      case "turn/started":
        this.applyRuntimeSettings(params);
        if (this.activeTurn) {
          const turn = objectValue(params.turn);
          this.activeTurn.turnId = stringValue(turn?.id);
          await this.callbacks.onProcessUpdate?.({
            title: "Turn started",
            body: stringValue(turn?.id) ? `Turn: ${stringValue(turn?.id)}` : undefined
          });
        }
        return;
      case "thread/started":
      case "thread/status/changed":
        this.applyRuntimeSettings(params);
        return;
      case "item/agentMessage/delta":
        if (this.activeTurn) {
          const delta = stringValue(params.delta) ?? "";
          this.activeTurn.text += delta;
          if (delta) {
            await this.callbacks.onAssistantDelta?.(delta, this.activeTurn.text);
          }
        }
        return;
      case "command/exec/outputDelta":
      case "item/commandExecution/outputDelta": {
        const delta = stringValue(params.delta) ?? stringValue(params.output) ?? stringValue(params.text);
        if (delta) {
          await this.callbacks.onProcessUpdate?.({
            title: "Command output",
            body: delta
          });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = objectValue(params.tokenUsage);
        const total = objectValue(usage?.total);
        const usedTokens = numberValue(usage?.used)
          ?? numberValue(usage?.contextUsedTokens)
          ?? numberValue(usage?.inputTokens)
          ?? numberValue(total?.inputTokens)
          ?? numberValue(total?.totalTokens);
        this.contextUsedTokens = usedTokens;
        this.contextWindowTokens = numberValue(usage?.modelContextWindow);
        this.tokenUsageBreakdown = {
          totalTokens: numberValue(total?.totalTokens),
          lastTokens: usedTokens,
          inputTokens: numberValue(total?.inputTokens),
          cachedInputTokens: numberValue(total?.cachedInputTokens),
          outputTokens: numberValue(total?.outputTokens),
          reasoningOutputTokens: numberValue(total?.reasoningOutputTokens)
        };
        if (this.contextUsedTokens != null && this.contextWindowTokens != null) {
          await this.callbacks.onProcessUpdate?.({
            title: "Context updated",
            body: `${this.contextUsedTokens}/${this.contextWindowTokens} tokens`
          });
        }
        return;
      }
      case "model/rerouted":
        this.currentModel = stringValue(params.toModel) ?? this.currentModel;
        await this.persistState();
        await this.callbacks.onProcessUpdate?.({
          title: "Model rerouted",
          body: this.currentModel
        });
        return;
      case "serverRequest/resolved":
        if (this.pendingRequest && this.pendingRequest.requestId === String(params.requestId ?? "")) {
          this.pendingRequest = undefined;
        }
        await this.callbacks.onProcessUpdate?.({
          title: "Request resolved",
          body: String(params.requestId ?? "")
        });
        return;
      case "turn/completed":
        await this.handleTurnCompleted(params);
        return;
      case "error":
        await this.handleErrorNotification(params);
        return;
      case "thread/settings/updated": {
        const settings = objectValue(params.settings) ?? params;
        this.applyRuntimeSettings(settings);
        await this.persistState();
        await this.callbacks.onProcessUpdate?.({
          title: "Settings updated",
          body: [
            this.currentModel ? `Model: ${this.currentModel}` : undefined,
            this.reasoningEffort ? `Reasoning: ${reasoningEffortLabel(this.reasoningEffort)}` : undefined
          ].filter(Boolean).join("\n") || undefined
        });
        return;
      }
      case "thread/goal/updated": {
        this.goal = parseGoal(params.goal) ?? parseGoal(params);
        await this.callbacks.onProcessUpdate?.({
          title: "Goal updated",
          body: this.goal?.objective
        });
        return;
      }
      case "thread/goal/cleared":
        this.goal = null;
        await this.callbacks.onProcessUpdate?.({
          title: "Goal cleared"
        });
        return;
      default:
        return;
    }
  }

  private async handleTurnCompleted(params: Record<string, unknown>): Promise<void> {
    if (!this.activeTurn || !this.threadId) {
      return;
    }
    const turn = objectValue(params.turn);
    const status = stringValue(turn?.status);
    const error = objectValue(turn?.error);
    this.activeTurn.status = status === "failed"
      ? "failed"
      : status === "interrupted"
        ? "interrupted"
        : "completed";
    this.activeTurn.error = stringValue(error?.message);
    const update: CodexTurnUpdate = {
      threadId: this.threadId,
      turnId: stringValue(turn?.id) ?? this.activeTurn.turnId ?? "",
      prompt: this.activeTurn.prompt,
      text: this.activeTurn.text.trim(),
      status: this.activeTurn.status,
      model: this.currentModel ?? this.preferredModel,
      contextUsedTokens: this.contextUsedTokens,
      contextWindowTokens: this.contextWindowTokens,
      error: this.activeTurn.error
    };
    this.activeTurn = undefined;
    await this.callbacks.onTurnCompleted?.(update);
  }

  private async handleErrorNotification(params: Record<string, unknown>): Promise<void> {
    const message = stringValue(params.message) ?? "Codex app-server reported an error.";
    if (this.activeTurn) {
      await this.callbacks.onProcessUpdate?.({
        title: "Codex error",
        body: message
      });
      return;
    }
    await this.reportError(message);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = `req_${++this.nextId}`;
    const payload = {
      id,
      method,
      params
    };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Failed to talk to Codex app-server."));
      }
    });
  }

  private async optionalRequest(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.request(method, params);
    } catch {
      return undefined;
    }
  }

  private async respond(requestId: string, result: unknown): Promise<void> {
    this.send({
      id: requestId,
      result
    });
  }

  private async respondError(requestId: string, message: string): Promise<void> {
    this.send({
      id: requestId,
      error: {
        code: -32601,
        message
      }
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }

  private async reportError(message: string): Promise<void> {
    await this.callbacks.onError?.(message);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseGoal(value: unknown): CodexGoal | null {
  const object = objectValue(value);
  if (!object) {
    return null;
  }
  const objective = stringValue(object.objective);
  if (!objective) {
    return null;
  }
  return {
    threadId: stringValue(object.threadId),
    objective,
    status: stringValue(object.status),
    tokenBudget: object.tokenBudget === null ? null : numberValue(object.tokenBudget),
    tokensUsed: numberValue(object.tokensUsed),
    timeUsedSeconds: numberValue(object.timeUsedSeconds),
    createdAt: numberValue(object.createdAt),
    updatedAt: numberValue(object.updatedAt)
  };
}

function reasoningEffortValue(value: unknown): ReasoningEffort | undefined {
  return value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    ? value
    : undefined;
}

function parseReasoningEffortOptions(values: unknown[]): Array<{
  id: ReasoningEffort;
  label: string;
  description?: string;
}> {
  const options: Array<{ id: ReasoningEffort; label: string; description?: string }> = [];
  for (const value of values) {
    const object = objectValue(value);
    const id = reasoningEffortValue(object?.reasoningEffort);
    if (!id) {
      continue;
    }
    const description = stringValue(object?.description);
    options.push({
      id,
      label: reasoningEffortLabel(id),
      ...(description ? { description } : {})
    });
  }
  return options;
}

function reasoningEffortLabel(value: ReasoningEffort): string {
  return value === "xhigh" ? "X High" : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatRpcError(error: JsonRpcError): string {
  if (!error.message) {
    return "Codex app-server request failed.";
  }
  return error.code == null ? error.message : `${error.message} (code ${error.code})`;
}

function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /thread not found/i.test(error.message);
}
