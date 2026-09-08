import {readdir,readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const {version}=JSON.parse(await readFile('package.json','utf8'));
if(!/^\d+\.\d+\.\d+$/.test(version)||version==='0.2.0')throw new Error('Refusing to change original release');
const needed=[];
for(const target of ['win32-x64','darwin-x64','darwin-arm64']) {
  needed.push(`naver-mail-${version}-${target}.${target.startsWith('win32')?'zip':'tar.gz'}`);
  needed.push(`naver-mail-install-${version}-${target}${target.startsWith('win32')?'.exe':''}`);
}
const found=new Map();
async function walk(dir) {for(const entry of await readdir(dir,{withFileTypes:true})) {const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(needed.includes(entry.name)||needed.some(n=>entry.name===n+'.sha256')){if(found.has(entry.name))throw new Error('Duplicate release asset');found.set(entry.name,path);}}}
await walk('release-artifacts');await mkdir('release-upload',{recursive:true});
const files=[],sums=[];
for(const name of needed) {
  const path=found.get(name),sumPath=found.get(name+'.sha256');if(!path||!sumPath)throw new Error('Missing asset '+name);
  const hash=createHash('sha256').update(await readFile(path)).digest('hex');
  if((await readFile(sumPath,'utf8')).trim()!==hash+'  '+name)throw new Error('Checksum mismatch '+name);
  for(const [source,dest] of [[path,name],[sumPath,name+'.sha256']]){await copyFile(source,join('release-upload',dest));files.push(join('release-upload',dest));}
  sums.push(hash+'  '+name);
}
await writeFile('release-upload/SHA256SUMS.txt',sums.join('\n')+'\n');files.push('release-upload/SHA256SUMS.txt');
const gh=args=>{const r=spawnSync('gh',args,{stdio:'inherit'});if(r.status!==0)throw new Error('GitHub release operation failed');};
gh(['release','create','v'+version,...files,'--repo','eziwork/naver-mail','--target',process.env.GITHUB_SHA,'--draft','--prerelease','--title','네이버 메일 v'+version+' · 설치 및 Mac 연결 개선','--notes-file','RELEASE.md']);
gh(['release','edit','v'+version,'--repo','eziwork/naver-mail','--draft=false','--prerelease','--latest=false']);
