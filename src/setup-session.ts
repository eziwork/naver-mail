import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LIMITS } from "./constants.js";
import type { CredentialStore, CredentialRecord } from "./credentials.js";
import { publicError, UserFacingError, type PublicError } from "./errors.js";
import { testNaverCredentials } from "./naver-client.js";
import { normalizeNaverEmail, maskEmail } from "./validation.js";
import { renderForm } from "./setup-page.js";
import { operationSignals, requestSignals } from "./operation.js";

type Phase = "imap" | "smtp" | "storage";
type Check = "waiting" | "active" | "done" | "error";
interface SetupState {
  state: "waiting" | "checking" | "connected" | "failed" | "expired";
  checks: Record<Phase, Check>;
  account?: string;
  error?: PublicError;
}
interface Session {
  server: Server; token: string; url: string; port: number; expiresAt: number;
  attempts: number; busy: boolean; abort: AbortController; timer: NodeJS.Timeout; state: SetupState;
}
interface SetupOptions {
  openBrowser?: (url: string) => Promise<boolean>;
  verify?: typeof testNaverCredentials;
  commit?: (email: string, password: string) => Promise<void>;
  ttlMs?: number;
  completionGraceMs?: number;
}
const assets = new Map<string, {url: URL; type: string}>([
  ...["two-factor-security.png", "pop3-options.png", "imap-smtp-enable.png", "application-password.png"].map(name =>
    [name, {url:new URL(`../assets/guide/${name}`, import.meta.url),type:"image/png"}] as const),
  ["setup.js", {url:new URL("../assets/setup.js", import.meta.url),type:"text/javascript; charset=utf-8"}],
  ["setup.css", {url:new URL("../assets/setup.css", import.meta.url),type:"text/css; charset=utf-8"}]
]);

export class SetupServer {
  private active: Session | null = null;
  private lastState: SetupState | undefined;
  constructor(private readonly credentials: Pick<CredentialStore,"save">, private readonly options: SetupOptions = {}) {}
  get isActive(): boolean { return this.active !== null; }
  status(): SetupState | undefined { return this.active?.state ?? this.lastState; }

  async open(): Promise<{url?: string; expiresAt: string; browserOpened: boolean}> {
    if (!this.active || this.active.expiresAt <= Date.now() || this.active.state.state === "connected" || (!this.active.busy && this.active.attempts >= LIMITS.setupAttempts)) {
      await this.close();
      const token=randomBytes(32).toString("base64url");
      const server=createServer((req,res)=>{void this.handle(req,res).catch(()=>{
        if(!res.headersSent)send(res,500,{error:{code:"SETUP_ERROR",message:"연결 화면을 다시 열어 주세요."}});else res.destroy();
      });});
      server.requestTimeout=15_000; server.headersTimeout=10_000;
      server.on("clientError",(_error,socket)=>socket.destroy());
      await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
      const port=(server.address() as AddressInfo).port;
      const expiresAt=Date.now()+(this.options.ttlMs??LIMITS.setupTtlMs);
      const timer=setTimeout(()=>{if(this.active){this.active.state.state="expired";this.lastState=this.active.state;}void this.close();},Math.max(1,expiresAt-Date.now()));timer.unref();
      this.active={server,token,url:`http://127.0.0.1:${port}/setup/${token}`,port,expiresAt,attempts:0,busy:false,abort:new AbortController(),timer,state:initialState()};
    }
    const session=this.active;
    const browserOpened=await (this.options.openBrowser??openBrowser)(session.url);
    // A launcher can exit successfully even when the browser is hidden or blocked.
    // Keep a manual link available in both cases.
    return {browserOpened,expiresAt:new Date(session.expiresAt).toISOString(),url:session.url};
  }

  async close(): Promise<void> {
    const session=this.active;this.active=null;
    if(!session)return;
    this.lastState=session.state;clearTimeout(session.timer);session.abort.abort();
    session.server.closeAllConnections();
    await new Promise<void>(resolve=>session.server.close(()=>resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session=this.active;
    if(!session){send(response,410,{state:"expired"});return;}
    const host=`127.0.0.1:${session.port}`;
    if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(request.socket.remoteAddress??"") || request.headers.host!==host){send(response,403,{error:{message:"이 컴퓨터에서만 연결할 수 있습니다."}});return;}
    let url:URL;
    try{url=new URL(request.url??"/",`http://${host}`);}catch{send(response,400,{error:{message:"잘못된 주소입니다."}});return;}
    const base=`/setup/${session.token}`;
    if(url.search||!(url.pathname===base||url.pathname.startsWith(base+"/"))){send(response,404,{error:{message:"연결 화면을 찾을 수 없습니다."}});return;}
    if(Date.now()>=session.expiresAt){send(response,410,{state:"expired"});return;}
    if(request.method==="GET") {
      if(url.pathname===base){send(response,200,renderForm(base,"",session.expiresAt),"text/html; charset=utf-8");return;}
      if(url.pathname===`${base}/api/status`){send(response,200,session.state);return;}
      const asset=guideAssetForPath(url.pathname,base);
      if(asset){try{send(response,200,await readFile(asset.url),asset.type);}catch{send(response,404,{error:{message:"안내 파일을 불러오지 못했습니다."}});}return;}
      send(response,404,{error:{message:"요청한 화면을 찾을 수 없습니다."}});return;
    }
    if(request.method!=="POST"){send(response,405,{error:{message:"허용되지 않은 요청입니다."}});return;}
    if(!isSameOriginRequest(request,host)){send(response,403,{error:{message:"다른 사이트에서 보낸 요청은 허용되지 않습니다."}});return;}
    if(url.pathname===`${base}/api/close`){send(response,200,{closed:true});setImmediate(()=>void this.close());return;}
    if(url.pathname!==`${base}/api/connect`){send(response,404,{error:{message:"연결 화면을 찾을 수 없습니다."}});return;}
    if(!(request.headers["content-type"]??"").toLowerCase().startsWith("application/x-www-form-urlencoded")){send(response,415,{error:{message:"입력 형식을 확인해 주세요."}});return;}
    if(session.busy){send(response,409,session.state);return;}
    if(session.state.state==="connected"){send(response,200,session.state);return;}
    // Reserve the session before reading the body, so concurrent POSTs cannot both authenticate.
    session.busy=true;
    try {
      const form=new URLSearchParams(await readBody(request));
      if(form.get("acknowledge")!=="yes")throw new UserFacingError("SETUP_ACK_REQUIRED","네이버에서 만든 앱 비밀번호를 입력했는지 확인해 주세요.");
      const email=normalizeNaverEmail(form.get("email")??"");
      const appPassword=(form.get("appPassword")??"").trim();
      form.delete("appPassword");
      if(appPassword.length<4||appPassword.length>256||/[\r\n\0]/u.test(appPassword))throw new UserFacingError("INVALID_APP_PASSWORD","올바른 애플리케이션 비밀번호를 입력해 주세요.");
      if(session.attempts>=LIMITS.setupAttempts)throw new UserFacingError("SETUP_ATTEMPTS_EXCEEDED","연결 시도 횟수를 초과했습니다. 앱에서 연결 화면을 다시 열어 주세요.");
      session.attempts+=1;session.state=initialState();session.state.state="checking";
      void this.verify(session,{schema:1,email,appPassword});
      send(response,202,session.state);
    }catch(error){session.busy=false;session.state={...initialState(),state:"failed",error:publicError(error)};send(response,400,session.state);}
  }

  private async verify(session: Session, candidate: CredentialRecord): Promise<void> {
    let phase:Phase="imap";
    const signal=AbortSignal.any([session.abort.signal,AbortSignal.timeout(LIMITS.operationTimeoutMs)]);
    try {
      await operationSignals.run(signal,()=> (this.options.verify??testNaverCredentials)(candidate, stage=>{
        if(stage==="smtp")session.state.checks.imap="done";
        phase=stage;session.state.checks[stage]="active";
      }));
      signal.throwIfAborted();
      if(this.active!==session)throw new Error("Setup session closed.");
      session.state.checks.smtp="done";phase="storage";session.state.checks.storage="active";
      await requestSignals.run(signal,()=>this.options.commit
        ? this.options.commit(candidate.email,candidate.appPassword)
        : this.credentials.save(candidate.email,candidate.appPassword));
      session.state.checks.storage="done";session.state.state="connected";session.state.account=maskEmail(candidate.email);
      this.lastState=session.state;
      clearTimeout(session.timer);
      session.timer=setTimeout(()=>{if(this.active===session)void this.close();},this.options.completionGraceMs??15_000);session.timer.unref();
    }catch(error){
      session.state.state=session.abort.signal.aborted?"expired":"failed";
      session.state.checks[phase]="error";
      session.state.error=signal.aborted && !session.abort.signal.aborted
        ? {code:"NETWORK_TIMEOUT",message:"연결 확인 시간이 초과되었습니다. 네트워크 상태를 확인하고 다시 시도해 주세요."}
        : publicError(error);
    }finally{candidate.appPassword="";session.busy=false;}
  }
}

function initialState(): SetupState { return {state:"waiting",checks:{imap:"waiting",smtp:"waiting",storage:"waiting"}}; }
export function guideAssetForPath(pathname:string,base:string) {
  const prefix=`${base}/assets/`; if(!pathname.startsWith(prefix))return null;
  const leaf=pathname.slice(prefix.length);if(!leaf||leaf.includes("/")||leaf.includes("\\"))return null;
  return assets.get(leaf)??null;
}
export function isSameOriginRequest(request: Pick<IncomingMessage,"headers">, host:string): boolean {
  const origin=request.headers.origin,site=request.headers["sec-fetch-site"];
  return origin===`http://${host}` || (origin==="null"&&site==="same-origin") || (origin===undefined&&site==="same-origin");
}
async function readBody(request:IncomingMessage):Promise<string> {
  const chunks:Buffer[]=[];let bytes=0;
  for await(const raw of request){const chunk=Buffer.from(raw);bytes+=chunk.length;if(bytes>LIMITS.setupBodyBytes)throw new UserFacingError("SETUP_REQUEST_TOO_LARGE","입력 내용이 너무 큽니다.");chunks.push(chunk);}
  return Buffer.concat(chunks,bytes).toString("utf8");
}
function send(response:ServerResponse,status:number,value:unknown,type="application/json; charset=utf-8"):void {
  const body=Buffer.isBuffer(value)?value:Buffer.from(typeof value==="string"?value:JSON.stringify(value));
  response.writeHead(status,{"Content-Type":type,"Content-Length":body.length,"Cache-Control":"no-store, max-age=0","Pragma":"no-cache","Content-Security-Policy":"default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'","Cross-Origin-Resource-Policy":"same-origin","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=(), payment=()"});response.end(body);
}
export async function openBrowser(url:string):Promise<boolean> {
  return new Promise(resolve=>{
    let child;
    try {
      child=process.platform==="win32"?spawn("rundll32.exe",["url.dll,FileProtocolHandler",url],{stdio:"ignore",windowsHide:true}):spawn(process.platform==="darwin"?"open":"xdg-open",[url],{stdio:"ignore"});
    }catch{resolve(false);return;}
    let settled=false;
    const done=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(ok);child.unref();};
    const timer=setTimeout(()=>done(false),3_000);
    child.once("error",()=>done(false));child.once("exit",code=>done(code===0));
  });
}
export const testing={guideAssetForPath,isSameOriginRequest,renderForm};
