import { describe,expect,it } from "vitest";
import { parseMxfMetadata } from "./mxf-metadata";
import { parseMxfMetadataFromReader } from "./mxf-reader";
import { FileRandomAccessReader } from "./random-access-reader";
import type { RandomAccessReader } from "./random-access-reader";
const key=(tail:number)=>new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x53,0x01,0x01,0x0d,0x01,0x02,0x01,0x01,0x01,0x01,tail]);
const field=(tag:number,value:number[])=>[tag>>8,tag&255,value.length,...value];
const klv=(key:Uint8Array,value:number[])=>new Uint8Array([...key,value.length,...value]);
describe("MXF reader metadata",()=>{
  it("matches the synchronous parser and skips a large essence value",async()=>{const metadata=klv(key(1),field(0x3203,[0,0,7,128]));const essenceKey=new Uint8Array([0x06,0x0e,0x2b,0x34,1,2,1,1,0x0d,1,3,1,0x15,1,1,1]);const essence=klv(essenceKey,new Array(100).fill(7));const data=new Uint8Array([...metadata,...essence]);const reader=new FileRandomAccessReader(new Blob([data]),{chunkSize:16,maxReadSize:256});const parsed=await parseMxfMetadataFromReader(reader);expect(parsed.mediaInfo).toEqual(parseMxfMetadata(data).mediaInfo);expect(reader.getStats().bytesLoaded).toBeLessThan(BigInt(data.length));expect(parsed.usedRandomIndexPack).toBe(false);});
  it("tolerates no timecode and a corrupt index",async()=>{const corrupt=klv(new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x53,1,1,0x0d,1,2,1,1,0x10,1,0]),[0x3f,0x0b,20,1]);const parsed=await parseMxfMetadataFromReader(reader(corrupt));expect(parsed.timecodes).toEqual([]);expect(parsed.indexTables).toEqual([]);});
  it("uses RIP partition offsets when a valid pack is present",async()=>{const partitionKey=new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,1,1,0x0d,1,2,1,1,2,1,0]);const pack=klv(partitionKey,new Array(80).fill(0));const ripKey=new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,1,1,0x0d,1,2,1,1,0x11,1,0]);const ripValue=[0,0,0,1,...new Array(8).fill(0),0,0,0,33];const rip=klv(ripKey,ripValue);const parsed=await parseMxfMetadataFromReader(reader(new Uint8Array([...pack,...rip])));expect(parsed.usedRandomIndexPack).toBe(true);expect(parsed.partitions).toMatchObject([{offset:0n,kind:"header",bodySid:0,indexSid:0}]);});
});
function reader(data:Uint8Array){return new FileRandomAccessReader(new Blob([data]),{chunkSize:8,maxReadSize:128});}

const concat=(...parts:Uint8Array[])=>{const output=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const part of parts){output.set(part,at);at+=part.length;}return output;};
const be32=(value:number)=>new Uint8Array([value>>>24,value>>>16,value>>>8,value]);
const be64=(value:bigint)=>{const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,value);return bytes;};
const localField=(tag:number,value:Uint8Array)=>concat(new Uint8Array([tag>>>8,tag,value.length]),value);
const makeKlv=(key:Uint8Array,value:Uint8Array)=>concat(key,new Uint8Array([value.length]),value);
const partitionPack=(kind:number,headerCount:bigint,indexCount:bigint)=>{const value=new Uint8Array(80),view=new DataView(value.buffer);view.setBigUint64(32,headerCount);view.setBigUint64(40,indexCount);return makeKlv(new Uint8Array([6,14,43,52,2,5,1,1,13,1,2,1,1,kind,1,0]),value);};
const op1aPartitionPack=(headerCount:bigint)=>{const pack=partitionPack(2,headerCount,0n),valueOffset=17;pack.set(new Uint8Array([6,14,43,52,4,1,1,1,13,1,2,1,1,1,1,0]),valueOffset+64);return pack;};

class SparseReader implements RandomAccessReader {
  readonly requests:Array<{offset:bigint;length:number}>=[];bytesLoaded=0n;largestRead=0;
  constructor(readonly size:bigint,private regions:Array<{offset:bigint;data:Uint8Array}>){ }
  async read(offset:bigint,length:number):Promise<Uint8Array>{this.requests.push({offset,length});this.bytesLoaded+=BigInt(length);this.largestRead=Math.max(this.largestRead,length);const output=new Uint8Array(length);for(const region of this.regions){const start=offset>region.offset?offset:region.offset,end=offset+BigInt(length)<region.offset+BigInt(region.data.length)?offset+BigInt(length):region.offset+BigInt(region.data.length);if(start<end)output.set(region.data.subarray(Number(start-region.offset),Number(end-region.offset)),Number(start-offset));}return output;}
}

describe("RIP-directed sparse MXF parsing",()=>{
  it("reads only partition metadata/index areas in a virtual long-form file",async()=>{
    const size=100n*1024n*1024n*1024n,headerOffset=0n,bodyOffset=1024n*1024n*1024n,indexOffset=80n*1024n*1024n*1024n,footerOffset=size-1024n*1024n;
    const metadata=makeKlv(key(1),localField(0x3203,be32(1920)));
    const indexKey=new Uint8Array([6,14,43,52,2,83,1,1,13,1,2,1,1,16,1,0]);
    const index=makeKlv(indexKey,concat(localField(0x3f0b,concat(be32(30000),be32(1001))),localField(0x3f0c,be64(0n)),localField(0x3f0d,be64(1n))));
    const headerPack=partitionPack(2,BigInt(metadata.length),0n),bodyPack=partitionPack(3,0n,0n),indexPack=partitionPack(3,0n,BigInt(index.length)),footerPack=partitionPack(4,BigInt(metadata.length),0n);
    const offsets=[headerOffset,bodyOffset,indexOffset,footerOffset],ripValue=concat(...offsets.map(offset=>concat(be32(1),be64(offset))),be32(16+1+offsets.length*12+4));
    const rip=makeKlv(new Uint8Array([6,14,43,52,2,5,1,1,13,1,2,1,1,17,1,0]),ripValue),ripOffset=size-BigInt(rip.length);
    const sparse=new SparseReader(size,[{offset:headerOffset,data:headerPack},{offset:BigInt(headerPack.length),data:metadata},{offset:bodyOffset,data:bodyPack},{offset:indexOffset,data:indexPack},{offset:indexOffset+BigInt(indexPack.length),data:index},{offset:footerOffset,data:footerPack},{offset:footerOffset+BigInt(footerPack.length),data:metadata},{offset:ripOffset,data:rip}]);
    const parsed=await parseMxfMetadataFromReader(sparse);
    expect(parsed.usedRandomIndexPack).toBe(true);expect(parsed.partitions.map(p=>p.kind)).toEqual(["header","body","body","footer"]);expect(parsed.mediaInfo.video?.width).toBe(1920);expect(parsed.indexTables).toHaveLength(1);
    expect(sparse.bytesLoaded).toBeLessThan(2048n);expect(sparse.bytesLoaded*1_000_000n).toBeLessThan(size);expect(sparse.largestRead).toBeLessThanOrEqual(4*1024*1024);
    expect(sparse.requests.every(request=>request.offset===size-4n||[ripOffset,...offsets].some(base=>request.offset>=base&&request.offset<base+512n))).toBe(true);
    expect(sparse.requests.some(request=>request.offset>bodyOffset+BigInt(bodyPack.length)&&request.offset<indexOffset)).toBe(false);
  });

  it("parses a bounded descriptor KLV that starts inside and crosses the declared header range",async()=>{
    const essenceContainer=new Uint8Array([6,14,43,52,4,1,1,1,13,1,3,1,2,4,96,1]);
    const metadata=makeKlv(key(1),concat(localField(0x3203,be32(1920)),localField(0x3202,be32(1080)),localField(0x3004,essenceContainer)));
    const headerPack=op1aPartitionPack(5n);
    const ripValue=concat(be32(1),be64(0n),be32(33));
    const rip=makeKlv(new Uint8Array([6,14,43,52,2,5,1,1,13,1,2,1,1,17,1,0]),ripValue);
    const parsed=await parseMxfMetadataFromReader(reader(concat(headerPack,metadata,rip)));
    expect(parsed.usedRandomIndexPack).toBe(true);
    expect(parsed.partitions).toHaveLength(1);
    expect(parsed.mediaInfo).toMatchObject({
      operationalPattern:"OP1a",
      essenceContainer:"060e2b34040101010d01030102046001",
      video:{width:1920,height:1080},
    });
    expect(Boolean(parsed.mediaInfo.video?.width&&parsed.mediaInfo.video.height&&parsed.mediaInfo.essenceContainer)).toBe(true);
  });
});

describe("MXF run-in discovery",()=>{
  it("does not mistake a KLV-like run-in prefix for the first Partition Pack",async()=>{
    const misleading=makeKlv(key(1),new Uint8Array([1,2,3]));
    const padding=new Uint8Array(64).fill(0x55),pack=op1aPartitionPack(0n);
    const parsed=await parseMxfMetadataFromReader(runInReader(concat(misleading,padding,pack)));
    expect(parsed.partitions).toMatchObject([{offset:BigInt(misleading.length+padding.length),kind:"header"}]);
    expect(parsed.mediaInfo.operationalPattern).toBe("OP1a");
  });

  it("finds an OP1a Header Partition after run-in and parses metadata without a Timecode Track",async()=>{
    const metadata=makeKlv(key(1),localField(0x3203,be32(1920)));
    const runIn=new Uint8Array(4096).fill(0x55),pack=op1aPartitionPack(BigInt(metadata.length));
    const source=runInReader(concat(runIn,pack,metadata)),parsed=await parseMxfMetadataFromReader(source);

    expect(parsed.partitions).toMatchObject([{offset:4096n,kind:"header"}]);
    expect(parsed.mediaInfo.operationalPattern).toBe("OP1a");
    expect(parsed.mediaInfo.video?.width).toBe(1920);
    expect(parsed.timecodes).toEqual([]);
    expect(parsed.usedRandomIndexPack).toBe(false);
    expect(source.getStats().largestUnderlyingRead).toBeLessThanOrEqual(4096);
  });

  it("accepts a vendor prologue just beyond the standard run-in boundary",async()=>{
    const runIn=new Uint8Array(65536).fill(0x55),pack=op1aPartitionPack(0n);
    const parsed=await parseMxfMetadataFromReader(runInReader(concat(runIn,pack)));
    expect(parsed.partitions).toMatchObject([{offset:65536n,kind:"header"}]);
    expect(parsed.mediaInfo.operationalPattern).toBe("OP1a");
  });

  it("does not scan beyond the bounded compatibility prologue",async()=>{
    const runIn=new Uint8Array(4*1024*1024+1).fill(0x55),pack=op1aPartitionPack(0n);
    const parsed=await parseMxfMetadataFromReader(runInReader(concat(runIn,pack)));
    expect(parsed.partitions).toEqual([]);
    expect(parsed.mediaInfo.operationalPattern).toBeUndefined();
  });

  it("accepts a Header Partition at the maximum permitted run-in boundary",async()=>{
    const runIn=new Uint8Array(65535).fill(0x55),pack=op1aPartitionPack(0n);
    const parsed=await parseMxfMetadataFromReader(runInReader(concat(runIn,pack)));
    expect(parsed.partitions).toMatchObject([{offset:65535n,kind:"header"}]);
    expect(parsed.mediaInfo.operationalPattern).toBe("OP1a");
  });
});

function runInReader(data:Uint8Array){return new FileRandomAccessReader(new Blob([data]),{chunkSize:4096,maxReadSize:128*1024});}
