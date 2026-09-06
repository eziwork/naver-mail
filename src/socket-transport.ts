import type { Socket } from "node:net";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

export class SocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly readBuffer = new ReadBuffer();
  private started = false;
  private closed = false;
  private pendingBytes = 0;

  constructor(private readonly socket: Socket, private readonly onActivity = () => {}) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("Socket transport already started.");
    this.started = true;
    this.socket.on("data", this.handleData);
    this.socket.on("error", this.handleError);
    this.socket.on("close", this.handleClose);
    this.socket.resume();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed || this.socket.destroyed) throw new Error("Socket transport is closed.");
    await new Promise<void>((resolve, reject) => {
      this.socket.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.socket.end();
    this.onclose?.();
  }

  private readonly handleData = (chunk: Buffer): void => {
    try {
      for (const byte of chunk) {
        this.pendingBytes += 1;
        if (this.pendingBytes > 2 * 1024 * 1024) throw new Error("MCP request too large.");
        if (byte === 10) this.pendingBytes = 0;
      }
      this.readBuffer.append(chunk);
      while (true) {
        const message = this.readBuffer.readMessage();
        if (message === null) break;
        this.onActivity();
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly handleError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.onclose?.();
  };

  private detach(): void {
    this.socket.off("data", this.handleData);
    this.socket.off("error", this.handleError);
    this.socket.off("close", this.handleClose);
    this.readBuffer.clear();
  }
}
