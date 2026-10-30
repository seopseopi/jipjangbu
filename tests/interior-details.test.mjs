import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { reviewedInterior } from "../app/structures/interior-details.ts";
const plans = JSON.parse(
  readFileSync(
    new URL("../app/structures/prepared-plans.json", import.meta.url),
  ),
);
plans.push(...JSON.parse(readFileSync(new URL("../app/structures/prepared-extra-plans.json", import.meta.url))));
test("운영 40개 타입의 정확한 벽·방·개구부 형상에만 검토한 설비를 표시한다", () => {
  for (const { plan } of plans) {
    const interior = reviewedInterior(plan);
    assert.ok(interior);
    assert.ok(interior.fixtures.some((f) => f.kind === "toilet"));
    assert.ok(interior.fixtures.some((f) => f.kind === "basin"));
    assert.equal(interior.fixtures.filter((f) => f.kind === "sink").length, 1);
    assert.ok(
      interior.fixtures.every(
        (f) =>
          plan.rooms.some((r) => r.id === f.roomId) &&
          f.width > 0 &&
          f.depth > 0,
      ),
    );
    const renamed = structuredClone(plan);
    renamed.rooms[0].id = "changed-room-id";
    assert.equal(reviewedInterior(renamed), null);
    const changed = structuredClone(plan);
    changed.walls[0].end[0] += 0.05;
    assert.equal(reviewedInterior(changed), null);
    assert.equal(reviewedInterior({ ...plan, isDemo: true }), null);
    assert.equal(reviewedInterior({ ...plan, referenceOnly: true }), null);
  }
});
test("욕조가 없는 원본 욕실에 임의로 욕조를 추가하지 않는다", () => {
  for (const id of ["21414", "14491"])
    assert.equal(
      reviewedInterior(plans.find((p) => p.typeId === id).plan).fixtures.filter(
        (f) => f.kind === "tub",
      ).length,
      1,
    );
});
