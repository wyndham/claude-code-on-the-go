declare module "@anthropic-ai/claude-code" {
  interface QueryOptions {
    prompt: string;
    abortController: AbortController;
    options: Record<string, any>;
  }

  interface SDKMessage {
    type: string;
    subtype?: string;
    [key: string]: any;
  }

  export function query(opts: QueryOptions): AsyncIterable<SDKMessage>;
}
