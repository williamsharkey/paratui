import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { imageBufferToAscii } from "../src/ascii.js";

test("ascii renderer doubles horizontal character output while staying within target width", async () => {
  const buffer = await sharp(Buffer.from([0, 255]), {
    raw: {
      width: 2,
      height: 1,
      channels: 1
    }
  })
    .png()
    .toBuffer();

  const ascii = await imageBufferToAscii(buffer, 4, 1);
  const [line] = ascii.split("\n");
  assert.equal(line?.length, 4);
  assert.equal(line?.[0], line?.[1]);
  assert.equal(line?.[2], line?.[3]);
  assert.notEqual(line?.slice(0, 2), line?.slice(2, 4));
});
