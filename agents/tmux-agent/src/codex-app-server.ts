import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  preferredModel?: string;
  currentModel?: string;
  cwd?: string;
  approvalPolicy?: string;
};

export type CodexModelOption = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
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
  cwd: string;
  approvalPolicy?: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
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

type Callbacks = {
  onPendingRequest?: (request: CodexPendingRequest) => Promise<void> | void;
  onTurnCompleted?: (update: CodexTurnUpdate) => Promise<void> | void;
  onError?: (message: string) => Promise<void> | void;
};

const optOutNotificationMethods = [
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
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
  private approvalPolicy?: string;
  private contextUsedTokens?: number;
  private contextWindowTokens?: number;
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
      cwd: this.workingDir,
      approvalPolicy: this.approvalPolicy,
      contextUsedTokens: this.contextUsedTokens,
      contextWindowTokens: this.contextWindowTokens
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
        models.push({
          id,
          label,
          description: stringValue(item.description),
          isDefault: item.isDefault === true
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
      effort: null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null
    });
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
    if (stored.threadId) {
      try {
        const resumed = await this.request("thread/resume", {
          threadId: stored.threadId,
          model: stored.preferredModel ?? null,
          modelProvider: null,
          serviceTier: null,
          cwd: this.workingDir,
          approvalPolicy: "on-request",
          approvalsReviewer: null,
          sandbox: "workspace-write",
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
      }
    }

    const started = await this.request("thread/start", {
      model: this.preferredModel ?? null,
      modelProvider: null,
      serviceTier: null,
      cwd: this.workingDir,
      approvalPolicy: "on-request",
      approvalsReviewer: null,
      sandbox: "workspace-write",
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
    void this.persistState();
  }

  private async loadState(): Promise<StoredCodexState> {
    try {
      const content = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(content) as StoredCodexState;
      this.threadId = this.threadId ?? parsed.threadId;
      this.preferredModel = this.preferredModel ?? parsed.preferredModel;
      this.currentModel = this.currentModel ?? parsed.currentModel ?? parsed.preferredModel;
      this.approvalPolicy = this.approvalPolicy ?? parsed.approvalPolicy;
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
      cwd: this.workingDir,
      approvalPolicy: this.approvalPolicy
    };
    await writeFile(this.statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
        if (this.activeTurn) {
          const turn = objectValue(params.turn);
          this.activeTurn.turnId = stringValue(turn?.id);
        }
        return;
      case "item/agentMessage/delta":
        if (this.activeTurn) {
          this.activeTurn.text += stringValue(params.delta) ?? "";
        }
        return;
      case "thread/tokenUsage/updated": {
        const usage = objectValue(params.tokenUsage);
        const total = objectValue(usage?.total);
        this.contextUsedTokens = numberValue(total?.totalTokens);
        this.contextWindowTokens = numberValue(usage?.modelContextWindow);
        return;
      }
      case "model/rerouted":
        this.currentModel = stringValue(params.toModel) ?? this.currentModel;
        await this.persistState();
        return;
      case "serverRequest/resolved":
        if (this.pendingRequest && this.pendingRequest.requestId === String(params.requestId ?? "")) {
          this.pendingRequest = undefined;
        }
        return;
      case "turn/completed":
        await this.handleTurnCompleted(params);
        return;
      case "error":
        await this.reportError(stringValue(params.message) ?? "Codex app-server reported an error.");
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

function formatRpcError(error: JsonRpcError): string {
  if (!error.message) {
    return "Codex app-server request failed.";
  }
  return error.code == null ? error.message : `${error.message} (code ${error.code})`;
}
