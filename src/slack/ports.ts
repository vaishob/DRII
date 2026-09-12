import type { KnownBlock } from "@slack/types";

export type Blocks = KnownBlock[];
export interface SourceMessage {
  ts: string;
  text: string;
  fileIds: string[];
}
export interface SlackFile {
  id: string;
  name: string;
  size: number;
  mimetype: string;
  downloadUrl: string;
}
export interface SlackPort {
  getMessage(channelId: string, ts: string): Promise<SourceMessage>;
  getFile(id: string): Promise<SlackFile>;
  post(
    channelId: string,
    threadTs: string,
    text: string,
    blocks?: Blocks,
  ): Promise<string>;
  update(
    channelId: string,
    ts: string,
    text: string,
    blocks?: Blocks,
  ): Promise<void>;
  ephemeral(
    channelId: string,
    userId: string,
    threadTs: string,
    text: string,
    blocks?: Blocks,
  ): Promise<void>;
}

export interface SafeLogger {
  warn(fields: Record<string, string>, message: string): void;
  error(fields: Record<string, string>, message: string): void;
}
