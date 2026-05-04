import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

export class JsonRpcPeer {
  private nextId = 1000;
  private readonly pending = new Map<number | string, Pending>();
  private readonly handlers = new Map<string, (params: any, request: JsonRpcRequest) => Promise<any> | any>();
  private readonly activeHandlers = new Set<Promise<void>>();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  on(method: string, handler: (params: any, request: JsonRpcRequest) => Promise<any> | any): void {
    this.handlers.set(method, handler);
  }

  start(): void {
    const rl = readline.createInterface({ input: this.input, terminal: false });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const active = this.handleLine(line).finally(() => this.activeHandlers.delete(active));
      this.activeHandlers.add(active);
    });
    rl.on("close", () => {
      if (this.activeHandlers.size === 0) return;
      const timer = setInterval(() => {
        if (this.activeHandlers.size > 0) return;
        clearInterval(timer);
      }, 10);
    });
  }

  notify(method: string, params?: any): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params?: any, timeoutMs = 30 * 60 * 1000): Promise<any> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private async handleLine(line: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(line.replace(/^\uFEFF/, ""));
    } catch {
      return;
    }

    if (msg && Object.prototype.hasOwnProperty.call(msg, "id") && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "JSON-RPC error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (!msg?.method) return;
    const request = msg as JsonRpcRequest;
    const handler = this.handlers.get(request.method);
    if (!handler) {
      if (request.id !== undefined) await this.writeError(request.id, -32601, `Method not found: ${request.method}`);
      return;
    }

    try {
      const result = await handler(request.params, request);
      if (request.id !== undefined) await this.write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      if (request.id !== undefined) {
        await this.writeError(request.id, -32603, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private writeError(id: string | number | null, code: number, message: string): Promise<void> {
    return this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.output.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
