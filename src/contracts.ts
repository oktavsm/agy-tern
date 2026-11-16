import type { AuthMethodTerminal, AvailableCommand, ListSessionsResponse, RequestPermissionRequest, SessionConfigOption, SessionNotification, UsageUpdate } from '@agentclientprotocol/sdk';

export interface PermissionPrompt {
  id: string;
  request: RequestPermissionRequest;
  answer(optionId: string | null): void;
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

export interface AgentEvents {
  update(notification: SessionNotification): void;
  permission(prompt: PermissionPrompt): void;
  diagnostic(text: string): void;
  disconnected(message: string): void;
  metadata?(metadata: AgentMetadata): void;
  authentication?(authentication: AgentAuthentication): void;
  sessionChanged?(sessionId: string): void;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly metadata: AgentMetadata;
  readonly authentication: AgentAuthentication;
  readonly capabilities: {
    readonly listSessions: boolean;
    readonly loadSession: boolean;
    readonly resumeSession?: boolean;
    readonly closeSession?: boolean;
    readonly additionalDirectories?: boolean;
  };
  readonly promptCapabilities?: {
    readonly image: boolean;
    readonly embeddedContext?: boolean;
  };
  listSessions(cursor?: string): Promise<ListSessionsResponse>;
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
}
