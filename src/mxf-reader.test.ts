import { describe,expect,it } from "vitest";
import { parseMxfMetadata } from "./mxf-metadata";
import { parseMxfMetadataFromReader } from "./mxf-reader";
import { FileRandomAccessReader } from "./random-access-reader";
const key=(tail:number)=>new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x02,0x01,0x01,0x01,0x01,tail]);
const field=(tag:number,value:number[])=>[tag>>8,tag&255,value.length,...value];
const klv=(key:Uint8Array,value:number[])=>new Uint8Array([...key,value.length,...value]);
describe("MXF reader metadata",()=>{
  it("matches the synchronous parser and skips a large essence value",async()=>{const metadata=klv(key(1),field(0x3203,[0,0,7,128]));const essenceKey=new Uint8Array([0x06,0x0e,0x2b,0x34,1,2,1,1,0x0d,1,3,1,0x15,1,1,1]);const essence=klv(essenceKey,new Array(100).fill(7));const data=new Uint8Array([...metadata,...essence]);const reader=new FileRandomAccessReader(new Blob([data]),{chunkSize:16,maxReadSize:256});const parsed=await parseMxfMetadataFromReader(reader);expect(parsed.mediaInfo).toEqual(parseMxfMetadata(data).mediaInfo);expect(reader.getStats().bytesLoaded).toBeLessThan(BigInt(data.length));expect(parsed.usedRandomIndexPack).toBe(false);});
  it("tolerates no timecode and a corrupt index",async()=>{const corrupt=klv(new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x53,1,1,0x0d,1,2,1,1,0x10,1,0]),[0x3f,0x0b,20,1]);const parsed=await parseMxfMetadataFromReader(reader(corrupt));expect(parsed.timecodes).toEqual([]);expect(parsed.indexTables).toEqual([]);});
  it("uses RIP partition offsets when a valid pack is present",async()=>{const partitionKey=new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,1,1,0x0d,1,2,1,1,2,1,0]);const pack=klv(partitionKey,new Array(80).fill(0));const ripKey=new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,1,1,0x0d,1,2,1,1,0x11,1,0]);const ripValue=[0,0,0,1,...new Array(8).fill(0),0,0,0,33];const rip=klv(ripKey,ripValue);const parsed=await parseMxfMetadataFromReader(reader(new Uint8Array([...pack,...rip])));expect(parsed.usedRandomIndexPack).toBe(true);expect(parsed.partitions).toMatchObject([{offset:0n,kind:"header",bodySid:0,indexSid:0}]);});
});
function reader(data:Uint8Array){return new FileRandomAccessReader(new Blob([data]),{chunkSize:8,maxReadSize:128});}
