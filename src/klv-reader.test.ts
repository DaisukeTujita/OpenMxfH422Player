import { describe, expect, it } from "vitest";
import { readKlvHeader, readKlvValue } from "./klv-reader";
import { FileRandomAccessReader } from "./random-access-reader";
const key=Uint8Array.from({length:16},(_,i)=>i), reader=(data:Uint8Array)=>new FileRandomAccessReader(new Blob([data]),{chunkSize:4,maxReadSize:64});
describe("reader KLV",()=>{
  it("reads short form across key and value chunk boundaries",async()=>{const data=new Uint8Array([...key,5,1,2,3,4,5]);const h=await readKlvHeader(reader(data),0n);expect(h).toMatchObject({valueOffset:17n,valueLength:5n,nextOffset:22n});expect(await readKlvValue(reader(data),h)).toEqual(new Uint8Array([1,2,3,4,5]));});
  it("reads long form BER across a boundary",async()=>{const value=new Uint8Array(128);const data=new Uint8Array([...key,0x81,0x80,...value]);expect((await readKlvHeader(reader(data),0n)).valueLength).toBe(128n);});
  it("rejects malformed, truncated, out-of-range, and huge materialization",async()=>{await expect(readKlvHeader(reader(new Uint8Array([...key,0x80])),0n)).rejects.toThrow(/Invalid/);await expect(readKlvHeader(reader(new Uint8Array([...key,5,1])),0n)).rejects.toThrow(/range/);const data=new Uint8Array([...key,0x81,0x80,...new Uint8Array(128)]);const h=await readKlvHeader(reader(data),0n);await expect(readKlvValue(reader(data),h,64)).rejects.toThrow(/too large/);});
});
