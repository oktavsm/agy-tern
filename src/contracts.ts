import type {
  AuthMethodTerminal,
  AvailableCommand,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ListSessionsResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
  UsageUpdate,
} from '@agentclientprotocol/sdk';

export interface PermissionPrompt {
  id: string;
  request: RequestPermissionRequest;
  answer(optionId: string | null): void;
}

export interface ElicitationPrompt {
  id: string;
  request: CreateElicitationRequest;
  answer(response: CreateElicitationResponse | null): void;
}

export interface AccountTier {
  name: string;
  id?: string;
  upgradeUri?: string;
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export interface ResourceAttachment {
  uri: string;
  text: string;
  mimeType?: string;
}

export interface AgentMetadata {
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  usage?: UsageUpdate;
  tier?: AccountTier;
}

export interface AgentAuthentication {
  terminalMethods: AuthMethodTerminal[];
  logout: boolean;
}

export type ConnectionStage = 'spawning' | 'initializing' | 'opening_session' | 'syncing_config';

export interface ListSessionsOptions {
  allWorkspaces?: boolean;
}

export interface AgentEvents {
  update(notification: SessionNotification): void;
  permission(prompt: PermissionPrompt): void;
  elicitation?(prompt: ElicitationPrompt): void;
  elicitationComplete?(notification: CompleteElicitationNotification): void;
  diagnostic(text: string): void;
  disconnected(message: string): void;
  connectionStage?(stage: ConnectionStage): void;
  metadata?(metadata: AgentMetadata): void;
  authentication?(authentication: AgentAuthentication): void;
  sessionChanged?(sessionId: string): void;
}

export interface AgentSession {
  readonly pid?: number;
  readonly sessionId: string;
  readonly metadata: AgentMetadata;
  readonly authentication: AgentAuthentication;
  readonly capabilities: {
    readonly listSessions: boolean;
    readonly loadSession: boolean;
    readonly resumeSession?: boolean;
    readonly closeSession?: boolean;
    readonly additionalDirectories?: boolean;
    readonly appendSystemPrompt?: boolean;
  };
  readonly promptCapabilities?: {
    readonly image: boolean;
    readonly embeddedContext?: boolean;
  };
  listSessions(cursor?: string, options?: ListSessionsOptions): Promise<ListSessionsResponse>;
  newSession(): Promise<void>;
  loadSession(sessionId: string): Promise<void>;
  resumeSession?(sessionId: string): Promise<void>;
  closeSession?(sessionId: string): Promise<void>;
  setConfigOption(configId: string, value: string | boolean): Promise<void>;
  prompt(text: string, images?: readonly ImageAttachment[], resources?: readonly ResourceAttachment[]): Promise<string>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  close(): Promise<void>;
}

export interface InitialConfigRequest {
  model?: string;
  mode?: string;
  thinking?: string;
}

export interface AgentOptions {
  cwd: string;
  executable?: string;
  signal?: AbortSignal;
  initialConfig?: InitialConfigRequest;
  additionalDirectories?: readonly string[];
  agentName?: string;
  appendSystemPrompt?: string;
}

export function terminalLoginProblem(method: AuthMethodTerminal): string | undefined {
  if (method.args?.length !== 1 || method.args[0] !== '--login') {
    return 'Unsupported terminal login arguments. Only the official agy --login flow is supported.';
  }
  if (method.env && Object.keys(method.env).length !== 0) {
    return 'Terminal login environment overrides are not supported. Use the official agy login without overrides.';
  }
  return undefined;
}
