export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  generate(): string;
}

export interface Logger {
  info(message: string, ctx?: Record<string, unknown>): void;
  warn(message: string, ctx?: Record<string, unknown>): void;
  error(message: string, ctx?: Record<string, unknown>): void;
  debug(message: string, ctx?: Record<string, unknown>): void;
}
