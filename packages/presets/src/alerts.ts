/**
 * Event-driven alerting (module 07, FR-5). An `AlertRule` evaluates a windowed
 * metric against a threshold; when the comparison crosses, it produces an
 * `alert.raised` payload shaped as a `ResultEvent` (kind `summary` or `match`)
 * so module 08 can render it on the Alerts screen and module 04's result stream
 * stays the single result type.
 *
 * Owned local type: `AlertRule`. zod is the single source of truth (house style).
 */
import { z } from "zod";
import { makeId, ResultEventSchema, type ResultEvent } from "@gentech/contracts";

export const AlertOp = z.enum([">", ">=", "<", "<=", "=="]);
export type AlertOp = z.infer<typeof AlertOp>;

export const AlertRuleSchema = z.object({
  ruleId: z.string().min(1),
  /** The windowed metric this rule watches (e.g. "count", "rate", "matches"). */
  metric: z.string().min(1),
  op: AlertOp,
  threshold: z.number(),
  /** The aggregation window (seconds) this rule is evaluated over. */
  windowSec: z.number().int().positive(),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

/** The payload carried inside an `alert.raised` ResultEvent. */
export interface AlertRaised {
  ruleId: string;
  metric: string;
  op: AlertOp;
  threshold: number;
  /** The observed windowed value that triggered the rule. */
  value: number;
  windowSec: number;
  /** Window the value was measured over (seconds, on the driving clock). */
  windowStartSec: number;
  windowEndSec: number;
}

/** Pure threshold comparison — true when `value <op> threshold` holds. */
export function evaluate(rule: AlertRule, value: number): boolean {
  switch (rule.op) {
    case ">":
      return value > rule.threshold;
    case ">=":
      return value >= rule.threshold;
    case "<":
      return value < rule.threshold;
    case "<=":
      return value <= rule.threshold;
    case "==":
      return value === rule.threshold;
  }
}

export interface RaiseAlertInput {
  rule: AlertRule;
  value: number;
  jobId: string;
  tenantId: string;
  windowStartSec: number;
  windowEndSec: number;
  /** Wall-clock timestamp (RFC-3339) for the result event. */
  ts: string;
}

/**
 * Build an `alert.raised` ResultEvent for a crossed rule. Kind is `match` when
 * the rule watches matches (e.g. ANPR watchlist hits), else `summary` (FR-5).
 */
export function raiseAlert(input: RaiseAlertInput): ResultEvent {
  const { rule, value } = input;
  const payload: AlertRaised = {
    ruleId: rule.ruleId,
    metric: rule.metric,
    op: rule.op,
    threshold: rule.threshold,
    value,
    windowSec: rule.windowSec,
    windowStartSec: input.windowStartSec,
    windowEndSec: input.windowEndSec,
  };
  return ResultEventSchema.parse({
    resultId: makeId("ResultId"),
    jobId: input.jobId,
    tenantId: input.tenantId,
    kind: rule.metric === "matches" ? "match" : "summary",
    partial: false,
    payload,
    ts: input.ts,
  });
}
