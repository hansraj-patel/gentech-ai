import type { GenTechError } from "./types.js";

/** Throwable carrying the uniform shared-contract Error shape (§7). */
export class ContractError extends Error implements GenTechError {
  readonly code: string;
  readonly module: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(e: GenTechError) {
    super(e.message);
    this.name = "ContractError";
    this.code = e.code;
    this.module = e.module;
    this.retryable = e.retryable;
    this.details = e.details;
  }

  toJSON(): GenTechError {
    return {
      code: this.code,
      module: this.module,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}
