/**
 * parking_lot_daytime — the canonical "how many white cars" demo.
 * Ground truth holds 4 white cars (and decoys: other colors, plus white *trucks*
 * that must NOT be counted as white cars). A correct count query returns 4.
 */
export const parkingLotDaytime = {
  scenarioId: "parking_lot_daytime",
  name: "Parking lot, daytime",
  segmentCount: 8,
  sources: [{ sourceId: "src_lot_cam", profile: "1080p_30fps" }],
  groundTruth: {
    objects: [
      // 4 white cars (the intended answer) ──────────────────────────────
      { id: "car_w1", label: "car", atSegment: 0, attrs: { color: "white", type: "sedan" } },
      { id: "car_w2", label: "car", atSegment: 1, attrs: { color: "white", type: "suv" } },
      { id: "car_w3", label: "car", atSegment: 3, attrs: { color: "white", type: "sedan" } },
      { id: "car_w4", label: "car", atSegment: 6, attrs: { color: "white", type: "hatchback" } },
      // other-color cars (decoys) ───────────────────────────────────────
      { id: "car_k1", label: "car", atSegment: 0, attrs: { color: "black", type: "sedan" } },
      { id: "car_k2", label: "car", atSegment: 2, attrs: { color: "black", type: "suv" } },
      { id: "car_k3", label: "car", atSegment: 5, attrs: { color: "black", type: "sedan" } },
      { id: "car_r1", label: "car", atSegment: 1, attrs: { color: "red", type: "coupe" } },
      { id: "car_r2", label: "car", atSegment: 4, attrs: { color: "red", type: "sedan" } },
      { id: "car_s1", label: "car", atSegment: 7, attrs: { color: "silver", type: "suv" } },
      // white *trucks* — must be excluded from a "white car" count ───────
      { id: "trk_w1", label: "truck", atSegment: 2, attrs: { color: "white" } },
      { id: "trk_w2", label: "truck", atSegment: 5, attrs: { color: "white" } },
      // a pedestrian for good measure
      { id: "ped_1", label: "person", atSegment: 3, attrs: {} },
    ],
    tracks: [
      { trackId: "trk_car_w1", label: "car", segments: [0, 1, 2] },
      { trackId: "trk_ped_1", label: "person", segments: [3, 4] },
    ],
    anpr: [
      { plate: "WHT-001", atSegment: 0 },
      { plate: "BLK-220", atSegment: 2 },
    ],
    events: [],
    nsfwScore: 0.01,
  },
  infra: {
    gpuTotals: { none: 999, small: 4, medium: 2, large: 1 },
    loadProfile: "steady",
  },
} as const;
