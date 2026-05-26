/**
 * gate_intrusion_night — a plate-search + alerting scenario under GPU scarcity.
 * Target plate "ABC-1234" appears at segment 4; an intrusion event fires on the
 * simulated clock so monitors/alerts (module 07) have something to trip on.
 */
export const gateIntrusionNight = {
  scenarioId: "gate_intrusion_night",
  name: "Gate intrusion, night",
  segmentCount: 6,
  sources: [{ sourceId: "src_gate_cam", profile: "720p_15fps_ir" }],
  groundTruth: {
    objects: [
      { id: "veh_1", label: "car", atSegment: 4, attrs: { color: "dark" } },
      { id: "ped_1", label: "person", atSegment: 2, attrs: {} },
      { id: "ped_2", label: "person", atSegment: 3, attrs: {} },
    ],
    tracks: [{ trackId: "trk_veh_1", label: "car", segments: [3, 4, 5] }],
    anpr: [
      { plate: "ABC-1234", atSegment: 4 },
      { plate: "ZZ-0009", atSegment: 1 },
    ],
    events: [
      { kind: "intrusion", atTime: 30 },
      { kind: "loitering", atTime: 55 },
    ],
    nsfwScore: 0.02,
  },
  infra: {
    gpuTotals: { none: 999, small: 2, medium: 1, large: 0 },
    loadProfile: "scarce",
  },
} as const;
