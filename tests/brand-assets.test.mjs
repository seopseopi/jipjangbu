import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import test from "node:test";

const read = (path, encoding) => readFileSync(new URL(`../${path}`, import.meta.url), encoding);

// The existing logo generator emits non-interlaced, 8-bit RGBA PNGs. Decode
// their scanline filters so CI checks the shipped pixels without Pillow or a browser.
function rgbaPng(path, expectedSize) {
  const png = read(path);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), expectedSize);
  assert.equal(png.readUInt32BE(20), expectedSize);
  assert.deepEqual([...png.subarray(24, 29)], [8, 6, 0, 0, 0]);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = expectedSize * 4;
  assert.equal(raw.length, expectedSize * (stride + 1));
  const pixels = Buffer.alloc(expectedSize * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < expectedSize; y++) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= 4 ? pixels[i - 4] : 0, b = y ? pixels[i - stride] : 0, c = y && x >= 4 ? pixels[i - stride - 4] : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      pixels[i] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  return (x, y) => [...pixels.subarray((y * expectedSize + x) * 4, (y * expectedSize + x) * 4 + 4)];
}

test("SVG·앱 로고는 같은 집과 장부의 단색 도형을 사용한다", () => {
  const mark = read("docs/assets/jipjangbu-mark.svg", "utf8");
  const tile = read("docs/assets/jipjangbu-mark-tile.svg", "utf8");
  const component = read("app/brand-mark.tsx", "utf8");
  assert.match(mark, /fill="#2c394b" fill-rule="evenodd"/);
  assert.match(mark, /stroke="#2c394b"/);
  assert.match(mark, /집과 열린 장부/);
  assert.match(tile, /<rect[^>]*fill="#ffffff"[^>]*stroke="#d8dde6"/);
  assert(tile.indexOf("<rect") < tile.indexOf("<path"));
  assert.equal(read("public/favicon.svg", "utf8"), tile);
  for (const [, data] of component.matchAll(/\sd="([^"]+)"/g)) {
    assert.ok(mark.includes(`d="${data}"`), "exported geometry follows the actual React mark");
    assert.ok(tile.includes(`d="${data}"`));
  }
  assert.match(read("app/work-manager.tsx", "utf8"), /<BrandMark\s*\/>/);
  assert.match(read("app/login/page.tsx", "utf8"), /<BrandMark/);
  assert.match(read("README.md", "utf8"), /<img src="docs\/assets\/jipjangbu-mark-tile\.svg"/);
});

test("PNG 아이콘은 밝은 타일 위의 집과 열린 장부를 작은 크기에서도 구분한다", () => {
  const navy = [44, 57, 75, 255], white = [255, 255, 255, 255];
  for (const [name, size] of [["jipjangbu-icon-bright.png", 192], ["jipjangbu-icon.png", 96]]) {
    const pixel = rgbaPng(`public/${name}`, size);
    const at = (x, y) => pixel(Math.round(size * x), Math.round(size * y));
    assert.deepEqual(at(0.5, 0.16), white, "bright opaque background above the house");
    assert.deepEqual(at(0.5, 0.35), navy, "solid single-color house silhouette");
    assert.deepEqual(at(0.41, 0.56), white, "the open ledger is negative space inside the house");
    const spine = at(0.5, 0.56);
    assert.ok(spine[0] < 70 && spine[1] < 85 && spine[2] < 105 && spine[2] > spine[0] && spine[3] === 255, "the dark spine separates both ledger pages despite small-size antialiasing");
    assert.deepEqual(at(0.5, 0.85), white, "light background below the mark");
  }
  const layout = read("app/layout.tsx", "utf8");
  assert.equal((layout.match(/\/jipjangbu-icon-bright\.png\?v=20261031-renewal/g) ?? []).length, 3);
  assert.match(read("app/renewal.css", "utf8"), /\.brand-mark\s*\{[^}]*background: none;[^}]*color: #2c394b/);
});

test("호환 로고 PNG는 배경과 장부 안쪽을 투명하게 유지한다", () => {
  const size = 512, pixel = rgbaPng("public/jipjangbu-logo.png", size);
  assert.equal(pixel(0, 0)[3], 0);
  assert.deepEqual(pixel(256, 112), [44, 57, 75, 255]);
  assert.equal(pixel(Math.round(size * 0.36), Math.round(size * 0.58))[3], 0);
  assert.deepEqual(pixel(256, Math.round(size * 0.58)), [44, 57, 75, 255]);
});
