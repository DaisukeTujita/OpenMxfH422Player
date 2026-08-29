import { describe,expect,it } from "vitest";
import { readBer } from "./mxf";
describe("readBer",()=>{it("reads short form",()=>expect(readBer(new Uint8Array([127]),0)).toEqual({value:127,bytes:1}));it("reads long form",()=>expect(readBer(new Uint8Array([0x82,1,0]),0)).toEqual({value:256,bytes:3}));it("rejects indefinite lengths",()=>expect(()=>readBer(new Uint8Array([0x80]),0)).toThrow());});
