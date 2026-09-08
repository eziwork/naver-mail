(() => {
  'use strict';
  const root = document.querySelector('main');
  const base = root.dataset.base, expires = Number(root.dataset.expires);
  const form = document.querySelector('#connect-form');
  const notice = document.querySelector('#notice');
  const password = document.querySelector('#appPassword');
  const email = document.querySelector('#email');
  const button = document.querySelector('#connect-button');
  const statusLabel = document.querySelector('#server-status');
  const storageKey = 'naver-mail-setup-progress';
  let busy = false, complete = false, ended = false, online = false, posting = false, uncertain = false;
  let step = 1, timer, submission = 0, connectionNotice = false;
  const clearSaved = () => { try { sessionStorage.removeItem(storageKey); } catch {} };
  const save = () => {
    if (complete || ended) return clearSaved();
    try { sessionStorage.setItem(storageKey, JSON.stringify({expires, step, email: email.value})); } catch {}
  };
  const error = message => { notice.textContent = message; notice.hidden = false; };
  const controls = () => {
    button.disabled = busy || ended || !online || uncertain || complete;
    document.querySelectorAll('[data-go]').forEach(b => { b.disabled = busy || ended || complete || uncertain; });
  };
  const show = next => {
    step = next;
    document.querySelectorAll('[data-step]').forEach(s => { s.hidden = s.dataset.step !== String(step); });
    document.querySelectorAll('.progress li').forEach((s,i) => {
      if (i === step - 1) s.setAttribute('aria-current', 'step'); else s.removeAttribute('aria-current');
    });
    document.querySelector('[data-step="' + step + '"] h2').focus();
    save();
  };
  const expire = () => {
    ended = true; busy = false; password.value = ''; clearSaved(); clearTimeout(timer);
    statusLabel.textContent = '설정 시간이 끝났어요.';
    error('이 연결 화면은 만료되었어요. 앱에서 “네이버 메일 연결해 줘”를 다시 요청해 주세요.');
    controls();
  };
  const paint = state => {
    if (state.state === 'expired') { expire(); return; }
    document.querySelectorAll('[data-check]').forEach(el => { el.dataset.state = state.checks?.[el.dataset.check] || 'waiting'; });
    if (state.state === 'connected') {
      complete = true; busy = false; uncertain = false; clearSaved(); clearTimeout(timer);
      show(4);
      document.querySelector('#step-4-title').textContent = '연결되었어요';
      document.querySelector('#connection-message').textContent = state.account + ' 계정의 조회·발송 연결을 확인하고 이 컴퓨터에 안전하게 저장했어요.';
      document.querySelector('#success').hidden = false;
      document.querySelector('#cancel-button').hidden = true;
      statusLabel.textContent = '연결 완료 · 앱으로 돌아가 메일을 요청하세요.';
      notice.hidden = true;
    } else if (state.state === 'checking') {
      uncertain = false; busy = true;
      if (step !== 4) show(4);
    } else if (state.state === 'failed') {
      uncertain = false; busy = false;
      document.querySelector('#retry-button').hidden = false;
      error(state.error?.message || '입력 내용을 확인하고 다시 시도해 주세요.');
    } else if (!posting && !uncertain) {
      busy = false;
      if (step === 4) show(3);
    }
    controls();
  };
  async function poll() {
    if (complete || ended) return;
    if (posting) { timer = setTimeout(poll,600); return; }
    if (Date.now() >= expires) { expire(); return; }
    const observedSubmission = submission;
    try {
      const response = await fetch(base + '/api/status', {cache:'no-store', credentials:'same-origin', signal:AbortSignal.timeout(5000)});
      if (response.status === 410) { expire(); return; }
      if (!response.ok) throw new Error('status unavailable');
      const state = await response.json();
      if (complete || ended || posting || observedSubmission !== submission) { if (!complete && !ended) timer = setTimeout(poll,600); return; }
      online = true;
      if (connectionNotice) { notice.hidden = true; connectionNotice = false; }
      statusLabel.textContent = uncertain ? '제출 결과 확인 중 · 자동으로 다시 제출하지 않아요.' : '설정 화면 연결 정상';
      paint(state);
    } catch {
      if (complete || ended || posting || observedSubmission !== submission) { if (!complete && !ended) timer = setTimeout(poll,600); return; }
      online = false;
      connectionNotice = true;
      statusLabel.textContent = '설정 서버와 연결이 끊겼어요. 상태 확인을 다시 시도하고 있어요.';
      error('앱에서 “네이버 메일 연결 상태 확인해 줘”를 요청하세요. 연결되지 않았다면 새 연결 화면을 열어 주세요.');
      controls();
    }
    if (!complete && !ended) timer = setTimeout(poll, busy ? 600 : 2000);
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved?.expires === expires && Date.now() < expires) {
      if (typeof saved.email === 'string') email.value = saved.email.slice(0,254);
      if ([1,2,3,4].includes(saved.step)) step = saved.step;
    } else clearSaved();
  } catch { clearSaved(); }
  email.addEventListener('input', save);
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
    if (!busy && !ended && !complete && !uncertain) { notice.hidden = true; show(Number(b.dataset.go)); }
  }));
  document.querySelector('#toggle-password').addEventListener('click', event => {
    const visible = password.type === 'password'; password.type = visible ? 'text' : 'password';
    event.currentTarget.textContent = visible ? '숨기기' : '보기'; event.currentTarget.setAttribute('aria-pressed', String(visible));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || ended || complete || uncertain || !online || !form.reportValidity()) return;
    busy = true; posting = true; submission++; notice.hidden = true; controls();
    document.querySelector('#retry-button').hidden = true;
    document.querySelector('#step-4-title').textContent = '연결을 확인하고 있어요';
    document.querySelector('#connection-message').textContent = '조회 연결·발송 연결·안전한 저장을 확인하고 있어요.';
    show(4);
    const body = new URLSearchParams(new FormData(form));
    password.value = ''; password.type = 'password';
    document.querySelector('#toggle-password').textContent = '보기';
    document.querySelector('#toggle-password').setAttribute('aria-pressed','false');
    try {
      const response = await fetch(base + '/api/connect', {method:'POST',body,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
      if (response.status === 410) { expire(); return; }
      const state = await response.json();
      if (!state.state) throw new Error('submission status unknown');
      if (!ended) paint(state);
    } catch {
      if (!complete) { uncertain = true; error('제출 결과를 확인하지 못했어요. 자동으로 다시 제출하지 않고 연결 상태를 확인할게요.'); }
    } finally { body.delete('appPassword'); password.value = ''; posting = false; controls(); }
  });
  document.querySelector('#finish-button').addEventListener('click', async () => {
    clearSaved();
    try { await fetch(base + '/api/close', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'close=yes',signal:AbortSignal.timeout(3000)}); } catch {}
    window.close();
    document.querySelector('#finish-button').textContent = '이 창을 닫고 앱으로 돌아가 주세요';
  });
  document.querySelector('#cancel-button').addEventListener('click', async () => {
    ended = true; busy = false; password.value = ''; clearSaved(); clearTimeout(timer); controls();
    try {
      const response = await fetch(base + '/api/close', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'close=yes',signal:AbortSignal.timeout(3000)});
      if (!response.ok) throw new Error('close failed');
      statusLabel.textContent = '연결 설정을 취소했어요. 이 창을 닫아 주세요.';
      notice.hidden = true;
    } catch { error('취소 요청을 확인하지 못했어요. 앱에서 연결 상태를 확인하세요. 설정 서버는 최대 30분 후 정리됩니다.'); }
  });
  const countdown = setInterval(() => {
    if (complete || ended) { clearInterval(countdown); return; }
    const remaining = Math.max(0,Math.ceil((expires-Date.now())/1000));
    document.querySelector('#expiry-note').textContent = '남은 설정 시간 ' + Math.floor(remaining/60) + '분 ' + remaining%60 + '초 · 앱을 닫아도 이 시간 동안 유지돼요.';
    if (!remaining) expire();
  },1000);
  window.addEventListener('pagehide', () => { password.value = ''; save(); });
  show(step); controls(); void poll();
})();
