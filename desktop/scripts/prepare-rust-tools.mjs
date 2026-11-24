import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(command,args){const p=spawnSync(command,args,{cwd:root,windowsHide:true,stdio:'inherit'});if(p.error)throw p.error;if(p.status!==0)throw Error(`${command} exited ${p.status}`);}
run(process.execPath,['scripts/fetch-tools.mjs']);
const tools=path.join(root,'resources/tools');const hashes={};
for(const file of (await fs.readdir(tools)).sort()){if(/\.(exe|dll)$/i.test(file))hashes[file]=createHash('sha256').update(await fs.readFile(path.join(tools,file))).digest('hex');}
for(const required of ['ffmpeg.exe','ffprobe.exe','yt-dlp.exe','deno.exe'])if(!hashes[required])throw Error(`Missing ${required}`);
const resources=path.join(root,'src-tauri/resources');await fs.mkdir(resources,{recursive:true});
await fs.writeFile(path.join(resources,'tools.sha256.json'),JSON.stringify(hashes,null,2)+'\n');
run('tar.exe',['-a','-cf',path.join(resources,'tools.zip'),'-C',tools,'.']);
// Native tests use the same verified executable/DLL set as the shipped application.
const testTools=path.join(root,'.build-tools/native/resources/tools');await fs.mkdir(testTools,{recursive:true});
for(const file of Object.keys(hashes))await fs.copyFile(path.join(tools,file),path.join(testTools,file));
console.log('Verified native tools, manifest and ZIP prepared.');
