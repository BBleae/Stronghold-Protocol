// The stored/hash-checked payload is base64(gzip(UTF-8 bytes)), never lossy text slices.
export const REPLAY_CHUNK_BYTES=262144;
export const REPLAY_MAX_BYTES=128*1024*1024;
const invalid=()=>new Error('REPLAY_INCOMPLETE');
async function transform(bytes,stream,limit) {
  const reader=new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>limit){await reader.cancel();throw invalid();}chunks.push(value);}
  }catch{throw invalid();}
  const result=new Uint8Array(size);let at=0;for(const chunk of chunks){result.set(chunk,at);at+=chunk.length;}return result;
}
function base64(bytes) {
  let result='';for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(result);
}
export async function encodeReplayChunks(source) {
  const bytes=new TextEncoder().encode(source);if(bytes.length>REPLAY_MAX_BYTES)throw new Error('REPLAY_TOO_LARGE');
  const chunks=[];
  const append=async part=>{
    const compressed=await transform(part,new CompressionStream('gzip'),REPLAY_CHUNK_BYTES+1024);
    // Keep larger compression windows for repetitive frames, split incompressible input to fit the storage value.
    if(compressed.length>45000){const half=Math.floor(part.length/2);await append(part.subarray(0,half));await append(part.subarray(half));}
    else chunks.push({text:base64(compressed),rawBytes:part.length});
  };
  for(let offset=0;offset<bytes.length;offset+=REPLAY_CHUNK_BYTES) {
    await append(bytes.subarray(offset,offset+REPLAY_CHUNK_BYTES));
  }
  return {schemaVersion:2,codec:'gzip-base64',decodedBytes:bytes.length,chunks};
}
export async function decodeReplayChunk(text,expectedBytes) {
  if(typeof text!=='string' || text.length>64000 || !Number.isSafeInteger(expectedBytes) || expectedBytes<1 || expectedBytes>REPLAY_CHUNK_BYTES)throw invalid();
  let bytes;try{bytes=Uint8Array.from(atob(text),c=>c.charCodeAt(0));}catch{throw invalid();}
  const decoded=await transform(bytes,new DecompressionStream('gzip'),expectedBytes);
  if(decoded.length!==expectedBytes)throw invalid();return decoded;
}
