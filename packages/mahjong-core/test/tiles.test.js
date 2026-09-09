import test from "node:test";
import assert from "node:assert/strict";
import { parseTilesText } from "../src/index.js";

test("parses mixed notations into tile ids", () => {
  assert.deepEqual(parseTilesText("wan1 5wan 万3 4条 条5 筒6 饼7"), [
    "wan-1",
    "wan-5",
    "wan-3",
    "tiao-4",
    "tiao-5",
    "tong-6",
    "tong-7",
  ]);
});

test("parses honor tiles in chinese pinyin and english", () => {
  assert.deepEqual(parseTilesText("东南西北中发白"), [
    "east",
    "south",
    "west",
    "north",
    "zhong",
    "fa",
    "bai",
  ]);
  assert.deepEqual(parseTilesText("dong NAN xi beI zhong FA bai"), [
    "east",
    "south",
    "west",
    "north",
    "zhong",
    "fa",
    "bai",
  ]);
  assert.deepEqual(parseTilesText("east south west north"), [
    "east",
    "south",
    "west",
    "north",
  ]);
});

test("parses multi-digit runs and full ids with separators", () => {
  assert.deepEqual(parseTilesText("万123"), ["wan-1", "wan-2", "wan-3"]);
  assert.deepEqual(parseTilesText("123wan"), ["wan-1", "wan-2", "wan-3"]);
  assert.deepEqual(parseTilesText("wan-1, tiao-5；tong-9、FA"), [
    "wan-1",
    "tiao-5",
    "tong-9",
    "fa",
  ]);
});

test("parses repeat suffixes", () => {
  assert.deepEqual(parseTilesText("东x3 wan1*2 条5×4"), [
    "east",
    "east",
    "east",
    "wan-1",
    "wan-1",
    "tiao-5",
    "tiao-5",
    "tiao-5",
    "tiao-5",
  ]);
  assert.deepEqual(parseTilesText("wan123x2"), [
    "wan-1",
    "wan-1",
    "wan-2",
    "wan-2",
    "wan-3",
    "wan-3",
  ]);
});

test("returns an empty array for blank text", () => {
  assert.deepEqual(parseTilesText(""), []);
  assert.deepEqual(parseTilesText("   \n\t，、 "), []);
});

test("rejects invalid tile text", () => {
  assert.throws(() => parseTilesText("wan0"), /无法识别的牌/);
  assert.throws(() => parseTilesText("banana"), /无法识别的牌/);
  assert.throws(() => parseTilesText("万10"), /无法识别的牌/);
  assert.throws(() => parseTilesText("东x5"), /重复张数/);
  assert.throws(() => parseTilesText(123), /字符串/);
});
