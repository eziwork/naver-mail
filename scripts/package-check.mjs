import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=resolve('.');const version=JSON.parse(await readFile('package.json','utf8')).version;
const release=resolve(process.env.NAVER_MAIL_RELEASE_DIR??'releases');
const name=`naver-mail-${version}-${process.platform}-${process.arch}.${process.platform==='win32'?'zip':'tar.gz'}`;
const archive=join(release,name);const hash=createHash('sha256').update(await readFile(archive)).digest('hex');
assert.equal((await readFile(archive+'.sha256','utf8')).trim(),hash+'  '+name);
const temp=await mkdtemp(join(tmpdir(),'naver-package-check-'));
function run(command,args,env={}) {const r=spawnSync(command,args,{cwd:root,env:{...process.env,...env},stdio:'inherit',windowsHide:true});if(r.error)throw r.error;assert.equal(r.status,0);}
try {
  run('tar',['-xf',archive,'-C',temp]);
  const plugin=join(temp,'naver-mail');
  const catalog=JSON.parse(await readFile(join(plugin,'dist/tool-catalog.json'),'utf8'));assert.equal(catalog.result.tools.length,12);
  const build=JSON.parse(await readFile(join(plugin,'BUILD.json'),'utf8'));assert.equal(build.version,version);
  run(process.execPath,['scripts/setup-lifecycle-test.mjs'],{NAVER_MAIL_PACKAGE_ROOT:plugin});
  const node=join(plugin,'runtime',`${process.platform}-${process.arch}`,...(process.platform==='win32'?['node.exe']:['bin','node']));
  run(node,['--input-type=module','-e',`const {AsyncEntry}=await import(${JSON.stringify(pathToFileURL(join(plugin,'node_modules/@napi-rs/keyring/index.js')).href)});if(typeof AsyncEntry!=='function')throw Error('keyring missing');`]);
  run('cargo',['test','--locked','--manifest-path','installer/Cargo.toml','packaged_archive_round_trip','--','--ignored'],{NAVER_MAIL_TEST_PACKAGE:archive});
  console.log(JSON.stringify({passed:true,package:name,checksumVerified:true,tools:12,extractedLifecycle:true,bundledKeyringLoad:true}));
} finally {
  if(!temp.startsWith(join(tmpdir(),'naver-package-check-')))throw new Error('Unsafe cleanup');
  await rm(temp,{recursive:true,force:true});
}
