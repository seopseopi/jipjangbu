import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PerspectiveCamera, Vector3 } from "three";
import {
  overheadFrame,
  recommendedView,
} from "../app/structures/overhead-frame.ts";
import { transformPoint } from "../app/structures/plan.ts";
const models = JSON.parse(
  readFileSync(
    new URL("../app/structures/prepared-plans.json", import.meta.url),
  ),
);
models.push(...JSON.parse(readFileSync(new URL("../app/structures/prepared-extra-plans.json", import.meta.url))));
test("수직 2D는 회전·반전과 세로 화면에서도 외곽 전체를 자르지 않는다", () => {
  for (const { plan } of models)
    for (const [width, height] of [
      [1600, 900],
      [390, 700],
      [900, 320],
    ])
      for (const rotation of [0, 90, 180, 270])
        for (const mirror of [false, true]) {
          const transform = { rotation, mirror },
            frame = overheadFrame(plan, transform, width, height),
            [px, py] = plan.coordinateSystem.pivot;
          for (const p of plan.outline) {
            const [x, y] = transformPoint(p, [px, py], transform);
            assert.ok(Math.abs(x - px - frame.x) * frame.zoom < width / 2);
            assert.ok(Math.abs(py - y - frame.z) * frame.zoom < height / 2);
          }
        }
});
test("추천 3D 시점은 모든 타입의 바닥과 벽 꼭대기를 가로·세로 화면에 맞춘다", () => {
  for (const { plan } of models)
    for (const [width, height] of [
      [1600, 900],
      [390, 700],
      [900, 320],
    ])
      for (const rotation of [0, 90, 180, 270])
        for (const mirror of [false, true]) {
          const transform = { rotation, mirror },
            view = recommendedView(plan, transform, width, height),
            [px, py] = plan.coordinateSystem.pivot;
          const camera = new PerspectiveCamera(42, width / height, 0.1, 200);
          camera.position
            .set(...view.target)
            .addScaledVector(new Vector3(...view.direction), view.distance);
          camera.lookAt(new Vector3(...view.target));
          camera.updateMatrixWorld();
          for (const p of plan.outline)
            for (const h of [0, Math.max(...plan.walls.map((w) => w.height))]) {
              const [x, y] = transformPoint(p, [px, py], transform),
                screen = new Vector3(x - px, h, py - y).project(camera);
              assert.ok(
                Math.abs(screen.x) < 1 &&
                  Math.abs(screen.y) < 1 &&
                  screen.z < 1,
                `${width}x${height}: ${screen.toArray()}`,
              );
            }
        }
});
