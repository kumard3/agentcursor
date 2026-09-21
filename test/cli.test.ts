import { describe, expect, it } from "vitest";
import { parseArgs, type ToolInfo } from "../src/cli/run";

const tool = (properties: ToolInfo["inputSchema"]["properties"]): ToolInfo => ({
  name: "t",
  inputSchema: { properties },
});

const readPage = tool({ maxElements: { type: "number" }, includeText: { type: "boolean" } });
const click = tool({ ref: { type: "string" }, x: { type: "number" }, y: { type: "number" } });

describe("cli parseArgs", () => {
  it("fills positionals in schema order", () => {
    expect(parseArgs(click, ["e12"])).toEqual({ ref: "e12" });
    expect(parseArgs(readPage, ["40"])).toEqual({ maxElements: 40 });
  });

  it("takes flags with a value, =value, and bare booleans", () => {
    expect(parseArgs(readPage, ["--maxElements", "10"])).toEqual({ maxElements: 10 });
    expect(parseArgs(readPage, ["--maxElements=10"])).toEqual({ maxElements: 10 });
    expect(parseArgs(readPage, ["--includeText"])).toEqual({ includeText: true });
  });

  it("reads `--flag false` as false, not as a positional", () => {
    expect(parseArgs(readPage, ["--includeText", "false"])).toEqual({ includeText: false });
    expect(parseArgs(readPage, ["--includeText=false"])).toEqual({ includeText: false });
  });

  it("skips parameters already given as flags", () => {
    expect(parseArgs(click, ["--ref", "e3", "5", "9"])).toEqual({ ref: "e3", x: 5, y: 9 });
  });

  it("rejects a non-number and too many arguments", () => {
    expect(() => parseArgs(readPage, ["abc"])).toThrow(/not a number/);
    expect(() => parseArgs(click, ["e1", "1", "2", "3"])).toThrow(/too many arguments/);
  });
});
