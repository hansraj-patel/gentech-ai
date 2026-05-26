import { describe, it, expect } from "vitest";
import {
  assertAcyclic,
  assertModelsResolvable,
  validatePipelineSpec,
  ContractError,
  type PipelineSpec,
} from "../dist/index.js";

const baseNode = (nodeId: string, modelId = "yolo-n") => ({
  nodeId,
  task: "object_detection",
  modelId,
  params: {},
  compute: { gpuClass: "small" as const, minVramGb: 2, estDurationSec: 1, priority: 5 },
  parallelizable: true,
});

const spec = (over: Partial<PipelineSpec> = {}): PipelineSpec => ({
  pipelineId: "pipe_1",
  queryId: "query_1",
  tenantId: "ten_1",
  nodes: [baseNode("a"), baseNode("b")],
  edges: [{ from: "a", to: "b" }],
  retryPolicy: { maxRetries: 2, backoff: "exponential", deadLetter: true },
  ...over,
});

describe("assertAcyclic", () => {
  it("accepts a linear chain", () => {
    expect(() => assertAcyclic([{ nodeId: "a" }, { nodeId: "b" }], [{ from: "a", to: "b" }])).not.toThrow();
  });
  it("throws DAG_CYCLIC on a cycle", () => {
    try {
      assertAcyclic([{ nodeId: "a" }, { nodeId: "b" }], [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
      expect.fail("expected throw");
    } catch (e) {
      expect((e as ContractError).code).toBe("DAG_CYCLIC");
    }
  });
  it("throws on a dangling edge", () => {
    try {
      assertAcyclic([{ nodeId: "a" }], [{ from: "a", to: "ghost" }]);
      expect.fail("expected throw");
    } catch (e) {
      expect((e as ContractError).code).toBe("DAG_DANGLING_EDGE");
    }
  });
});

describe("assertModelsResolvable", () => {
  it("passes when every modelId is known", () => {
    expect(() => assertModelsResolvable(spec(), new Set(["yolo-n"]))).not.toThrow();
  });
  it("throws MODEL_NOT_FOUND otherwise", () => {
    try {
      assertModelsResolvable(spec(), new Set(["other"]));
      expect.fail("expected throw");
    } catch (e) {
      expect((e as ContractError).code).toBe("MODEL_NOT_FOUND");
    }
  });
});

describe("validatePipelineSpec", () => {
  it("accepts a valid spec", () => {
    expect(validatePipelineSpec(spec(), new Set(["yolo-n"])).pipelineId).toBe("pipe_1");
  });
  it("rejects a schema-invalid spec", () => {
    expect(() => validatePipelineSpec({ pipelineId: "pipe_1" })).toThrow(ContractError);
  });
});
