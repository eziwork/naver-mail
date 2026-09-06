(() => {
  'use strict';
  const root = document.querySelector('main');
  const base = root.dataset.base;
  const form = document.querySelector('#connect-form');
  const notice = document.querySelector('#notice');
  const password = document.querySelector('#appPassword');
  let busy = false, complete = false;
  const show = (step) => {
    document.querySelectorAll('[data-step]').forEach(s => { s.hidden = s.dataset.step !== String(step); });
    document.querySelectorAll('.progress li').forEach((s,i) => { if(i===step-1)s.setAttribute('aria-current','step');else s.removeAttribute('aria-current'); });
    document.querySelector(`[data-step="${step}"] h2`).focus();
  };
  const error = message => { notice.textContent = message; notice.hidden = false; };
  const paint = state => {
    const phases = ['imap','smtp','storage'];
    document.querySelectorAll('[data-check]').forEach(el => {
      const phase=el.dataset.check;
      el.dataset.state = state.checks[phase] || 'waiting';
    });
    if(state.state==='connected') {
      complete=true; busy=false;
      document.querySelector('#step-4-title').textContent='연결되었어요';
      document.querySelector('#connection-message').textContent=`${state.account} 계정을 이 컴퓨터에 안전하게 저장했어요.`;
      document.querySelector('#success').hidden=false;
      notice.hidden=true;
      return true;
    }
    if(state.state==='failed'||state.state==='expired') {
      busy=false;
      document.querySelector('#step-4-title').textContent='연결을 확인해 주세요';
      document.querySelector('#connection-message').textContent='아래 안내를 확인한 뒤 다시 시도할 수 있어요.';
      document.querySelector('#retry-button').hidden=false;
      error(state.error?.message || '연결 시간이 끝났어요. 앱에서 “네이버 메일 연결”을 다시 요청해 주세요.');
      return true;
    }
    return false;
  };
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>{if(!busy)show(Number(b.dataset.go));}));
  document.querySelector('#toggle-password').addEventListener('click', event=>{
    const visible=password.type==='password'; password.type=visible?'text':'password';
    event.currentTarget.textContent=visible?'숨기기':'보기';event.currentTarget.setAttribute('aria-pressed',String(visible));
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault(); if(busy||!form.reportValidity())return;
    busy=true; notice.hidden=true;
    document.querySelector('#connect-button').disabled=true;
    document.querySelector('#retry-button').hidden=true;
    document.querySelector('#step-4-title').textContent='연결을 확인하고 있어요';
    document.querySelector('#connection-message').textContent='잠시만 기다려 주세요. 테스트 메일을 발송하지 않습니다.';
    document.querySelectorAll('[data-check]').forEach(el=>el.dataset.state='waiting');
    show(4);
    try {
      const body=new URLSearchParams(new FormData(form));
      password.value=''; password.type='password';
      document.querySelector('#toggle-password').textContent='보기';
      document.querySelector('#toggle-password').setAttribute('aria-pressed','false');
      const response=await fetch(`${base}/api/connect`,{method:'POST',body,credentials:'same-origin',cache:'no-store'});
      body.delete('appPassword');
      const state=await response.json();
      if(!response.ok && !state.state)throw new Error(state.error?.message || '연결 요청을 처리하지 못했어요.');
      if(!paint(state)) {
        for(;;) {
          await new Promise(resolve=>setTimeout(resolve,600));
          const status=await fetch(`${base}/api/status`,{cache:'no-store',credentials:'same-origin'});
          if(!status.ok)throw new Error('연결 화면이 종료되었어요. 앱에서 연결 상태를 확인하거나 “네이버 메일 연결”을 다시 요청해 주세요.');
          if(paint(await status.json()))break;
        }
      }
    } catch(e) { busy=false; error(e.message || '연결 상태를 확인할 수 없어요. 앱에서 연결 상태를 확인해 주세요.');document.querySelector('#retry-button').hidden=false; }
    finally {password.value='';document.querySelector('#connect-button').disabled=false;}
  });
  document.querySelector('#finish-button').addEventListener('click',async()=>{
    try{await fetch(`${base}/api/close`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'close=yes'});}catch{}
    window.close();
    document.querySelector('#finish-button').textContent='이 창을 닫고 앱으로 돌아가 주세요';
  });
  const expiry=setInterval(()=>{
    if(complete){clearInterval(expiry);return;}
    if(Date.now()>Number(root.dataset.expires)){clearInterval(expiry);password.value='';error('연결 시간이 끝났어요. 앱에서 “네이버 메일 연결”을 다시 요청해 주세요.');document.querySelector('#connect-button').disabled=true;}
  },1000);
})();
