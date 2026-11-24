import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const project=fileURLToPath(new URL('../',import.meta.url));
const pkg=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8'));
const output=path.resolve(process.argv[2]||path.join(project,'artifacts'));
const payload=path.resolve(process.argv[3]||path.join(project,'.build-tools/installer-payload/Luma-Rust.exe'));
const cache=path.join(project,'.build-tools/installer');
await fs.mkdir(output,{recursive:true});await fs.mkdir(cache,{recursive:true});
function run(command,args){const result=spawnSync(command,args,{cwd:project,windowsHide:true,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw Error(`${command} exited ${result.status}`);}
const zip=path.join(cache,'nsis-3.13.zip');
const nsisHash='ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8';
async function download(url,destination){const response=await fetch(url);if(!response.ok)throw Error(`Download failed: ${response.status}`);await fs.writeFile(destination,Buffer.from(await response.arrayBuffer()));}
let valid=false;try{valid=createHash('sha256').update(await fs.readFile(zip)).digest('hex')===nsisHash}catch{}
if(!valid){await download('https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip',zip);if(createHash('sha256').update(await fs.readFile(zip)).digest('hex')!==nsisHash)throw Error('NSIS checksum mismatch');}
const extract=path.join(cache,'nsis');await fs.mkdir(extract,{recursive:true});
const nsis=path.join(extract,'nsis-3.13/makensis.exe');
try{await fs.access(nsis)}catch{run('tar.exe',['-xf',zip,'-C',extract]);}
const webview=path.join(cache,'MicrosoftEdgeWebview2Setup.exe');
try{await fs.access(webview)}catch{await download('https://go.microsoft.com/fwlink/p/?LinkId=2124703',webview);}
process.env.LUMA_WEBVIEW_SETUP=webview;
// Do not accept a substituted bootstrapper; verify the Microsoft Authenticode signature.
run('pwsh.exe',['-NoProfile','-NonInteractive','-Command',`$s=Get-AuthenticodeSignature -LiteralPath $env:LUMA_WEBVIEW_SETUP; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation'){throw 'Invalid Microsoft WebView2 signature'}`].map(String));
await fs.access(payload);
const installer=path.join(output,`Luma-Rust-${pkg.version}-x64-setup.exe`);
run(nsis,[`/DAPP_VERSION=${pkg.version}`,`/DOUTPUT=${installer}`,`/DAPP_EXE=${payload}`,`/DAPP_ICON=${path.join(project,'build/icon.ico')}`,`/DAPP_LICENSE=${path.join(project,'LICENSE')}`,`/DAPP_NOTICES=${path.join(project,'THIRD-PARTY-NOTICES.md')}`,`/DWEBVIEW_SETUP=${webview}`,path.join(project,'build/installer.nsi')]);
const digest=createHash('sha256').update(await fs.readFile(installer)).digest('hex');
await fs.writeFile(path.join(output,'SHA256SUMS.txt'),`${digest}  ${path.basename(installer)}\n`);
console.log(JSON.stringify({installer,version:pkg.version,sha256:digest}));
