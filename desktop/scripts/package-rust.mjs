import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const project=fileURLToPath(new URL('../',import.meta.url));
const profile=process.argv[3]||'release';
if(!['release','debug'].includes(profile))throw new Error('Build profile must be release or debug');
const binary=path.join(project,`src-tauri/target/${profile}/luma-rust.exe`);
const zip=path.join(project,'src-tauri/resources/tools.zip');
const output=process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(project,'../outputs');
await fs.mkdir(output,{recursive:true});
const filename=path.join(output,'Luma-Rust.exe');
const file=await fs.open(filename,'w');
try{
 for await(const chunk of createReadStream(binary))await file.write(chunk);
 const hash=createHash('sha256');let length=0;
 for await(const chunk of createReadStream(zip)){hash.update(chunk);length+=chunk.length;await file.write(chunk);}
 const footer=Buffer.alloc(48);footer.write('LUMARST1');footer.writeBigUInt64LE(BigInt(length),8);hash.digest().copy(footer,16);await file.write(footer);await file.sync();
}finally{await file.close();}
const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);
const digest=hash.digest('hex');await fs.writeFile(path.join(output,'Luma-Rust-SHA256.txt'),digest+'  Luma-Rust.exe\n');
console.log(JSON.stringify({filename,bytes:(await fs.stat(filename)).size,sha256:digest}));
