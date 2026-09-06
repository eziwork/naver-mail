import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
const run = promisify(execFile);
export async function downloadsDirectory(): Promise<string> {
  if (process.platform === "win32") {
    try {
      const {stdout} = await run("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders", "/v", "{374DE290-123F-4565-9164-39C4925E467B}"], {windowsHide:true,timeout:5_000,maxBuffer:16_384});
      const value=stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/u)?.[1]?.trim().replace(/%([^%]+)%/gu,(_m,key:string)=>process.env[key]??"");
      if(value&&isAbsolute(value))return value;
    }catch { /* Standard Downloads remains a safe fallback. */ }
  }
  return join(homedir(),"Downloads");
}
export async function applyMacQuarantine(path:string):Promise<void> {
  await run("/usr/bin/xattr",["-w","com.apple.quarantine",`0081;${Math.floor(Date.now()/1000).toString(16)};Eziwork Naver Mail;`,path],{timeout:5_000,maxBuffer:16_384});
}
