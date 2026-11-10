/*
 * 두루보드 (duruboard)
 * - 인증코드는 메모리(변수)에만 보관하며 어디에도 저장하지 않습니다.
 * - 도메인은 사용자가 선택한 경우에만 이 기기(localStorage)에 저장합니다.
 * - 레이아웃(그래프 설정)은 자료 출처별로 이 기기에 저장하며, 선택 시 서버가 제공한 레이아웃을 적용합니다.
 * - 받은 자료는 화면 표시에만 사용하며, 화면에는 textContent로만 넣습니다.
 */
(function () {
  'use strict';

  // ───────────── 설정값 ─────────────
  const API_PATH = '/api/v1/data';
  const FETCH_TIMEOUT_MS = 15000;
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_ROWS = 50000;
  const MAX_KEYS = 1000;
  const MAX_GROUPS = 500;
  const MAX_CHARTS = 50;
  const MAX_BGROUPS = 30;
  const STORE_PREFIX = 'duruboard:';
  const KEYS_AXIS = '__keys__';

  const CHART_TYPES = [
    { id: 'bar', label: '세로 막대', icon: 'tbar' },
    { id: 'hbar', label: '가로 막대', icon: 'thbar' },
    { id: 'line', label: '꺾은선', icon: 'tline' },
    { id: 'hist', label: '히스토그램', icon: 'thist' },
    { id: 'table', label: '표', icon: 'ttable' },
    { id: 'list', label: '명단', icon: 'tlist' }
  ];
  // 항목 순서: 집계 결과 값 또는 항목 이름 기준
  const SORTS = [
    { id: 'none', label: '자료 순' },
    { id: 'desc', label: '값 큰 순' },
    { id: 'asc', label: '값 작은 순' },
    { id: 'label', label: '이름 순' }
  ];
  const WIDTHS = [
    { id: 1, label: '기본' },
    { id: 2, label: '넓게' }
  ];
  // 칸 값 해석
  const READS = [
    { id: 'filled', label: '입력 여부', hint: '입력된 칸은 1, 빈 칸은 0으로 계산합니다. 완료·제출 여부 확인에 사용합니다.' },
    { id: 'blank', label: '미입력 여부', hint: '빈 칸은 1, 입력된 칸은 0으로 계산합니다. 미완료·미제출 확인에 사용합니다.' },
    { id: 'num', label: '숫자 값', hint: '칸에 기록된 숫자를 그대로 사용합니다. 점수·문항 수 등에 사용합니다.' }
  ];
  // 집계 방식 (each는 행 기준 그래프에서만 사용)
  const COMBINES = [
    { id: 'each', label: '열별 개별 표시' },
    { id: 'sum', label: '합계' },
    { id: 'avg', label: '평균' },
    { id: 'max', label: '최댓값' },
    { id: 'min', label: '최솟값' }
  ];
  const TYPE_LABEL = { number: '수치', string: '문자', boolean: '논리', mixed: '혼합' };
  const TYPE_ORDER = ['number', 'string', 'boolean', 'mixed'];
  // 여러 계열은 한 가지 색의 명암으로 구분합니다.
  const PALETTE = ['#26307f', '#3f4fc4', '#6572d6', '#8e98e3', '#b5bcee', '#d4d8f5', '#5a6070', '#9aa0ab'];

  // ───────────── 상태 ─────────────
  const state = {
    source: null,        // { id, label }
    rawRows: [],         // 서버에서 받은 원래 값
    rows: [],            // 자료형에 맞게 변환한 값
    keys: [],
    columns: new Map(),  // 서버가 지정한 열 정보
    typeOver: {},        // 사용자 지정 자료형·식별 여부 { key: { type, id } }
    keyInfo: new Map(),  // key -> { label, type, autoType, filled, total, idLike, autoId }
    meta: {},
    layoutFrom: 'local', // 'local' | 'server'
    layout: [],
    groups: [],          // 그룹 [{ id, name, parent(상위 그룹 id 또는 null), open }] — 최대 2단계
    addGroup: null,      // 새 개체를 넣을 그룹
    charts: new Map()
  };
  let authCode = null;   // 인증코드: 메모리에만 보관
  let serverOrigin = null;
  let editingId = null;
  let busy = false;

  // ───────────── 공통 도구 ─────────────
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };

  const store = {
    get(k) { try { return window.localStorage.getItem(STORE_PREFIX + k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(STORE_PREFIX + k, v); return true; } catch (e) { return false; } },
    del(k) { try { window.localStorage.removeItem(STORE_PREFIX + k); } catch (e) { /* 무시 */ } }
  };

  function setMsg(text, kind) {
    const m = $('msg');
    m.textContent = text || '';
    m.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function isBlank(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    return false;
  }

  // 문자열을 수치로 해석 (쉼표·공백·%·통화 기호 허용). 해석할 수 없으면 null
  function parseNumStr(str) {
    const t = String(str).trim().replace(/[\s,₩$]/g, '').replace(/%$/, '');
    if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') return parseNumStr(v);
    return null;
  }

  // 자료형에 맞게 값 변환 (화면·계산 모두 변환된 값을 사용)
  function castValue(v, type) {
    if (isBlank(v)) return null;
    if (type === 'number') return toNumber(v);                       // 해석할 수 없는 값은 빈 값
    if (type === 'boolean') return typeof v === 'boolean' ? v : Boolean(typeof v === 'string' ? v.trim() : v); // 일반 진릿값 판정
    if (type === 'string') return typeof v === 'object' ? JSON.stringify(v) : String(v);
    return v;                                                         // 혼합: 원래 값 유지
  }

  // 칸을 숫자로 읽기: 수치는 그대로, 논리는 1/0, 혼합은 숫자·논리만, 문자는 사용하지 않음
  function numericOf(v, type) {
    if (v === null || v === undefined) return null;
    if (type === 'string') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return null;
  }

  function display(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'number') return v.toLocaleString('ko-KR');
    if (typeof v === 'boolean') return v ? '참' : '거짓';
    if (typeof v === 'object') {
      try { const s = JSON.stringify(v); return s.length > 80 ? s.slice(0, 80) + '…' : s; } catch (e) { return '[자료]'; }
    }
    return String(v);
  }

  function labelOf(key) {
    const info = state.keyInfo.get(key);
    return info && info.label ? info.label : key;
  }

  function fmtNum(n, agg) {
    if (n === null || n === undefined || Number.isNaN(n)) return '';
    const r = Math.round(n * 100) / 100;
    return r.toLocaleString('ko-KR') + (agg === 'fillrate' ? '%' : '');
  }

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ───────────── 자료 검증 ─────────────
  // 규격 오류: 연결은 되었으나 응답 형식이 규격에 맞지 않는 경우
  function specErr(msg) { const e = new Error(msg); e.spec = true; return e; }
  function describeTop(obj) {
    if (obj === null) return 'null';
    if (Array.isArray(obj)) return '배열 (항목 ' + obj.length + '개)';
    if (typeof obj !== 'object') return typeof obj;
    const ks = Object.keys(obj);
    return ks.length ? '객체 (최상위 항목: ' + ks.slice(0, 8).join(', ') + (ks.length > 8 ? ' 외 ' + (ks.length - 8) + '개' : '') + ')' : '빈 객체';
  }
  function showSpecError(e, origin) {
    $('se-reason').textContent = e.message;
    $('se-got').textContent = e.got || '확인 불가';
    $('se-src').textContent = origin && origin.url ? origin.url : String(origin || '');
    $('dlg-spec').showModal();
  }

  function validate(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw specErr('응답 형식이 올바르지 않습니다. JSON 객체({ … })여야 합니다.');
    }
    if (!Array.isArray(obj.rows)) {
      throw specErr('응답에 rows 배열이 없습니다.');
    }
    if (obj.rows.length > MAX_ROWS) {
      throw specErr('행이 너무 많습니다. (최대 ' + MAX_ROWS.toLocaleString('ko-KR') + '행)');
    }
    obj.rows.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        throw specErr('rows의 ' + (i + 1) + '번째 항목이 객체가 아닙니다.');
      }
    });

    const columns = new Map();
    if (Array.isArray(obj.columns)) {
      obj.columns.forEach((c) => {
        if (c && typeof c.key === 'string' && c.key !== '') {
          const t = c.type === 'date' ? 'string' : c.type;
          columns.set(c.key, {
            label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : null,
            type: TYPE_LABEL[t] ? t : null,
            role: c.role === 'id' ? 'id' : null
          });
        }
      });
    }

    // 키 수집: columns 순서를 먼저, 그다음 행에 등장한 순서
    const seen = new Set(columns.keys());
    const keys = Array.from(columns.keys());
    for (const r of obj.rows) {
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) { seen.add(k); keys.push(k); }
      }
      if (keys.length > MAX_KEYS) throw specErr('키가 너무 많습니다. (최대 ' + MAX_KEYS + '개)');
    }
    if (keys.length === 0) throw specErr('자료에 키가 하나도 없습니다.');

    const meta = {};
    if (obj.meta && typeof obj.meta === 'object') {
      ['title', 'source', 'updatedAt'].forEach((f) => {
        if (typeof obj.meta[f] === 'string') meta[f] = obj.meta[f].slice(0, 200);
      });
      // 표 구분 이름: 같은 서버의 여러 표가 레이아웃을 따로 쓰도록 합니다.
      if (typeof obj.meta.id === 'string' && /^[\w.-]{1,64}$/.test(obj.meta.id)) meta.id = obj.meta.id;
    }

    // 레이아웃은 서버에서 받지 않음(교사가 두루보드에서 직접 구성)
    return { rows: obj.rows, keys, columns, meta };
  }

  // 자동 판정: 모든 값이 수(쉼표 포함 숫자 문자열 포함)면 수치. 단 0으로 시작하는 숫자 문자열(코드)은 문자
  function inferType(key, rows) {
    let num = 0, bool = 0, str = 0;
    for (const r of rows) {
      const v = r[key];
      if (isBlank(v)) continue;
      if (typeof v === 'boolean') bool++;
      else if (typeof v === 'number') num++;
      else if (typeof v === 'string' && !/^\s*[-+]?0\d/.test(v) && parseNumStr(v) !== null) num++;
      else str++;
    }
    if (!num && !bool && !str) return 'string';
    if (str === 0 && bool === 0) {
      // 같은 자릿수의 숫자 문자열만 있는 열(학번·코드 등)은 문자
      const vals = rows.map((r) => r[key]).filter((v) => !isBlank(v));
      if (vals.every((v) => typeof v === 'string' && /^\s*\d+\s*$/.test(v))) {
        const lens = new Set(vals.map((v) => v.trim().length));
        if (lens.size === 1 && vals[0].trim().length >= 4) return 'string';
      }
      return 'number';
    }
    if (str === 0 && num === 0) return 'boolean';
    if (num === 0 && bool === 0) return 'string';
    return 'mixed';
  }

  // 열별 자료형·식별 여부 결정 후 값 변환. 우선순위: 사용자 지정 > 서버 지정 > 자동 판정
  function applyTypes() {
    const raw = state.rawRows;
    const over = state.typeOver || {};
    const types = {};
    state.keys.forEach((k) => {
      const col = state.columns.get(k) || {};
      const autoType = col.type || inferType(k, raw);
      types[k] = { autoType, type: (over[k] && over[k].type) || autoType };
    });
    state.rows = raw.map((r) => {
      const o = {};
      for (const k of state.keys) if (k in r) o[k] = castValue(r[k], types[k].type);
      return o;
    });
    state.keyInfo = new Map();
    const total = state.rows.length;
    for (const k of state.keys) {
      const col = state.columns.get(k) || {};
      let filled = 0;
      const distinct = new Set();
      for (const r of state.rows) {
        if (!isBlank(r[k])) { filled++; distinct.add(display(r[k])); }
      }
      const autoId = col.role === 'id' ? true : (types[k].type === 'string' && total > 1 && filled === total && distinct.size === total);
      const userId = over[k] && typeof over[k].id === 'boolean' ? over[k].id : null;
      state.keyInfo.set(k, {
        label: col.label || null,
        type: types[k].type,
        autoType: types[k].autoType,
        filled,
        total,
        autoId,
        idLike: userId === null ? autoId : userId,
        overridden: !!over[k]
      });
    }
  }

  function loadTypes(sourceId) {
    try { const o = JSON.parse(store.get('types:' + sourceId) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }

  function saveTypes() {
    if (!state.source) return;
    if (Object.keys(state.typeOver).length) store.set('types:' + state.source.id, JSON.stringify(state.typeOver));
    else store.del('types:' + state.source.id);
  }

  // 이전 판에서 웹 앱 안 열기의 저장 이름에 화면 주소가 들어가 있던 것을 새 이름으로 옮김 (한 번만)
  function migrateEmbedKeys(id) {
    if (!/^server:embed(#|$)/.test(id) || store.get('layout:' + id) !== null) return;
    try {
      const ls = window.localStorage;
      const suffix = id.slice('server:embed'.length);
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        const m = k && k.match(/^duruboard:(layout|groups|types|title|aipol):server:embed:[^#]+(#.*)?$/);
        if (m && (m[2] || '') === suffix) store.set(m[1] + ':' + id, ls.getItem(k));
      }
    } catch (e) { /* 저장소 사용 불가 */ }
  }
  // keep: 같은 자료를 다시 불러올 때(새로 고침·자동 새로 고침) 현재 보드 구성과 분석 파트너 대화를 유지
  function loadData(parsed, source, keep) {
    const v = validate(parsed);
    const prevId = state.source ? state.source.id : null;
    const prevKeys = state.keys.join('\u0000');
    state.rawRows = v.rows;
    state.keys = v.keys;
    state.columns = v.columns;
    state.meta = v.meta;
    if (v.meta.id) source = Object.assign({}, source, { id: source.id + '#' + v.meta.id });
    state.source = source;
    state.typeOver = loadTypes(source.id);
    applyTypes();

    const same = keep && prevId === source.id;
    if (same) {
      pruneGroups();
      if (prevKeys !== state.keys.join('\u0000')) aiOnData(); else { aiAlias = aiAlias; renderAiSendSum(); }
      return { kept: true };
    }
    // 레이아웃: 이 기기에 저장된 것을 사용
    migrateEmbedKeys(source.id);
    state.layout = loadLayout(source.id);
    state.groups = loadGroups(source.id);
    pruneGroups();
    state.layoutFrom = 'local';
    aiOnData();
    return {};
  }

  // ───────────── 서버 연결 ─────────────
  // 연결 대상: 일반 서버(도메인 → /api/v1/data) 또는 Google Apps Script 웹 앱(…/exec 주소 전체)
  const GAS_RE = /^\/(?:a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/;
  function normalizeOrigin(input) {
    let s = (input || '').trim();
    if (!s) throw new Error('도메인 또는 웹 앱 주소를 입력하십시오.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch (e) { throw new Error('주소 형식이 올바르지 않습니다.'); }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
      throw new Error('HTTPS 주소만 사용할 수 있습니다. (시험용 localhost 제외)');
    }
    if (u.username || u.password) throw new Error('주소에 계정 정보를 넣을 수 없습니다.');
    if (u.hostname === 'script.google.com') {
      const path = u.pathname.replace(/\/$/, '');
      if (!GAS_RE.test(path)) throw new Error('Apps Script 웹 앱 주소는 …/macros/s/(배포 ID)/exec 형식이어야 합니다. 배포 관리에서 웹 앱 URL을 복사하십시오.');
      const dep = path.split('/s/')[1].split('/')[0];
      return { gas: true, origin: u.origin, url: u.origin + path, id: 'gas:' + dep, label: 'Apps Script 웹 앱 (' + dep.slice(0, 6) + '…' + dep.slice(-4) + ')' };
    }
    return { gas: false, origin: u.origin, url: u.origin + API_PATH, id: u.origin, label: u.origin };
  }

  function updatePreview() {
    let text = 'GET https://(도메인)' + API_PATH;
    try { const tg = normalizeOrigin($('in-domain').value); text = tg.gas ? 'POST ' + tg.url + ' (Apps Script 연결 방식)' : 'GET ' + tg.url; } catch (e) { /* 미리보기만 유지 */ }
    $('req-preview').textContent = text;
  }

  // 응답 본문의 오류 표시({ "error": { "status": 401, "message": "…" } })를 안내 문구로 변환
  function bodyError(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.error) return null;
    const st = Number(obj.error.status) || 0;
    const m = typeof obj.error.message === 'string' ? obj.error.message.slice(0, 200) : '';
    if (st === 401 || st === 403) return new Error('인증코드가 유효하지 않거나 권한이 없습니다. (' + st + ')' + (m ? ' ' + m : ''));
    if (st === 429) return new Error('요청이 너무 많습니다. 잠시 후 다시 시도하십시오.');
    return new Error('서버 오류가 발생했습니다.' + (st ? ' (' + st + ')' : '') + (m ? ' ' + m : ''));
  }

  async function fetchFromServer(target, code) {
    // 시간 초과는 별도 약속(Promise)으로 처리 (AbortSignal을 넘기지 못하는 환경 대비)
    let timer;
    const timeout = new Promise((_, r) => { timer = setTimeout(() => r(Object.assign(new Error('timeout'), { name: 'AbortError' })), FETCH_TIMEOUT_MS); });
    timeout.catch(() => {});
    // Apps Script: 인증코드를 본문으로 보내고(text/plain → 사전 요청 없음), googleusercontent로의 전달(리디렉션)만 허용
    const opt = target.gas
      ? { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ code, api: 'duruboard/v1' }), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'follow' }
      : { method: 'GET', headers: { 'Authorization': 'Bearer ' + code, 'Accept': 'application/json' }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' };
    let res;
    try {
      res = await Promise.race([fetch(target.url, opt), timeout]);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('응답 시간이 초과되었습니다. (' + FETCH_TIMEOUT_MS / 1000 + '초)');
      if (target.gas) throw new Error('웹 앱에 연결할 수 없습니다. 주소가 맞는지, 웹 앱을 액세스 권한 \'모든 사용자\'로 배포했는지 확인하십시오.');
      throw new Error('서버에 연결할 수 없습니다. 도메인, HTTPS 적용 여부, 서버의 CORS 허용 설정을 확인하십시오.');
    } finally {
      clearTimeout(timer);
    }
    if (target.gas) {
      let host = '';
      try { host = new URL(res.url).hostname; } catch (e) { host = ''; }
      if (host && !/^(script\.google\.com|script\.googleusercontent\.com)$/.test(host)) {
        throw new Error('웹 앱이 로그인 화면 등 다른 주소로 응답했습니다. 웹 앱을 액세스 권한 \'모든 사용자\'로 배포했는지 확인하십시오.');
      }
    }
    if (res.status === 401 || res.status === 403) throw new Error('인증코드가 유효하지 않거나 권한이 없습니다. (' + res.status + ')');
    if (res.status === 404) throw new Error('요청 경로(' + API_PATH + ')를 찾을 수 없습니다. 서버가 규격을 지원하는지 확인하십시오.');
    if (res.status === 429) throw new Error('요청이 너무 많습니다. 잠시 후 다시 시도하십시오.');
    if (!res.ok) throw new Error('서버 오류가 발생했습니다. (' + res.status + ')');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('응답 크기가 너무 큽니다. (최대 20MB)');
    let obj;
    try { obj = JSON.parse(text); } catch (e) {
      const se = specErr(target.gas && /^\s*</.test(text) ? '웹 앱이 JSON이 아닌 화면(HTML)을 응답했습니다. 배포 권한과 doPost 함수를 확인하십시오.' : '응답이 JSON 형식이 아닙니다.');
      se.got = '텍스트 (' + text.slice(0, 40).replace(/\s+/g, ' ') + (text.length > 40 ? '…' : '') + ')'; throw se;
    }
    const be = bodyError(obj);
    if (be) throw be;
    return obj;
  }

  // ───────────── Apps Script 웹 앱 안에서 열기 (내장 방식) ─────────────
  // Apps Script 웹 앱(HtmlService)이 이 화면을 불러와 보여 주는 경우, 다른 사이트로 요청하지 않고
  // 웹 앱의 함수 duruboardData()를 직접 호출하여 자료를 받음 (학교 계정 로그인으로 확인, 인증코드 불필요)
  const EMBED = (() => { try { return !!(window.google && window.google.script && window.google.script.run); } catch (e) { return false; } })();
  function gasData() {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('응답 시간이 초과되었습니다. (' + FETCH_TIMEOUT_MS / 1000 + '초)')); } }, FETCH_TIMEOUT_MS);
      window.google.script.run
        .withSuccessHandler((r) => {
          if (done) return; done = true; clearTimeout(timer);
          let obj = r;
          if (typeof r === 'string') {
            if (r.length > MAX_BYTES) { reject(new Error('응답 크기가 너무 큽니다. (최대 20MB)')); return; }
            try { obj = JSON.parse(r); } catch (e) { const se = specErr('응답이 JSON 형식이 아닙니다.'); se.got = '텍스트'; reject(se); return; }
          }
          const be = bodyError(obj);
          if (be) reject(be); else resolve(obj);
        })
        .withFailureHandler((e) => {
          if (done) return; done = true; clearTimeout(timer);
          const m = e && e.message ? String(e.message).slice(0, 200) : '';
          reject(new Error('웹 앱에서 자료를 가져오지 못하였습니다.' + (m ? ' (' + m + ')' : '') + ' 웹 앱에 duruboardData 함수가 있는지, 접속한 계정에 권한이 있는지 확인하십시오.'));
        })
        .duruboardData();
    });
  }
  // 웹 앱 안에서 열렸는데 그래프 도구(vendor/chart.umd.js)가 없으면(미게시·AMD 환경 등) 공개 CDN의 같은 파일을 무결성 확인 후 불러옴
  function ensureChartLib() {
    if (typeof window.Chart === 'function' || !EMBED) return;
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js';
    s.integrity = 'sha384-dug+JxfBvklEQdJ4AYuBBAIScUz0bVN73xpy273gcAwHjb3qI0fXmuYNaNfdyYJG';
    s.crossOrigin = 'anonymous';
    const amd = window.define;
    try { window.define = undefined; } catch (e) { /* 무시 */ }
    const restore = () => { try { window.define = amd; } catch (e) { /* 무시 */ } };
    s.onload = () => { restore(); if (typeof window.Chart === 'function' && state.source && !$('view-board').hidden) renderBoard(); };
    s.onerror = restore;
    document.head.append(s);
  }
  function initEmbed() {
    if (!EMBED || document.body.classList.contains('embedded')) return;
    ensureChartLib();
    document.body.classList.add('embedded');
    $('conn-lead').textContent = 'Apps Script 웹 앱에 연결되어 있습니다. [불러오기]를 누르면 웹 앱의 자료를 가져옵니다.';
    $('btn-fetch').textContent = '불러오기';
  }

  async function onFetch(isRefetch) {
    if (busy) return;
    if (EMBED) return onFetchEmbed();
    let origin, code;
    try {
      if (isRefetch) {
        origin = serverOrigin; code = authCode;
        if (!origin || !code) throw new Error('다시 조회할 연결 정보가 없습니다.');
      } else {
        origin = normalizeOrigin($('in-domain').value);
        code = $('in-code').value.trim();
        if (!code) throw new Error('인증코드를 입력하십시오.');
      }
    } catch (e) { setMsg(e.message, 'error'); return; }

    if (!isRefetch) {
      if ($('chk-save-domain').checked) store.set('domain', $('in-domain').value.trim());
      else store.del('domain');
    }

    busy = true;
    $('btn-fetch').disabled = true;
    $('btn-refresh').classList.add('spin');
    setMsg('자료를 조회하고 있습니다…');
    try {
      const parsed = await fetchFromServer(origin, code);
      const src = { id: 'server:' + origin.id, label: origin.label };
      if (await applyFetched(parsed, src, isRefetch)) {
        authCode = code;
        serverOrigin = origin;
      }
    } catch (e) {
      if (e.spec) { setMsg('자료 규격 오류: ' + e.message, 'error'); showSpecError(e, origin); }
      else setMsg(e.message, 'error');
    } finally {
      busy = false;
      $('btn-fetch').disabled = false;
      $('btn-refresh').classList.remove('spin');
    }
  }

  // ───────────── 받은 자료 반영 · 조회 시각 · 자동 새로 고침 ─────────────
  let lastPayload = '';
  let fetchedAt = null;
  let fetchFailed = false;
  let autoSec = 0;
  let autoTimer = null;
  let lastSrc = null;
  // 받은 자료를 화면에 반영. 같은 자료를 다시 받은 경우(새로 고침)는 보드 구성을 유지하고, 내용이 같으면 다시 그리지 않음
  async function applyFetched(parsed, src, refetch, silent) {
    const payload = JSON.stringify(parsed);
    const first = !$('view-connect').hidden;
    if (refetch && !first && payload === lastPayload && lastSrc && lastSrc.id === src.id) {
      markFetched(false);
      if (!silent) setMsg('자료를 다시 조회했습니다. 바뀐 내용이 없습니다.', 'ok');
      return true;
    }
    let info;
    try { info = loadData(parsed, src, refetch && !first); } catch (e) { if (e.spec) e.got = describeTop(parsed); throw e; }
    lastPayload = payload;
    lastSrc = src;
    markFetched(false);
    if (!silent) {
      let note = refetch && !first ? '자료를 다시 조회했습니다.' : '자료를 조회했습니다.';
      setMsg(note, 'ok');
    }
    if (first) await enterBoard();
    else if (silent) renderAll();
    else { closePop(); renderAll(); pulseFab(); }
    return true;
  }
  function markFetched(failed) {
    if (!failed) fetchedAt = new Date();
    fetchFailed = !!failed;
    renderFetched();
  }
  function renderFetched() {
    const box = $('fetched-at');
    if (!fetchedAt || !state.source) { box.hidden = true; return; }
    box.hidden = false;
    const tm = fetchedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const lab = autoSec ? ({ 30: '30초', 60: '1분', 300: '5분' })[autoSec] + '마다 자동' : '';
    box.replaceChildren();
    box.append(el('span', 'fetched-t', tm + ' 조회'));
    if (lab) box.append(el('span', 'fetched-a', lab));
    if (fetchFailed) box.append(el('span', 'fetched-e', '자동 조회 실패'));
    box.classList.toggle('err', fetchFailed);
    box.title = '마지막으로 자료를 가져온 시각' + (fetchFailed ? ' (최근 자동 조회는 실패)' : '');
  }
  // 편집 중(창이 열려 있음·끌기 중·탭이 가려짐)에는 자동 새로 고침을 건너뜀
  function autoBusy() {
    return busy || document.hidden || !!drag || !$('pop').hidden || !$('pop-export').hidden || !!document.querySelector('dialog[open]:not(#dlg-ai)');
  }
  async function autoTick() {
    if (!state.source || !serverOrigin || !lastSrc || autoBusy()) return;
    busy = true;
    $('btn-refresh').classList.add('spin');
    try {
      const parsed = EMBED ? await gasData() : await fetchFromServer(serverOrigin, authCode);
      await applyFetched(parsed, lastSrc, true, true);
    } catch (e) {
      markFetched(true);
    } finally {
      busy = false;
      $('btn-refresh').classList.remove('spin');
    }
  }
  function setAuto(sec) {
    autoSec = [0, 30, 60, 300].includes(sec) ? sec : 0;
    if (autoSec) store.set('autoRefresh', String(autoSec)); else store.del('autoRefresh');
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (autoSec) autoTimer = setInterval(autoTick, autoSec * 1000);
    $('auto-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.sec) === autoSec)));
    renderFetched();
  }
  function initAuto() {
    $('auto-seg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setAuto(Number(b.dataset.sec))));
    setAuto(Number(store.get('autoRefresh')) || 0);
    // 탭으로 돌아오면 간격이 지났을 때 바로 한 번 조회
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && autoSec && fetchedAt && Date.now() - fetchedAt.getTime() > autoSec * 1000) autoTick();
    });
  }

  async function onFetchEmbed() {
    busy = true;
    $('btn-fetch').disabled = true;
    $('btn-refresh').classList.add('spin');
    setMsg('자료를 불러오고 있습니다…');
    const target = { id: 'embed', label: 'Apps Script 웹 앱' };
    try {
      const parsed = await gasData();
      if (await applyFetched(parsed, { id: 'server:' + target.id, label: target.label }, !!state.source)) {
        authCode = 'embed';
        serverOrigin = target;
      }
    } catch (e) {
      if (e.spec) { setMsg('자료 규격 오류: ' + e.message, 'error'); showSpecError(e, { url: 'Apps Script 웹 앱 · duruboardData()' }); }
      else setMsg(e.message, 'error');
    } finally {
      busy = false;
      $('btn-fetch').disabled = false;
      $('btn-refresh').classList.remove('spin');
    }
  }

  // ───────────── 화면 전환 ─────────────
  async function enterBoard() {
    const card = $('view-connect');
    const rm = reducedMotion();

    // 1) 조회 결과 요약을 잠시 표시
    renderSummary($('intro-summary'));
    const dlg = $('dlg-summary');
    dlg.showModal();
    await new Promise((resolve) => {
      const done = () => { $('btn-summary-ok').onclick = null; dlg.oncancel = null; dlg.close(); resolve(); };
      $('btn-summary-ok').onclick = done;
      dlg.oncancel = (e) => { e.preventDefault(); done(); };
    });

    // 2) 연결 카드를 우측 상단 아이콘 쪽으로 접기
    if (!rm) {
      const r = card.getBoundingClientRect();
      const tx = window.innerWidth - 40;
      const ty = 44;
      card.style.setProperty('--dx', (tx - r.right) + 'px');
      card.style.setProperty('--dy', (ty - r.top) + 'px');
      card.classList.add('collapse');
      await wait(420);
    }
    card.hidden = true;
    card.classList.remove('collapse');

    // 3) 연결 입력란을 아이콘 창으로 옮기고 보드 표시
    $('pop-slot').append($('conn-form'));
    $('fab').hidden = false; $('btn-groups').hidden = false; $('btn-refresh').hidden = false; $('btn-wipe').hidden = false; $('fab-export').hidden = false;
    pulseFab();
    renderAll();
  }

  function pulseFab() {
    const f = $('fab');
    f.classList.remove('appear');
    void f.offsetWidth;
    f.classList.add('appear');
  }

  function renderAll() {
    $('view-board').hidden = false;
    renderBoardHead();
    renderSummary($('pop-summary'), true);
    renderBoard();
  }

  function openPop() {
    closeExport();
    renderSummary($('pop-summary'), true);
    $('pop').hidden = false;
    syncScrim();
    $('fab').setAttribute('aria-expanded', 'true');
  }

  // 창이 열리면 뒤를 흐리게 덮음
  function syncScrim() { $('pop-scrim').hidden = $('pop').hidden && $('pop-export').hidden; }
  function closePop() {
    $('pop').hidden = true;
    syncScrim();
    $('fab').setAttribute('aria-expanded', 'false');
  }

  function disconnect() {
    authCode = null;
    serverOrigin = null;
    $('in-code').value = '';
    destroyCharts();
    state.source = null; state.rows = []; state.rawRows = []; state.keys = []; state.typeOver = {}; state.keyInfo = new Map(); state.layout = []; state.groups = []; state.meta = {};
    closePop();
    closeExport();
    $('fab').hidden = true; $('btn-groups').hidden = true; $('btn-refresh').hidden = true; $('btn-wipe').hidden = true; $('fab-export').hidden = true; aiOnData(); lastPayload = ''; lastSrc = null; fetchedAt = null; renderFetched();
    $('view-board').hidden = true;
    $('conn-slot').append($('conn-form'));
    $('view-connect').hidden = false;
    setMsg('연결을 해제했습니다. 화면의 자료와 인증코드를 지웠습니다.', 'ok');
  }

  // ───────────── 자료 요약 ─────────────
  function summaryParts() {
    const parts = [];
    parts.push('서버 ' + state.source.label.replace(/^https:\/\//, ''));
    parts.push('행 ' + state.rows.length.toLocaleString('ko-KR') + '개');
    parts.push('키 ' + state.keys.length + '개');
    if (state.meta.updatedAt) parts.push('기준 시각 ' + state.meta.updatedAt.replace('T', ' ').replace(/(:\d\d)(\.\d+)?([+-]\d\d:\d\d|Z)?$/, '$1'));
    return parts;
  }

  function renderSummary(box, collapsible) {
    box.replaceChildren();
    if (!state.source) return;
    box.append(el('h3', 'sum-title', state.meta.title || '제목 없는 자료'));
    box.append(el('p', 'sub', summaryParts().join(' · ')));
    box.append(el('p', 'sum-note', '레이아웃: 이 기기 저장' +
      ' · 미입력 기준: 값 없음·null·빈 문자열 (0과 false는 입력으로 간주)'));
    const list = el('ul', 'key-list');
    let holder = box;
    if (collapsible) {
      const det = el('details', 'sum-keys');
      det.append(el('summary', null, '열별 입력 현황 (' + state.keys.length + '개)'));
      box.append(det);
      holder = det;
    }
    for (const k of state.keys) {
      const info = state.keyInfo.get(k);
      const li = el('li', 'key-item');
      const top = el('div', 'key-top');
      top.append(el('span', 'key-type', (info.idLike ? '식별·' : '') + (TYPE_LABEL[info.type] || '문자')));
      const name = el('span', 'key-name', labelOf(k));
      name.title = info.label ? info.label + ' (' + k + ')' : k;
      top.append(name);
      const rate = info.total ? info.filled / info.total : 0;
      top.append(el('span', 'key-rate', Math.round(rate * 100) + '%'));
      const bar = el('div', 'key-bar');
      const fill = el('i');
      fill.style.width = (rate * 100).toFixed(1) + '%';
      bar.append(fill);
      li.append(top, bar, el('div', 'key-stat', '입력 ' + info.filled + ' / ' + info.total));
      list.append(li);
    }
    holder.append(list);
  }

  function renderBoardHead() {
    $('board-title').textContent = store.get('title:' + state.source.id) || state.meta.title || state.source.label;
    $('board-sub-text').textContent = summaryParts().join(' · ');
  }

  function openPreview() {
    closePop();
    const table = $('pv-table');
    table.replaceChildren();
    const limit = Math.min(state.rows.length, 300);
    $('pv-sub').textContent = '전체 ' + state.rows.length.toLocaleString('ko-KR') + '행 중 ' + limit + '행을 표시합니다.';
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', null, '#'));
    state.keys.forEach((k) => hr.append(el('th', null, labelOf(k))));
    thead.append(hr);
    const tbody = el('tbody');
    for (let i = 0; i < limit; i++) {
      const tr = el('tr');
      tr.append(el('td', 'num', i + 1));
      for (const k of state.keys) {
        const v = state.rows[i][k];
        tr.append(el('td', isBlank(v) ? 'blank' : (typeof v === 'number' ? 'num' : null), isBlank(v) ? '·' : display(v)));
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    $('dlg-preview').showModal();
  }

  // 페이지 안의 확인 창 (브라우저 기본 확인 창을 쓰지 않습니다)
  function askConfirm(text, opt) {
    opt = opt || {};
    return new Promise((resolve) => {
      const dlg = $('dlg-confirm');
      $('cm-text').textContent = text;
      $('cm-ok').textContent = opt.ok || '확인';
      $('cm-ok').classList.toggle('danger', !!opt.danger);
      const done = (v) => { dlg.close(); $('cm-ok').onclick = null; $('cm-cancel').onclick = null; dlg.oncancel = null; resolve(v); };
      $('cm-ok').onclick = () => done(true);
      $('cm-cancel').onclick = () => done(false);
      dlg.oncancel = (e) => { e.preventDefault(); done(false); };
      dlg.showModal();
    });
  }

  // ───────────── 레이아웃 저장 ─────────────
  // 항목 설정 형식: { id, kind: 'chart'|'stat', title, mode: 'col'|'row', cols, label(행 기준 항목 이름 열), read, how, type, sort, width }
  const OLD_MEASURE = { filled: ['filled', 'sum'], blank: ['blank', 'sum'], fillrate: ['filled', 'avg'], sum: ['num', 'sum'], avg: ['num', 'avg'], max: ['num', 'max'], min: ['num', 'min'] };
  function sanitizeConfig(c) {
    if (!c || typeof c !== 'object') return null;
    let mode = c.mode, cols = c.cols, label = c.label, read = c.read, how = c.how;
    if (!mode && (c.x || c.values)) { // 이전 형식 1
      mode = c.x === KEYS_AXIS ? 'col' : 'row';
      cols = c.values; label = c.x === KEYS_AXIS ? '' : c.x;
      [read, how] = OLD_MEASURE[c.agg] || ['filled', 'sum'];
    }
    if (!read && c.measure) [read, how] = OLD_MEASURE[c.measure] || ['filled', 'sum']; // 이전 형식 2
    let pctOld = false;
    if (typeof c.pct !== 'boolean' && read !== 'num' && how === 'avg') { pctOld = true; how = 'sum'; } // 이전: 입력 여부 평균 = 비율
    return {
      id: typeof c.id === 'string' && /^[a-z0-9]{1,40}$/i.test(c.id) ? c.id : uid(),
      kind: c.kind === 'stat' ? 'stat' : 'chart',
      title: typeof c.title === 'string' ? c.title.slice(0, 100) : '',
      mode: mode === 'row' && c.kind !== 'stat' ? 'row' : 'col',
      cols: Array.isArray(cols) ? cols.filter((v) => typeof v === 'string').slice(0, MAX_KEYS) : [],
      label: typeof label === 'string' ? label : '',
      read: READS.some((x) => x.id === read) ? read : 'filled',
      how: COMBINES.some((x) => x.id === how) ? how : 'sum',
      type: CHART_TYPES.some((t) => t.id === c.type) ? c.type : 'bar',
      sort: ['none', 'desc', 'asc', 'label'].includes(c.sort) ? c.sort : 'none',
      width: c.width === 2 ? 2 : 1,
      hl: ['min', 'max'].includes(c.hl) ? c.hl : 'none',
      statRow: c.kind === 'stat' && ['full', 'gap'].includes(c.statRow) ? c.statRow : null,
      itemName: typeof c.itemName === 'string' ? c.itemName.slice(0, 40) : '',
      valueName: typeof c.valueName === 'string' ? c.valueName.slice(0, 40) : '',
      pct: c.pct === true || pctOld,
      filter: (() => { const f = sanitizeFilter(c.filter, 0); return f && f.items.length ? f : null; })(),
      range: sanitizeRange(c.range),
      align: ['left', 'center', 'right'].includes(c.align) ? c.align : null,
      color: sanitizeColor(c.color),
      pos: (() => {
        // 줄 안 시작 칸(반 칸 단위) — 화면에 놓이는 그래프 수(1~4)마다 따로 보관
        if (!c.pos || typeof c.pos !== 'object') return null;
        const o = {};
        ['1', '2', '3', '4'].forEach((k) => { const v = Number(c.pos[k]); if (Number.isInteger(v) && v >= 1 && v <= 8) o[k] = v; });
        return Object.keys(o).length ? o : null;
      })(),
      group: typeof c.group === 'string' && /^[\w-]{1,40}$/.test(c.group) ? c.group : null
    };
  }

  // 그룹 검증: 이름 필수, 최대 2단계(상위 그룹 아래에만 하위 그룹)
  function sanitizeGroups(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    const ids = new Set();
    arr.slice(0, MAX_BGROUPS).forEach((g) => {
      if (!g || typeof g.id !== 'string' || !/^[\w-]{1,40}$/.test(g.id) || ids.has(g.id)) return;
      const name = typeof g.name === 'string' ? g.name.trim().slice(0, 30) : '';
      if (!name) return;
      ids.add(g.id);
      out.push({ id: g.id, name, parent: typeof g.parent === 'string' ? g.parent : null, open: g.open !== false });
    });
    const top = new Set(out.filter((g) => !g.parent).map((g) => g.id));
    out.forEach((g) => { if (g.parent && !top.has(g.parent)) g.parent = null; });
    return out;
  }
  function pruneGroups() {
    const ids = new Set(state.groups.map((g) => g.id));
    state.layout.forEach((c) => { if (c.group && !ids.has(c.group)) c.group = null; });
  }
  function loadGroups(sourceId) {
    try { return sanitizeGroups(JSON.parse(store.get('groups:' + sourceId) || '[]')); } catch (e) { return []; }
  }

  // 그래프 색상 { base, point } — #rrggbb 형식만 허용
  const HEX = /^#[0-9a-fA-F]{6}$/;
  function sanitizeColor(c) {
    if (!c || typeof c !== 'object') return null;
    const o = {};
    if (HEX.test(c.base)) o.base = c.base.toLowerCase();
    if (HEX.test(c.point)) o.point = c.point.toLowerCase();
    return o.base || o.point ? o : null;
  }

  function loadLayout(sourceId) {
    const raw = store.get('layout:' + sourceId);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(sanitizeConfig).filter(Boolean).slice(0, MAX_CHARTS) : [];
    } catch (e) { return []; }
  }

  function saveLayout() {
    if (!state.source) return;
    // 개체를 모두 지운 경우도 '빈 레이아웃'으로 저장하여, 다음에 서버 레이아웃으로 바뀌지 않게 함
    store.set('layout:' + state.source.id, JSON.stringify(state.layout));
    if (state.groups.length) store.set('groups:' + state.source.id, JSON.stringify(state.groups));
    else store.del('groups:' + state.source.id);
  }

  // ───────────── 레이아웃 내보내기·불러오기 ─────────────
  // 파일 형식: { app: 'duruboard', version: 2, exportedAt, source, items: [개체 설정] }
  let importBuf = [];
  let importTypes = {};
  let importGroups = [];
  let importAi = null;

  const kindText = (cfg) => (cfg.kind === 'stat' ? '통계 · ' + ((STYPES.find((t) => t.id === stypeOf(cfg)) || {}).label || '') : '그래프·표 · ' + ((CHART_TYPES.find((t) => t.id === cfg.type) || {}).label || ''));

  function openExport() {
    closePop();
    renderGlobalColors();
    document.querySelectorAll('#pop-export .ex-data').forEach((s) => { s.hidden = !state.source; });
    const list = $('ex-list');
    list.replaceChildren();
    if (!state.layout.length) list.append(el('li', 'hint', '내보낼 개체가 없습니다.'));
    state.layout.forEach((cfg) => {
      const li = el('li');
      const lab = el('label', 'check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = cfg.id;
      cb.checked = true;
      lab.append(cb, el('span', null, (cfg.title || autoTitle(cfg)) + ' · ' + kindText(cfg)));
      li.append(lab);
      list.append(li);
    });
    msgTo('ex-msg', '');
    msgTo('im-msg', '');
    $('pop-export').hidden = false;
    syncScrim();
    $('fab-export').setAttribute('aria-expanded', 'true');
  }

  function closeExport() {
    $('pop-export').hidden = true;
    syncScrim();
    $('fab-export').setAttribute('aria-expanded', 'false');
  }

  function msgTo(id, text, kind) {
    $(id).textContent = text;
    $(id).className = 'msg' + (kind ? ' ' + kind : '');
  }

  function exportFile() {
    const ids = new Set(Array.from($('ex-list').querySelectorAll('input:checked')).map((c) => c.value));
    const items = state.layout.filter((c) => ids.has(c.id));
    if (!items.length) { msgTo('ex-msg', '개체를 하나 이상 선택하십시오.', 'error'); return; }
    const payload = {
      app: 'duruboard',
      version: 2,
      exportedAt: new Date().toISOString(),
      source: state.meta.title || '',
      types: state.typeOver,
      groups: state.groups.filter((g) => items.some((c) => c.group === g.id || (state.groups.find((x) => x.id === c.group) || {}).parent === g.id)),
      items
    };
    // 분석 파트너: 공급자·모델·열별 전송 설정만 담음 (인증 키는 절대 포함하지 않음)
    if ($('ex-ai').checked) payload.ai = aiExport();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'duruboard-layout-' + stamp + '.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    msgTo('ex-msg', a.download + ' 파일을 저장하였습니다. (개체 ' + items.length + '개)', 'ok');
  }

  async function readLayoutFile(file) {
    if (!file) return;
    $('im-box').hidden = true;
    try {
      if (file.size > 1024 * 1024) throw new Error('파일 크기가 너무 큽니다. (최대 1MB)');
      let obj;
      try { obj = JSON.parse(await file.text()); } catch (e) { throw new Error('JSON 형식이 아닌 파일입니다.'); }
      const raw = Array.isArray(obj) ? obj : (obj && (obj.items || obj.charts));
      if (!Array.isArray(raw)) throw new Error('두루보드 레이아웃 파일이 아닙니다.');
      importBuf = raw.map(sanitizeConfig).filter(Boolean).slice(0, MAX_CHARTS);
      importTypes = obj && obj.types && typeof obj.types === 'object' && !Array.isArray(obj.types) ? obj.types : {};
      importGroups = sanitizeGroups(obj && obj.groups);
      importAi = aiSanitizeImport(obj && obj.ai);
      if (!importBuf.length) throw new Error('적용할 수 있는 개체가 없습니다.');
      renderImportList(file.name, obj && obj.source);
      msgTo('im-msg', '');
    } catch (e) {
      importBuf = [];
      msgTo('im-msg', e.message, 'error');
    }
  }

  function renderImportList(name, source) {
    $('im-file').textContent = name + (source ? ' · 원자료: ' + source : '') + ' · 개체 ' + importBuf.length + '개';
    const list = $('im-list');
    list.replaceChildren();
    const have = new Set(state.keys);
    importBuf.forEach((cfg, i) => {
      const need = cfg.cols.concat(!isStat(cfg) && cfg.mode === 'row' ? [cfg.label] : []);
      const miss = need.filter((k) => k && !have.has(k));
      const li = el('li', 'im-item');
      const lab = el('label', 'check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = String(i);
      cb.checked = miss.length === 0;
      const text = el('span');
      text.append(el('span', null, (cfg.title || autoTitle(cfg)) + ' · ' + kindText(cfg)));
      text.append(el('small', miss.length ? 'im-warn' : 'im-ok', miss.length ? '현재 자료에 없는 열: ' + miss.join(', ') : '적용 가능'));
      lab.append(cb, text);
      li.append(lab);
      list.append(li);
    });
    $('im-ai-row').hidden = !importAi;
    if (importAi) {
      const pc = Object.keys(importAi.columns || {}).length;
      $('im-ai-desc').textContent = '(' + AI_PROVIDERS[importAi.provider].label + (importAi.model ? ' · ' + importAi.model : '') + (pc ? ' · 열별 전송 설정 ' + pc + '개' : '') + ')';
      $('im-ai').checked = true;
    }
    $('im-box').hidden = false;
  }

  function selectedImports() {
    return Array.from($('im-list').querySelectorAll('input:checked')).map((c) => importBuf[Number(c.value)]).filter(Boolean)
      .map((c) => Object.assign({}, c, { id: uid() }));
  }

  async function applyImport(replace) {
    const items = selectedImports();
    if (!items.length) { msgTo('im-msg', '적용할 개체를 하나 이상 선택하십시오.', 'error'); return; }
    if (replace) {
      closeExport();
      if (state.layout.length && !(await askConfirm('현재 레이아웃을 선택한 개체 ' + items.length + '개로 교체합니다. 계속하시겠습니까?'))) return;
      state.layout = items;
      state.groups = [];
    }
    // 파일의 그룹은 이름이 같은 그룹에 합치고, 없으면 새로 만듦
    const gmap = {};
    importGroups.filter((g) => !g.parent).concat(importGroups.filter((g) => g.parent)).forEach((g) => {
      const parent = g.parent ? gmap[g.parent] || null : null;
      if (g.parent && !parent) return;
      const ex = state.groups.find((x) => x.name === g.name && x.parent === parent);
      if (ex) { gmap[g.id] = ex.id; return; }
      if (state.groups.length >= MAX_BGROUPS) return;
      const ng = { id: uid(), name: g.name, parent, open: true };
      state.groups.push(ng);
      gmap[g.id] = ng.id;
    });
    items.forEach((c) => { c.group = c.group ? gmap[c.group] || null : null; });
    if (replace) {
      // 위에서 처리
    } else {
      state.layout = state.layout.concat(items).slice(0, MAX_CHARTS);
    }
    state.layoutFrom = 'local';
    // 파일에 담긴 열 자료형 지정 중 현재 자료에 있는 열만 적용
    Object.keys(importTypes).forEach((k) => {
      const o = importTypes[k];
      if (!state.keys.includes(k) || !o || typeof o !== 'object') return;
      const v = {};
      if (TYPE_LABEL[o.type]) v.type = o.type;
      if (typeof o.id === 'boolean') v.id = o.id;
      if (Object.keys(v).length) state.typeOver[k] = v;
    });
    applyTypes();
    saveTypes();
    saveLayout();
    const aiApplied = importAi && $('im-ai').checked && aiApplyImport(importAi);
    renderBoard();
    renderSummary($('pop-summary'), true);
    if (!replace) msgTo('im-msg', '개체 ' + items.length + '개를 추가하였습니다.' + (aiApplied ? ' 분석 파트너 설정도 적용하였습니다.' : ''), 'ok');
  }

  // ───────────── 계산 ─────────────
  // 칸 값 해석: num(숫자 값) / filled(입력 여부, 입력=1) / blank(미입력 여부, 미입력=1)
  function readCell(v, read, type) {
    if (read === 'filled') return isBlank(v) ? 0 : 1;
    if (read === 'blank') return isBlank(v) ? 1 : 0;
    return numericOf(v, type);
  }
  const tyOf = (k) => (state.keyInfo.get(k) || {}).type;

  // 집계 방식: sum / avg / max / min
  function combine(vals, how) {
    const nums = vals.filter((n) => n !== null && n !== undefined);
    // 값이 하나도 없으면(미응시 등) 0이 아니라 '값 없음'
    if (!nums.length) return null;
    if (how === 'sum') return nums.reduce((a, b) => a + b, 0);
    if (how === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
    if (how === 'max') return Math.max.apply(null, nums);
    if (how === 'min') return Math.min.apply(null, nums);
    return null;
  }

  const readLabel = (id) => (READS.find((x) => x.id === id) || {}).label || id;
  const combineLabel = (id) => (COMBINES.find((x) => x.id === id) || {}).label || id;
  // 비율(%) 표시: 열별 개별 표시와 수치 통계에는 사용하지 않음
  // 통계의 숫자 평균은 0·1 자료(작성 여부 등)일 때 백분율로 표시할 수 있음
  const canPct = (cfg) => effHow(cfg) !== 'each' && !(isStat(cfg) && cfg.read === 'num' && effHow(cfg) !== 'avg');
  const isPercent = (cfg) => !!cfg.pct && !cfg.statRow && canPct(cfg);
  const isStat = (cfg) => cfg.kind === 'stat';
  const effHow = (cfg) => (cfg.how === 'each' && (isStat(cfg) || cfg.mode === 'col') ? 'sum' : cfg.how);

  // 값의 의미
  function metricLabel(cfg) {
    const how = effHow(cfg);
    const pct = isPercent(cfg);
    if (cfg.read === 'filled') {
      if (pct) return '입력률(%)';
      return { sum: '입력 칸 수', avg: '입력 여부 평균', each: '입력 여부 (입력=1)' }[how] || '입력 칸 수';
    }
    if (cfg.read === 'blank') {
      if (pct) return '미입력률(%)';
      return { sum: '미입력 칸 수', avg: '미입력 여부 평균', each: '미입력 여부 (미입력=1)' }[how] || '미입력 칸 수';
    }
    const base = { sum: '합계', avg: '평균', max: '최댓값', min: '최솟값', each: '값' }[how];
    return pct ? base + ' 비율(%)' : base;
  }

  // 비율 계산식 설명
  function pctFormula(cfg) {
    if (cfg.read === 'num') return effHow(cfg) === 'avg' ? '평균 × 100 (값이 0~1인 경우) 또는 값 ÷ 가장 큰 항목의 값 × 100' : '값 ÷ 가장 큰 항목의 값 × 100';
    const what = cfg.read === 'filled' ? '입력 칸' : '미입력 칸';
    return effHow(cfg) === 'sum' ? what + ' 수 ÷ 전체 칸 수 × 100' : '평균 × 100';
  }

  // 받침 유무에 따른 조사 선택 (예: 합계를, 입력률을)
  function josa(word, withFinal, withoutFinal) {
    const c = String(word).replace(/\s*\([^)]*\)\s*$/, '').trim().slice(-1).charCodeAt(0);
    if (c < 0xAC00 || c > 0xD7A3) return word + withFinal + '(' + withoutFinal + ')';
    return word + ((c - 0xAC00) % 28 ? withFinal : withoutFinal);
  }

  function colsText(cols) {
    const names = cols.map(labelOf);
    if (names.length <= 3) return names.join(', ');
    return names[0] + ' 외 ' + (names.length - 1) + '개';
  }

  function selCols(cfg) { return cfg.cols.filter((k) => !(!isStat(cfg) && cfg.mode === 'row' && k === cfg.label)); }

  // 결과: 그래프 { labels, series, warnings, merged, cols, rowKeyOf } / 통계 { value, cells, warnings, cols }
  // ───────────── 대상 행 조건 (그리고·또는·제외) ─────────────
  const CMPS = { eq: '=', ne: '≠', lt: '<', le: '≤', gt: '>', ge: '≥', has: '포함', nhas: '미포함', empty: '빈칸', filled: '입력됨' };
  const CMP_SYM = { eq: '=', ne: '≠', lt: '<', le: '≤', gt: '>', ge: '≥', has: '포함', nhas: '미포함' };
  function cmpsFor(ty) {
    if (ty === 'number') return ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'empty', 'filled'];
    if (ty === 'boolean') return ['eq', 'ne', 'empty', 'filled'];
    if (ty === 'mixed') return ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'has', 'nhas', 'empty', 'filled'];
    return ['eq', 'ne', 'has', 'nhas', 'empty', 'filled'];
  }
  const isGroup = (n) => !!n && typeof n === 'object' && Array.isArray(n.items);
  const noVal = (cmp) => cmp === 'empty' || cmp === 'filled';
  const filterOn = (cfg) => isGroup(cfg.filter) && cfg.filter.items.length > 0;
  function rawStr(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? '참' : '거짓';
    return String(v).trim();
  }
  function evalCond(c, r) {
    const v = r[c.col];
    if (c.kind === 'vals') {
      const hit = isBlank(v) ? !!c.blank : (c.vals || []).includes(rawStr(v));
      return c.not ? !hit : hit;
    }
    if (c.kind === 'range') {
      const a = typeof v === 'number' ? v : typeof v === 'string' ? parseNumStr(v) : null;
      if (a === null) return false;
      const hit = (c.lo == null || a >= c.lo) && (c.hi == null || a <= c.hi);
      return c.not ? !hit : hit;
    }
    if (c.cmp === 'empty') return isBlank(v);
    if (c.cmp === 'filled') return !isBlank(v);
    const want = String(c.val == null ? '' : c.val).trim();
    if (c.cmp === 'has' || c.cmp === 'nhas') { const h = want !== '' && rawStr(v).includes(want); return c.cmp === 'has' ? h : !h; }
    const a = typeof v === 'number' ? v : typeof v === 'string' ? parseNumStr(v) : null;
    const b = parseNumStr(want);
    if (c.cmp === 'eq' || c.cmp === 'ne') {
      const same = a !== null && b !== null ? a === b : rawStr(v) === want;
      return c.cmp === 'eq' ? same : !same;
    }
    if (a === null || b === null) return false;
    return c.cmp === 'lt' ? a < b : c.cmp === 'le' ? a <= b : c.cmp === 'gt' ? a > b : a >= b;
  }
  function evalNode(n, r) {
    if (isGroup(n)) {
      const res = !n.items.length ? true : n.op === 'or' ? n.items.some((x) => evalNode(x, r)) : n.items.every((x) => evalNode(x, r));
      return n.not ? !res : res;
    }
    return evalCond(n, r);
  }
  function filterCols(n, out) {
    out = out || [];
    if (isGroup(n)) n.items.forEach((x) => filterCols(x, out)); else if (n && n.col) out.push(n.col);
    return out;
  }
  // 열 필터 요약 (목록·카드 설명용)
  function fmtNum(n) { return n == null ? '' : (Math.round(n * 100) / 100).toLocaleString('ko-KR'); }
  function ffSummary(c) {
    if (c.kind === 'vals') {
      const vs = (c.vals || []).slice();
      if (c.blank) vs.push('(빈칸)');
      const s = vs.length ? vs.slice(0, 3).join(', ') + (vs.length > 3 ? ' 외 ' + (vs.length - 3) + '개' : '') : '선택 없음';
      return c.not ? s + ' 제외' : s;
    }
    if (c.kind === 'range') return fmtNum(c.lo) + ' ~ ' + fmtNum(c.hi) + (c.not ? ' 밖' : '');
    return '';
  }
  function exprText(n, top) {
    if (isGroup(n)) {
      const parts = n.items.map((x) => exprText(x, false)).filter(Boolean);
      if (!parts.length) return '';
      const s = parts.join(n.op === 'or' ? ' 또는 ' : n.items.every((x) => x.kind) ? ' / ' : ' 그리고 ');
      if (n.not) return '부정(' + s + ')';
      return top || parts.length < 2 ? s : '(' + s + ')';
    }
    const nm = labelOf(n.col);
    if (n.kind) return nm + ': ' + ffSummary(n);
    if (noVal(n.cmp)) return nm + ' ' + CMPS[n.cmp];
    const v = String(n.val == null ? '' : n.val).trim() || '(빈 값)'; // 이전 형식 조건
    return n.cmp === 'has' || n.cmp === 'nhas' ? nm + ' ‘' + v + '’ ' + CMP_SYM[n.cmp] : nm + ' ' + CMP_SYM[n.cmp] + ' ' + v;
  }
  function sanitizeFilter(n, depth) {
    if (!isGroup(n) || depth > 3) return null;
    const items = n.items.slice(0, 30).map((x) => (isGroup(x) ? sanitizeFilter(x, depth + 1) : sanitizeCond(x))).filter(Boolean);
    return { op: n.op === 'or' ? 'or' : 'and', not: n.not === true, items };
  }
  function sanitizeCond(c) {
    if (!c || typeof c !== 'object' || typeof c.col !== 'string') return null;
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    if (c.kind === 'vals') return { col: c.col.slice(0, 200), kind: 'vals', not: c.not === true, blank: c.blank === true, vals: Array.isArray(c.vals) ? c.vals.filter((x) => typeof x === 'string').slice(0, 500).map((x) => x.slice(0, 100)) : [] };
    if (c.kind === 'range') return { col: c.col.slice(0, 200), kind: 'range', not: c.not === true, lo: num(c.lo), hi: num(c.hi) };
    if (!CMPS[c.cmp]) return null;
    return { col: c.col.slice(0, 200), cmp: c.cmp, val: typeof c.val === 'number' ? String(c.val) : typeof c.val === 'string' ? c.val.slice(0, 100) : '' };
  }
  function sanitizeRange(g) {
    if (!g || typeof g !== 'object' || !['top', 'bottom', 'le', 'ge'].includes(g.mode)) return null;
    const n = Number(g.n);
    if (!Number.isFinite(n) || n < 0) return null;
    return { mode: g.mode, n, unit: g.unit === 'cnt' ? 'cnt' : 'pct' };
  }
  function rangeText(cfg) {
    const g = cfg.range;
    if (!g) return '';
    const u = g.mode === 'top' || g.mode === 'bottom' ? (g.unit === 'cnt' ? '개' : '%') : (isPercent(cfg) ? '%' : '');
    return { top: '상위 ', bottom: '하위 ', le: '≤ ', ge: '≥ ' }[g.mode] + g.n + u;
  }

  // 상위·하위·이하·이상으로 남길 위치 고르기 (값이 null인 항목은 제외)
  function pickRange(d, rg) {
    const idx = d.map((_, i) => i).filter((i) => d[i] !== null && d[i] !== undefined);
    if (rg.mode === 'le' || rg.mode === 'ge') return idx.filter((i) => (rg.mode === 'le' ? d[i] <= rg.n : d[i] >= rg.n));
    idx.sort((a, b) => (rg.mode === 'top' ? d[b] - d[a] : d[a] - d[b]));
    const k = rg.unit === 'pct' ? Math.ceil(idx.length * Math.min(100, rg.n) / 100) : Math.min(Math.floor(rg.n), idx.length);
    if (k <= 0) return [];
    const edge = d[idx[k - 1]];
    return idx.filter((i) => (rg.mode === 'top' ? d[i] >= edge : d[i] <= edge)).sort((a, b) => a - b);
  }

  function compute(cfg, opts) {
    opts = opts || {};
    const allRows = state.rows;
    const fOn = filterOn(cfg);
    let rows = fOn ? allRows.filter((r) => evalNode(cfg.filter, r)) : allRows;
    const have = new Set(state.keys);
    const warnings = [];
    if (fOn) {
      const miss = Array.from(new Set(filterCols(cfg.filter))).filter((k) => !have.has(k));
      if (miss.length) warnings.push('조건에 쓰인 열 중 자료에 없는 열이 있습니다: ' + miss.join(', '));
    }
    const missing = cfg.cols.filter((k) => !have.has(k));
    if (missing.length) warnings.push('자료에 없는 열을 제외하였습니다: ' + missing.join(', '));
    const cols = selCols(cfg).filter((k) => have.has(k));
    const row = !isStat(cfg) && cfg.mode === 'row';
    const colStep = !isStat(cfg) && cfg.mode === 'col' ? 'step-item' : 'step-value';
    if (!cols.length) return { error: '사용할 열을 하나 이상 선택하십시오.', fix: colStep };
    if (row && !have.has(cfg.label)) return { error: '항목 축에 넣을 항목을 선택하십시오.', fix: 'step-item' };
    if (!rows.length) return { error: '조건에 맞는 행이 없습니다. 조건을 확인하십시오.', fix: 'step-filter' };
    // 숫자 계산(평균·합계·최댓값·최솟값)은 숫자 열에서만 가능
    if (cfg.read === 'num' && !cfg.statRow) {
      const hn = { avg: '평균', sum: '합계', max: '최댓값', min: '최솟값', each: '합계' }[cfg.how] || '숫자 계산';
      const tc = cols.filter((k) => tyOf(k) === 'string').map(labelOf);
      if (tc.length) return { error: '문자 열(' + tc.slice(0, 3).join(', ') + (tc.length > 3 ? ' 외 ' + (tc.length - 3) + '개' : '') + ')이 포함되어 ' + josa(hn, '을', '를') + ' 계산할 수 없습니다. 숫자 열만 선택하거나, 열을 길게 눌러 자료형을 변경하십시오.', fix: colStep };
      if (!rows.some((r) => cols.some((k) => numericOf(r[k], tyOf(k)) !== null))) return { error: '선택한 열에 숫자 값이 없어 ' + josa(hn, '을', '를') + ' 계산할 수 없습니다.', fix: colStep };
    }
    const base = { rows, rowsN: rows.length, rowsAll: allRows.length };
    const how = effHow(cfg);
    const pct = isPercent(cfg);
    // 입력 여부 해석의 최댓값: 합계는 칸 수, 그 밖은 1
    const possible = (cellsN) => (how === 'sum' ? cellsN : 1);
    const ratio = (v, cellsN) => (v === null || !cellsN ? null : v / possible(cellsN) * 100);

    // 산출 범위 (통계·열별): 행마다 값을 구해 상위·하위 등 일부 행만 사용
    let rangeInfo = null;
    const rg = cfg.range;
    if (rg && !row) {
      const hw = how === 'each' ? 'sum' : how;
      const vals = rows.map((r) => {
        const v = combine(cols.map((k) => readCell(r[k], cfg.read, tyOf(k))), hw);
        return pct && cfg.read !== 'num' ? ratio(v, cols.length) : v;
      });
      const keep = pickRange(vals, rg);
      rangeInfo = { before: rows.length, after: keep.length, unit: '행' };
      if (!keep.length) return { error: '산출 범위(' + rangeText(cfg) + ')에 해당하는 행이 없습니다.' };
      rows = keep.map((i) => rows[i]);
    }

    if (isStat(cfg) && cfg.statRow) {
      const full = rows.filter((r) => cols.every((k) => !isBlank(r[k]))).length;
      return Object.assign({ value: cfg.statRow === 'full' ? full : rows.length - full, cells: rows.length * cols.length, rowCount: rows.length, warnings, cols, rangeInfo }, base, { rows });
    }
    if (isStat(cfg)) {
      const cells = rows.flatMap((r) => cols.map((k) => readCell(r[k], cfg.read, tyOf(k))));
      const v = combine(cells, how);
      return Object.assign({ value: pct ? ratio(v, cells.length) : v, cells: cells.length, warnings, cols, rangeInfo }, base, { rows });
    }

    const rowKeyOf = (r) => (isBlank(r[cfg.label]) ? '(빈칸)' : display(r[cfg.label]));
    let labels, series, merged = false;
    if (!row) {
      labels = cols.map(labelOf);
      series = [{ name: metricLabel(cfg), data: cols.map((k) => combine(rows.map((r) => readCell(r[k], cfg.read, tyOf(k))), how)), cellsN: cols.map(() => rows.length) }];
    } else {
      const groups = new Map();
      for (const r of rows) {
        const g = rowKeyOf(r);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r);
      }
      merged = groups.size < rows.length;
      labels = Array.from(groups.keys());
      const grs = Array.from(groups.values());
      if (how === 'each') {
        series = cols.map((k) => ({ name: labelOf(k), data: grs.map((g) => combine(g.map((r) => readCell(r[k], cfg.read, tyOf(k))), 'sum')) }));
      } else {
        series = [{ name: metricLabel(cfg), data: grs.map((g) => combine(g.flatMap((r) => cols.map((k) => readCell(r[k], cfg.read, tyOf(k)))), how)), cellsN: grs.map((g) => g.length * cols.length) }];
      }
    }
    // 비율(%) 환산
    if (pct && series.length === 1) {
      const sr = series[0];
      if (cfg.read === 'num') {
        const mx = Math.max.apply(null, sr.data.filter((v) => v !== null).concat([0]));
        // 0·1 자료(작성 여부 등)의 평균은 평균 × 100, 그 밖에는 가장 큰 항목 대비 비율
        if (how === 'avg' && mx <= 1) sr.data = sr.data.map((v) => (v === null ? null : v * 100));
        else sr.data = sr.data.map((v) => (v === null || mx <= 0 ? null : v / mx * 100));
      } else {
        sr.data = sr.data.map((v, i) => ratio(v, sr.cellsN[i]));
      }
    }
    series = series.map((x) => ({ name: x.name, data: x.data }));

    // 산출 범위 (행 기준): 집계한 값으로 항목 거르기
    if (row && rg) {
      const d = labels.map((_, i) => (series.length === 1 ? series[0].data[i] : series.reduce((s, x) => s + (x.data[i] || 0), 0)));
      const keep = pickRange(d, rg);
      rangeInfo = { before: labels.length, after: keep.length, unit: '개', kept: new Set(keep.map((i) => labels[i])) };
      if (!keep.length && cfg.type !== 'list') return { error: '산출 범위(' + rangeText(cfg) + ')에 해당하는 항목이 없습니다.' };
      labels = keep.map((i) => labels[i]);
      series = series.map((s) => ({ name: s.name, data: keep.map((i) => s.data[i]) }));
    }

    if (!opts.noSort && cfg.sort !== 'none') {
      const idx = labels.map((_, i) => i);
      const tot = (i) => series.reduce((a, s) => a + (s.data[i] === null ? 0 : s.data[i]), 0);
      if (cfg.sort === 'desc') idx.sort((a, b) => tot(b) - tot(a));
      else if (cfg.sort === 'asc') idx.sort((a, b) => tot(a) - tot(b));
      else idx.sort((a, b) => labels[a].localeCompare(labels[b], 'ko', { numeric: true }));
      labels = idx.map((i) => labels[i]);
      series = series.map((s) => ({ name: s.name, data: idx.map((i) => s.data[i]) }));
    }
    if (cfg.type === 'hist' && !opts.noSort) {
      if (!row || series.length !== 1) return { error: '히스토그램은 행 기준·단일 값에서 사용할 수 있습니다.' };
      return Object.assign(histogram(series[0].data, cfg), { warnings, merged, cols, rowKeyOf, hist: true, rangeInfo }, base);
    }
    if (labels.length > MAX_GROUPS) {
      warnings.push('항목이 많아 상위 ' + MAX_GROUPS + '개만 표시합니다. (전체 ' + labels.length + '개)');
      labels = labels.slice(0, MAX_GROUPS);
      series = series.map((s) => ({ name: s.name, data: s.data.slice(0, MAX_GROUPS) }));
    }
    return Object.assign({ labels, series, warnings, merged, cols, rowKeyOf, rangeInfo }, base, { rows, rowsN: base.rowsN });
  }

  // 값 분포: 구간별 항목(행) 수
  function histogram(values, cfg) {
    const vals = values.filter((v) => v !== null && Number.isFinite(v));
    if (!vals.length) return { labels: [], series: [{ name: '항목 수', data: [] }] };
    const pct = isPercent(cfg);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const ints = vals.every((v) => Number.isInteger(v));
    let edges = [];
    if (pct) { lo = 0; hi = 100; for (let x = 0; x <= 100; x += 10) edges.push(x); }
    else if (ints && hi - lo <= 20) {
      const labels = [], data = [];
      for (let x = lo; x <= hi; x++) { labels.push(fmtVal(x, cfg)); data.push(vals.filter((v) => v === x).length); }
      return { labels, series: [{ name: '항목 수', data }] };
    } else {
      const k = Math.min(12, Math.max(4, Math.ceil(Math.log2(vals.length) + 1)));
      const raw = (hi - lo) / k || 1;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
      const start = Math.floor(lo / step) * step;
      for (let x = start; x <= hi + step * 1e-9; x += step) edges.push(+x.toFixed(10));
      if (edges[edges.length - 1] <= hi) edges.push(+(edges[edges.length - 1] + step).toFixed(10));
    }
    const labels = [], data = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const a = edges[i], b = edges[i + 1], last = i === edges.length - 2;
      labels.push(fmtVal(a, cfg) + '~' + fmtVal(b, cfg));
      data.push(vals.filter((v) => v >= a && (last ? v <= b : v < b)).length);
    }
    return { labels, series: [{ name: '항목 수', data }] };
  }

  function fmtVal(n, cfg) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    const r = Math.round(n * 10) / 10;
    return r.toLocaleString('ko-KR') + (isPercent(cfg) ? '%' : '');
  }

  // ───────────── 아이콘 ─────────────
  const ICONS = {
    left: ['M15 18l-6-6 6-6'],
    more: ['C5 12 1.4', 'C12 12 1.4', 'C19 12 1.4'],
    copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
    folder: ['M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    fmove: ['M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 13.5h6.5', 'M13 11l2.5 2.5-2.5 2.5'],
    plus: ['M12 5v14', 'M5 12h14'],
    rename: ['M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3'],
    up: ['M12 19V5', 'M6 11l6-6 6 6'],
    down: ['M12 5v14', 'M6 13l6 6 6-6'],
    right: ['M9 18l6-6-6-6'],
    edit: ['M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3', 'M13.5 7.5l3 3'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
    chev: ['M6 9l6 6 6-6'],
    check: ['M5 12l5 5 9-10'],
    swap: ['M7 4v16', 'M4 7l3-3 3 3', 'M17 20V4', 'M14 17l3 3 3-3'],
    tbar: ['M6 20V12', 'M12 20V5', 'M18 20V14'],
    thbar: ['M4 6h10', 'M4 12h16', 'M4 18h7'],
    tline: ['M3 17l6-6 4 4 8-8'],
    thist: ['M3 20h18', 'M4 20v-6h4v6', 'M8 20V8h4v12', 'M12 20v-9h4v9', 'M16 20v-4h4v4'],
    ttable: ['M4 5h16v14H4z', 'M4 10h16', 'M4 15h16', 'M10 5v14'],
    tlist: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'C5 6 1', 'C5 12 1', 'C5 18 1'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2']
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    ICONS[name].forEach((d) => {
      if (d[0] === 'C') {
        const [cx, cy, r] = d.slice(1).split(' ');
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
        svg.append(c);
      } else {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', d);
        svg.append(p);
      }
    });
    return svg;
  }

  // ───────────── 보드 ─────────────
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function destroyCharts() {
    state.charts.forEach((c) => c && c.destroy());
    state.charts.clear();
  }

  function describe(cfg) {
    const cond = filterOn(cfg) ? ' · 조건: ' + exprText(cfg.filter, true) : '';
    if (isStat(cfg)) return colsText(selCols(cfg)) + ' · ' + valueName(cfg) + cond + (cfg.range ? ' · 범위: ' + rangeText(cfg) : '');
    const head = cfg.mode === 'row' ? labelOf(cfg.label) + '별 · ' : '열별 · ';
    const rg = cfg.range ? ' · 범위: ' + rangeText(cfg) : '';
    return head + colsText(selCols(cfg)) + ' · 값: ' + metricLabel(cfg) + cond + rg;
  }

  function autoTitle(cfg) {
    const cols = selCols(cfg);
    const m = metricLabel(cfg).replace(/\s*\(.*\)$/, '');
    if (isStat(cfg)) {
      if (cfg.read === 'filled' && isPercent(cfg)) return '전체 진도율';
      return (cols.length === 1 ? labelOf(cols[0]) + ' ' : '전체 ') + m;
    }
    if (cfg.mode === 'col') return (cols.length === 1 ? labelOf(cols[0]) + ' ' : '열별 ') + m;
    if (cfg.read === 'filled' && isPercent(cfg)) return labelOf(cfg.label) + '별 진도율';
    return labelOf(cfg.label) + '별 ' + (cols.length === 1 ? labelOf(cols[0]) + ' ' : '') + m;
  }


  // ───────────── 초기화: 보드와 이 브라우저에 저장된 두루보드 정보 모두 삭제 ─────────────
  async function resetAll() {
    const ok = await askConfirm('보드의 개체와 이 브라우저에 저장된 두루보드 정보(레이아웃, 열 자료형 변경, 저장한 주소, 화면 밝기, 분석 파트너 설정)를 모두 삭제하고 연결을 해제합니다. 삭제한 내용은 복구할 수 없으며, 필요한 레이아웃은 먼저 [레이아웃 내보내기]로 저장하십시오.', { ok: '초기화', danger: true });
    if (!ok) return;
    try {
      const ls = window.localStorage;
      const keys = [];
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.indexOf(STORE_PREFIX) === 0) keys.push(k); }
      keys.forEach((k) => ls.removeItem(k));
    } catch (e) { /* 저장소 사용 불가 */ }
    if (state.source) disconnect();
    $('in-domain').value = '';
    $('in-code').value = '';
    $('in-domain').dispatchEvent(new Event('input'));
    $('chk-save-domain').checked = false;
    globalColors = {};
    setAuto(0); aiCfg = { provider: 'openai', model: '' }; aiKeyReset(); renderAiSettings(); syncAiFab();
    applyTheme('auto');
    setMsg('초기화하였습니다. 보드와 이 브라우저에 저장된 두루보드 정보를 모두 삭제하였습니다.', 'ok');
  }

  // ───────────── 색상 선택: 파스텔 기본 색 + 사용자 지정 ─────────────
  function colorPicker(box, cur, presets, onPick, opt) {
    box.replaceChildren();
    opt = opt || {};
    const mk = (val, label, cls) => {
      const b = el('button', 'clr-sw' + (cls ? ' ' + cls : ''));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', label);
      b.title = label;
      b.setAttribute('aria-checked', String((cur || null) === val));
      if (val) b.style.setProperty('--sw', val);
      b.addEventListener('click', () => onPick(val));
      box.append(b);
      return b;
    };
    const auto = mk(null, opt.autoLabel || '자동', 'auto');
    auto.style.setProperty('--sw', opt.autoColor || 'transparent');
    presets.forEach((c) => mk(c, c));
    // 사용자 지정: 기본 색 밖의 색이면 그 색을 보여 주고 선택 표시. 누르면 직접 만든 색 고르기 창
    const custom = cur && !presets.includes(cur);
    const cb = el('button', 'clr-sw custom' + (custom ? ' on' : ''));
    cb.type = 'button';
    cb.title = '사용자 지정 색';
    cb.setAttribute('aria-label', '사용자 지정 색');
    cb.setAttribute('role', 'radio');
    cb.setAttribute('aria-checked', String(!!custom));
    if (custom) cb.style.setProperty('--sw', cur);
    cb.addEventListener('click', (e) => { e.stopPropagation(); openColorPop(cb, cur || presets[0], (v) => onPick(v)); });
    box.append(cb);
  }

  // ───────────── 색 고르기 창 (채도·명도 상자 + 색상 띠 + 색상 코드) ─────────────
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgb2hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
  }
  function hsv2rgb(h, s, v) {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5) * 255, f(3) * 255, f(1) * 255];
  }
  let colorPop = null;
  function closeColorPop() { if (colorPop) { colorPop.el.remove(); document.removeEventListener('pointerdown', colorPop.out, true); document.removeEventListener('keydown', colorPop.key, true); colorPop = null; } }
  function openColorPop(anchor, init, onApply) {
    closeColorPop();
    let [h, s, v] = rgb2hsv(...hex2rgb(init));
    const pop = el('div', 'cp-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '사용자 지정 색');
    const sv = el('div', 'cp-sv'); const svT = el('i', 'cp-thumb'); sv.append(svT);
    const hue = el('div', 'cp-hue'); const hT = el('i', 'cp-thumb'); hue.append(hT);
    const row = el('div', 'cp-row');
    const prev = el('span', 'cp-prev');
    const inp = el('input', 'cp-hex'); inp.type = 'text'; inp.maxLength = 7; inp.spellcheck = false; inp.setAttribute('aria-label', '색상 코드');
    const ok = el('button', 'btn primary small cp-ok', '적용'); ok.type = 'button';
    row.append(prev, inp, ok);
    pop.append(sv, hue, row);
    const cur = () => rgb2hex(...hsv2rgb(h, s, v));
    const paint = (fromInput) => {
      sv.style.setProperty('--hue', 'hsl(' + h + ', 100%, 50%)');
      svT.style.left = (s * 100) + '%'; svT.style.top = ((1 - v) * 100) + '%';
      hT.style.left = (h / 360 * 100) + '%';
      const c = cur();
      prev.style.background = c; svT.style.background = c; hT.style.background = 'hsl(' + h + ', 100%, 50%)';
      if (!fromInput) inp.value = c.toUpperCase();
    };
    const drag = (area, fn) => area.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      area.setPointerCapture(e.pointerId);
      const at = (ev) => { const r = area.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))); paint(); };
      at(e);
      const mv = (ev) => at(ev);
      const up = () => { area.removeEventListener('pointermove', mv); area.removeEventListener('pointerup', up); };
      area.addEventListener('pointermove', mv); area.addEventListener('pointerup', up);
    });
    drag(sv, (x, y) => { s = x; v = 1 - y; });
    drag(hue, (x) => { h = Math.min(359.9, x * 360); });
    inp.addEventListener('input', () => {
      let t = inp.value.trim(); if (t[0] !== '#') t = '#' + t;
      if (/^#[0-9a-fA-F]{6}$/.test(t)) { [h, s, v] = rgb2hsv(...hex2rgb(t)); paint(true); inp.classList.remove('bad'); } else inp.classList.add('bad');
    });
    const apply = () => { const c = cur().toLowerCase(); closeColorPop(); onApply(c); };
    ok.addEventListener('click', apply);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !inp.classList.contains('bad')) apply(); });
    // 창 안(대화상자)에 붙여 맨 위에 보이도록 하고, 단추 아래(공간이 없으면 위)에 놓음
    (anchor.closest('dialog') || document.body).append(pop);
    paint();
    const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    const out = (e) => { if (!pop.contains(e.target) && e.target !== anchor) closeColorPop(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeColorPop(); } };
    document.addEventListener('pointerdown', out, true);
    document.addEventListener('keydown', key, true);
    colorPop = { el: pop, out, key };
    inp.focus(); inp.select();
  }

  function loadGlobalColors() { try { globalColors = sanitizeColor(JSON.parse(store.get('colors') || 'null')) || {}; } catch (e) { globalColors = {}; } }
  function renderGlobalColors() {
    const set = (k) => (v, live) => {
      globalColors = Object.assign({}, globalColors, { [k]: v || undefined });
      if (!globalColors[k]) delete globalColors[k];
      if (Object.keys(globalColors).length) store.set('colors', JSON.stringify(globalColors)); else store.del('colors');
      if (!live) renderGlobalColors();
      redrawForTheme();
    };
    colorPicker($('g-color-base'), globalColors.base, COLOR_BASE, set('base'), { autoLabel: '기본 (화면 밝기에 맞춤)', autoColor: cssVar('--c-out') });
    colorPicker($('g-color-point'), globalColors.point, COLOR_POINT, set('point'), { autoLabel: '기본 (화면 밝기에 맞춤)', autoColor: cssVar('--danger') });
  }
  function renderDraftColors() {
    if (!draft) return;
    const set = (k) => (v, live) => {
      const c = Object.assign({}, draft.color || {});
      if (v) c[k] = v; else delete c[k];
      draft.color = Object.keys(c).length ? c : null;
      if (live) { renderPreview(); return; }
      renderDraftColors(); renderPreview();
    };
    colorPicker($('cf-color-base'), draft.color && draft.color.base, COLOR_BASE, set('base'), { autoLabel: '자동 (레이아웃 설정 색상)', autoColor: globalColors.base || cssVar('--c-out') });
    colorPicker($('cf-color-point'), draft.color && draft.color.point, COLOR_POINT, set('point'), { autoLabel: '자동 (레이아웃 설정 색상)', autoColor: globalColors.point || cssVar('--danger') });
    $('cf-color-point-line').hidden = isStat(draft);
  }

  // ───────────── 화면 밝기: 자동 → 밝게 → 어둡게 ─────────────
  const THEME_LABEL = { auto: '자동', light: '밝게', dark: '어둡게' };
  let themeMode = 'auto';
  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode); else root.removeAttribute('data-theme');
    document.querySelectorAll('#theme-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    themeMode = mode;
    redrawForTheme();
  }
  // 그래프 색은 그릴 때 정해지므로 테마가 바뀌면 다시 그림
  function redrawForTheme() {
    if (state.rows && state.rows.length && !$('view-board').hidden) renderBoard();
    if ($('dlg-chart').open && typeof renderPreview === 'function') renderPreview();
  }
  function initTheme() {
    let mode = 'auto';
    const v = store.get('theme'); if (v === 'light' || v === 'dark') mode = v;
    applyTheme(mode);
    document.querySelectorAll('#theme-seg button').forEach((b) => b.addEventListener('click', () => {
      const next = b.dataset.mode;
      if (next === 'auto') store.del('theme'); else store.set('theme', next);
      applyTheme(next);
    }));
    try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themeMode === 'auto') redrawForTheme(); }); } catch (e) { /* 미지원 */ }
  }

  // 공용 더보기 메뉴
  let cardMenu = null;
  function closeCardMenu() {
    if (!cardMenu) return;
    cardMenu.menu.remove();
    cardMenu.btn.setAttribute('aria-expanded', 'false');
    cardMenu = null;
  }
  function openMenu(btn, host, items) {
    if (cardMenu && cardMenu.btn === btn) { closeCardMenu(); return; }
    closeCardMenu();
    const menu = el('div', 'card-menu');
    menu.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it === '-') { menu.append(el('div', 'cm-sep')); return; }
      const b = el('button', 'cm-item' + (it.cls ? ' ' + it.cls : ''));
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.disabled = !!it.disabled;
      b.append(icon(it.icon), el('span', null, it.label));
      b.addEventListener('click', () => { closeCardMenu(); it.fn(); });
      menu.append(b);
    });
    host.append(menu);
    btn.setAttribute('aria-expanded', 'true');
    cardMenu = { menu, btn };
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }
  function toolBtn(name, label, fn) {
    const b = el('button', 'icon-tool');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(name));
    b.addEventListener('click', fn);
    return b;
  }
  // 카드 도구: 편집 · 그룹 이동 · 더보기(순서 이동·삭제)
  function cardTools(cfg, i, n) {
    const tools = el('div', 'card-tools');
    const more = toolBtn('more', '더보기', (e) => {
      e.stopPropagation();
      openMenu(more, tools, [
        { icon: 'up', label: '앞으로 이동', fn: () => moveChart(cfg.id, -1), disabled: i === 0 },
        { icon: 'down', label: '뒤로 이동', fn: () => moveChart(cfg.id, 1), disabled: i === n - 1 },
        { icon: 'copy', label: '복제', fn: () => duplicateChart(cfg.id), disabled: state.layout.length >= MAX_CHARTS },
        '-',
        { icon: 'trash', label: '삭제', fn: () => removeChart(cfg.id), cls: 'danger' }
      ]);
    });
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    tools.append(toolBtn('edit', '편집', () => openChartDialog(cfg.id)), toolBtn('fmove', '그룹으로 이동', () => openMove({ chart: cfg.id })), more);
    return tools;
  }

  // ───────────── 그룹 ─────────────
  const groupOf = (id) => state.groups.find((g) => g.id === id) || null;
  const childGroups = (pid) => state.groups.filter((g) => (g.parent || null) === (pid || null));
  const groupPath = (id) => { const g = groupOf(id); if (!g) return '보드'; const p = g.parent ? groupOf(g.parent) : null; return (p ? p.name + ' › ' : '') + g.name; };
  function groupItemCount(id) {
    const ids = new Set([id].concat(childGroups(id).map((g) => g.id)));
    return state.layout.filter((c) => ids.has(c.group)).length;
  }

  // 이름 입력 창
  function askName(title, init, opt) {
    opt = opt || {};
    return new Promise((resolve) => {
      const dlg = $('dlg-name');
      $('nm-title').textContent = title;
      $('nm-input').placeholder = opt.placeholder || '예: 정보과학';
      $('nm-input').maxLength = opt.max || 30;
      $('nm-input').setAttribute('aria-label', opt.label || '그룹 이름');
      $('nm-input').value = init || '';
      $('nm-msg').textContent = '';
      $('nm-input').oninput = () => { $('nm-msg').textContent = ''; };
      const done = (v) => { dlg.close(); $('nm-ok').onclick = null; $('nm-cancel').onclick = null; $('nm-input').onkeydown = null; dlg.oncancel = null; resolve(v); };
      const ok = () => {
        const v = $('nm-input').value.trim();
        if (!v && !opt.allowEmpty) { $('nm-msg').textContent = (opt.label || '그룹 이름') + '을 입력하십시오.'; $('nm-msg').className = 'msg error'; return; }
        const bad = opt.validate ? opt.validate(v) : '';
        if (bad) { $('nm-msg').textContent = bad; $('nm-msg').className = 'msg error'; $('nm-input').focus(); return; }
        done(v.slice(0, opt.max || 30));
      };
      $('nm-ok').onclick = ok;
      $('nm-cancel').onclick = () => done(null);
      $('nm-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok(); } };
      dlg.oncancel = (e) => { e.preventDefault(); done(null); };
      dlg.showModal();
      $('nm-input').focus();
      $('nm-input').select();
    });
  }

  // 그룹 이름 중복 검사 (대소문자·앞뒤 공백 무시)
  function dupGroupMsg(v, selfId) {
    const k = v.trim().toLowerCase();
    return state.groups.some((g) => g.id !== selfId && g.name.trim().toLowerCase() === k) ? '‘' + v.trim() + '’ 그룹이 이미 있습니다. 다른 이름을 입력하십시오.' : '';
  }
  async function createGroup(parent) {
    if (state.groups.length >= MAX_BGROUPS) { await askConfirm('그룹은 최대 ' + MAX_BGROUPS + '개까지 만들 수 있습니다.'); return null; }
    const name = await askName(parent ? '‘' + groupOf(parent).name + '’ 안에 하위 그룹 만들기' : '그룹 만들기', '', { validate: (v) => dupGroupMsg(v, null) });
    if (!name) return null;
    const g = { id: uid(), name, parent: parent || null, open: true };
    state.groups.push(g);
    saveLayout(); renderBoard();
    return g;
  }
  async function renameGroup(id) {
    const g = groupOf(id);
    const name = await askName('그룹 이름 변경', g.name, { validate: (v) => dupGroupMsg(v, id) });
    if (!name) return;
    g.name = name;
    saveLayout(); renderBoard();
  }
  async function removeGroup(id) {
    const g = groupOf(id);
    const n = state.layout.filter((c) => c.group === id).length;
    const subs = childGroups(id);
    const to = g.parent ? '‘' + groupOf(g.parent).name + '’ 그룹' : '보드';
    let text = '‘' + g.name + '’ 그룹을 삭제합니다.';
    const parts = [];
    if (n) parts.push('개체 ' + n + '개는 ' + to + '로');
    if (subs.length) parts.push('하위 그룹 ' + subs.length + '개는 최상위 그룹으로');
    if (parts.length) text += ' 안에 있던 ' + parts.join(', ') + ' 옮겨지며 삭제되지 않습니다.';
    if (!(await askConfirm(text, { ok: '삭제', danger: true }))) return;
    state.layout.forEach((c) => { if (c.group === id) c.group = g.parent || null; });
    subs.forEach((s) => { s.parent = g.parent || null; });
    state.groups = state.groups.filter((x) => x.id !== id);
    saveLayout(); renderBoard();
  }
  // 같은 위치(같은 상위)의 그룹끼리 순서 이동
  function moveGroupOrder(id, d) {
    const g = groupOf(id);
    const sib = childGroups(g.parent);
    const k = sib.indexOf(g) + d;
    if (k < 0 || k >= sib.length) return;
    const a = state.groups.indexOf(g), b = state.groups.indexOf(sib[k]);
    flashTarget = { group: id };
    state.groups[a] = sib[k]; state.groups[b] = g;
    saveLayout(); renderBoard();
  }
  function toggleGroup(id) {
    const g = groupOf(id);
    g.open = !g.open;
    saveLayout(); renderBoard();
  }

  // 그룹 관리 창: 전체 그룹을 한곳에서 이름 변경·이동·순서·삭제
  function renderGroupMgr() {
    const list = $('gm-list');
    list.replaceChildren();
    const tops = childGroups(null);
    if (!tops.length) { list.append(el('p', 'grp-empty', '그룹이 없습니다. [＋ 그룹 만들기]로 만드십시오.')); return; }
    const row = (g, i, n) => {
      const r = el('div', 'gm-row d' + (g.parent ? 2 : 1));
      const nm = el('div', 'gm-name');
      nm.append(icon('folder'), el('span', null, g.name), el('span', 'grp-count', String(groupItemCount(g.id))));
      const tools = el('div', 'card-tools');
      const more = toolBtn('more', '그룹 메뉴', (e) => {
        e.stopPropagation();
        const items = [];
        if (!g.parent) items.push({ icon: 'plus', label: '하위 그룹 만들기', fn: () => createGroup(g.id) });
        items.push(
          { icon: 'up', label: '앞으로 이동', fn: () => moveGroupOrder(g.id, -1), disabled: i === 0 },
          { icon: 'down', label: '뒤로 이동', fn: () => moveGroupOrder(g.id, 1), disabled: i === n - 1 },
          '-',
          { icon: 'trash', label: '그룹 삭제', fn: () => removeGroup(g.id), cls: 'danger' }
        );
        openMenu(more, tools, items);
      });
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      tools.append(toolBtn('edit', '이름 변경', () => renameGroup(g.id)), toolBtn('fmove', '그룹 이동', () => openMove({ group: g.id })), more);
      r.append(nm, tools);
      list.append(r);
    };
    tops.forEach((g, i) => {
      row(g, i, tops.length);
      const subs = childGroups(g.id);
      subs.forEach((s, k) => row(s, k, subs.length));
    });
  }

  // 이동 창: 개체 또는 그룹을 다른 위치로
  let moveTarget = null;
  function openMove(t) {
    moveTarget = t;
    renderMoveList();
    $('dlg-move').showModal();
  }
  function renderMoveList() {
    const t = moveTarget;
    const list = $('mv-list');
    list.replaceChildren();
    let cur, name;
    if (t.chart) { const c = state.layout.find((x) => x.id === t.chart); cur = c.group || null; name = c.title || autoTitle(c); }
    else { const g = groupOf(t.group); cur = g.parent || null; name = g.name; }
    $('mv-title').textContent = t.chart ? '개체를 이동할 그룹' : '그룹을 이동할 위치';
    $('mv-sub').textContent = '‘' + name + '’' + (t.group ? ' · 그룹은 최대 2단계까지 넣을 수 있습니다.' : '');
    const hasSubs = t.group && childGroups(t.group).length > 0;
    const opt = (gid, label, depth, disabled, note) => {
      const b = el('button', 'mv-opt d' + depth);
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(gid === cur));
      b.disabled = !!disabled;
      b.append(icon(gid ? 'folder' : 'tbar'), el('span', 'mv-name', label));
      if (note) b.append(el('small', 'mv-note', note));
      else if (gid === cur) b.append(el('small', 'mv-note', '현재 위치'));
      b.addEventListener('click', () => { if (gid !== cur) applyMove(gid); else $('dlg-move').close(); });
      list.append(b);
    };
    opt(null, t.chart ? '그룹 없음' : '맨 위 (최상위 그룹)', 0);
    childGroups(null).forEach((g) => {
      if (t.group) {
        // 그룹 이동: 자기 자신 아래로는 불가, 하위 그룹이 있으면 다른 그룹 아래로 넣을 수 없음(3단계 방지)
        if (g.id === t.group) { opt(g.id, g.name, 1, true, '이동하는 그룹'); return; }
        opt(g.id, g.name, 1, hasSubs, hasSubs ? '하위 그룹이 있어 넣을 수 없음' : '');
        return;
      }
      opt(g.id, g.name, 1);
      childGroups(g.id).forEach((s) => opt(s.id, s.name, 2));
    });
  }
  function applyMove(gid) {
    const t = moveTarget;
    if (t.chart) {
      const c = state.layout.find((x) => x.id === t.chart);
      c.group = gid;
      // 옮긴 그룹이 접혀 있으면 펼침
      [gid, gid && groupOf(gid).parent].forEach((x) => { const g = x && groupOf(x); if (g) g.open = true; });
    } else {
      const g = groupOf(t.group);
      g.parent = gid;
      // 순서: 새 위치의 맨 뒤로
      state.groups = state.groups.filter((x) => x !== g).concat(g);
      if (gid) groupOf(gid).open = true;
    }
    flashTarget = t.chart ? { chart: t.chart } : { group: t.group };
    $('dlg-move').close();
    saveLayout(); renderBoard();
  }

  function groupTools(g, i, n) {
    const tools = el('div', 'card-tools');
    const more = toolBtn('more', '그룹 메뉴', (e) => {
      e.stopPropagation();
      const items = [{ icon: 'rename', label: '이름 변경', fn: () => renameGroup(g.id) }];
      if (!g.parent) items.push({ icon: 'plus', label: '하위 그룹 만들기', fn: () => createGroup(g.id) });
      items.push(
        { icon: 'up', label: '앞으로 이동', fn: () => moveGroupOrder(g.id, -1), disabled: i === 0 },
        { icon: 'down', label: '뒤로 이동', fn: () => moveGroupOrder(g.id, 1), disabled: i === n - 1 },
        '-',
        { icon: 'trash', label: '그룹 삭제', fn: () => removeGroup(g.id), cls: 'danger' }
      );
      openMenu(more, tools, items);
    });
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    tools.append(toolBtn('fmove', '그룹 이동', () => openMove({ group: g.id })), more);
    return tools;
  }

  // 축 이름 (보드 그래프): 그래프 위·아래에 글자로 표시
  function axisNames(cfg, result) {
    const hz = cfg.type === 'hbar', hist = cfg.type === 'hist';
    const multi = result.series.length > 1;
    if (hist) return { y: '항목 수', x: valueName(cfg) + ' 구간' };
    if (hz) return { y: itemName(cfg), x: valueName(cfg) };
    return { y: multi && cfg.read !== 'num' ? '입력 칸 수 (열별 누적)' : valueName(cfg), x: itemName(cfg) };
  }
  function axisCap(k, v, cls) {
    const c = el('div', 'ax-cap ' + cls);
    c.append(el('span', 'ax-cap-k', k), el('span', 'ax-cap-v', v));
    return c;
  }

  function renderStatBody(result, cfg, box) {
    if (result.error) { box.append(el('p', 'card-warn', result.error)); return; }
    result.warnings.forEach((w) => box.append(el('p', 'card-warn', w)));
    box.append(el('p', 'stat-label', valueName(cfg)), el('p', 'stat-value', fmtVal(result.value, cfg)));
    if (isPercent(cfg) && result.value !== null) {
      const bar = el('div', 'stat-meter');
      const fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, result.value)) + '%';
      bar.append(fill);
      box.append(bar);
    } else box.append(el('div', 'stat-meter sp-ph')); // 막대가 없는 통계도 같은 높이로
    box.append(el('p', 'stat-sub', statSub(result, cfg)));
  }

  function renderCard(cfg, i, n, statRow, chartGrid) {
    const stat = isStat(cfg);
    const card = el('article', 'card' + (stat ? ' stat' : (cfg.width === 2 ? ' w2' : '')));
    card.dataset.id = cfg.id;
    const span = itemSpan(cfg);
    const pos = cfg.pos && cfg.pos[String(curN())];
    if (pos) card.style.gridColumn = Math.min(pos, curN() * 2 - span + 1) + ' / span ' + span;
    if (stat && (globalColors.base || (cfg.color && cfg.color.base))) card.style.setProperty('--c-out', chartColor(cfg, 'base'));
    const head = el('div', 'card-head');
    const h3 = el('h3', null, cfg.title || autoTitle(cfg));
    h3.title = h3.textContent;
    head.append(h3, cardTools(cfg, i, n));
    card.append(head);
    bindDrag(card, cfg);
    if (!stat) card.append(el('p', 'card-desc', describe(cfg)));
    (stat ? statRow : chartGrid).append(card);

    const result = compute(cfg);
    if (stat) { renderStatBody(result, cfg, card); return; }
    if (result.error) { card.append(el('p', 'card-warn', result.error)); return; }
    result.warnings.forEach((w) => card.append(el('p', 'card-warn', w)));
    if (cfg.type === 'table') { card.append(renderTable(result, cfg)); return; }
    if (cfg.type === 'list') { card.append(renderList(result, cfg)); return; }
    const box = el('div', 'chart-box');
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', (cfg.title || autoTitle(cfg)) + ' 그래프');
    box.append(canvas);
    if (cfg.type === 'hbar') box.style.height = Math.max(280, result.labels.length * 20 + 60) + 'px';
    const an = axisNames(cfg, result);
    card.append(axisCap('Y축', an.y, 'ax-cap-y'), box, axisCap('X축', an.x, 'ax-cap-x'));
    state.charts.set(cfg.id, drawChart(cfg, canvas, result));
  }

  // ───────────── 드래그로 개체 옮기기 ─────────────
  // 카드 머리줄을 끌어 다른 개체 앞·뒤, 빈 칸, 다른 그룹에 놓음 (터치는 잠깐 누른 뒤 끌기)
  const curN = () => Math.max(1, Number(getComputedStyle(document.documentElement).getPropertyValue('--n')) || 1);
  const itemSpan = (c) => (isStat(c) ? 1 : (c.width === 2 && curN() >= 2 ? 4 : 2));
  let drag = null;
  function bindDrag(card, cfg) {
    const head = card.querySelector('.card-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input')) return;
      const sx = e.clientX, sy = e.clientY, touch = e.pointerType !== 'mouse';
      let active = false;
      let timer = null;
      const begin = (ev) => { active = true; startDrag(card, cfg, ev || e); };
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
      };
      const move = (ev) => {
        if (!active) {
          const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
          if (!touch && d > 6) begin(ev);
          else if (touch && d > 10) { cleanup(); return; }
          if (!active) return;
        }
        ev.preventDefault();
        dragMove(ev);
      };
      const up = (ev) => { cleanup(); if (active) dragEnd(ev); };
      const cancel = () => { cleanup(); if (active) dragAbort(); };
      if (touch) timer = setTimeout(() => begin(), 260);
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    });
  }
  // 그룹(폴더) 끌어 옮기기: 머리줄을 끌어 다른 그룹 앞·뒤, 또는 상위 그룹 안(하위 그룹)으로
  let groupDragEndAt = 0;
  function bindGroupDrag(head, sec, g) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.closest('button, a, input') && !e.target.closest('.grp-toggle'))) return;
      const sx = e.clientX, sy = e.clientY, touch = e.pointerType !== 'mouse';
      let active = false, timer = null;
      const begin = (ev) => {
        active = true;
        closeCardMenu();
        const ghost = el('div', 'drag-ghost grp-ghost');
        ghost.append(icon('folder'), document.createTextNode(g.name));
        const mark = el('div', 'drop-mark');
        mark.hidden = true;
        document.body.append(ghost, mark);
        sec.classList.add('dragging');
        document.body.classList.add('is-dragging');
        drag = { card: sec, group: g, ghost, mark, target: null, scroll: 0 };
        dragMove(ev || e);
      };
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); };
      const move = (ev) => {
        if (!active) {
          const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
          if (!touch && d > 6) begin(ev);
          else if (touch && d > 10) { cleanup(); return; }
          if (!active) return;
        }
        ev.preventDefault();
        dragMove(ev);
      };
      const up = (ev) => { cleanup(); if (active) { groupDragEndAt = Date.now(); dragEnd(ev); } };
      const cancel = () => { cleanup(); if (active) dragAbort(); };
      if (touch) timer = setTimeout(() => begin(), 260);
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    });
  }
  // 놓을 자리: { before|after|into: 그룹 id } 또는 { end: true } (최상위 맨 뒤)
  function groupDropTarget(x, y) {
    const g = drag.group;
    const hasKids = childGroups(g.id).length > 0;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !hit.closest('#board')) return null;
    let sec = hit.closest('.grp');
    if (!sec) {
      const tops = Array.from(document.querySelectorAll('#board > .grp, #board .grp.d1'));
      const last = tops[tops.length - 1];
      return last ? { end: true, rect: hLine(last.getBoundingClientRect(), false) } : null;
    }
    // 자기 자신(또는 자기 하위) 위에서는 놓지 않음
    if (sec === drag.card || drag.card.contains(sec)) return { none: true };
    const A = groupOf(sec.dataset.gid);
    if (!A) return null;
    const head = sec.querySelector(':scope > .grp-head');
    const hr = head.getBoundingClientRect();
    const sr = sec.getBoundingClientRect();
    const canInto2 = !A.parent && !hasKids;
    // 하위 그룹을 가진 그룹은 최상위에만 둘 수 있으므로, 대상이 하위 그룹이면 그 상위 그룹 기준으로 처리
    if (hasKids && A.parent) {
      const P = groupOf(A.parent);
      const ps = document.querySelector('#board .grp[data-gid="' + CSS.escape(P.id) + '"]');
      const pr = ps.getBoundingClientRect();
      return y < pr.top + pr.height / 2 ? { before: P.id, rect: hLine(pr, true) } : { after: P.id, rect: hLine(pr, false) };
    }
    if (y <= hr.bottom) {
      // 머리줄: 위쪽 절반은 앞, 아래쪽 절반은 안(가능한 경우) 또는 뒤
      if (y < hr.top + hr.height / 2) return { before: A.id, rect: hLine(sr, true) };
      if (canInto2) return { into: A.id, rect: hr, box: true };
      return { after: A.id, rect: hLine(sr, false) };
    }
    // 그룹 안쪽(카드 영역): 최상위 그룹이면 안으로, 하위 그룹이면 뒤로
    if (canInto2) return { into: A.id, rect: hr, box: true };
    return { after: A.id, rect: hLine(sr, false) };
  }
  function hLine(r, top) { return { left: r.left, top: top ? r.top - 6 : r.bottom + 3, width: r.width, height: 3 }; }
  function applyGroupDrop(t) {
    const g = drag ? drag.group : null;
    if (!g || !t || t.none) return;
    let parent, refId, after = false;
    if (t.end) { parent = null; }
    else if (t.into) { parent = t.into; }
    else { refId = t.before || t.after; after = !!t.after; parent = groupOf(refId).parent || null; }
    if (parent === g.id) return;
    if (parent && childGroups(g.id).length) return; // 2단계 제한
    state.groups = state.groups.filter((x) => x !== g);
    g.parent = parent;
    if (refId) {
      const k = state.groups.findIndex((x) => x.id === refId);
      state.groups.splice(after ? k + 1 : k, 0, g);
    } else state.groups.push(g);
    // 하위 그룹은 상위 그룹 뒤에 오도록 순서 보정
    const tops = state.groups.filter((x) => !x.parent);
    const ordered = [];
    tops.forEach((tg) => { ordered.push(tg); state.groups.filter((x) => x.parent === tg.id).forEach((c) => ordered.push(c)); });
    state.groups = ordered;
    if (parent) groupOf(parent).open = true;
    flashTarget = { group: g.id };
    saveLayout(); renderBoard();
  }
  function startDrag(card, cfg, e) {
    closeCardMenu();
    const ghost = el('div', 'drag-ghost', cfg.title || autoTitle(cfg));
    const mark = el('div', 'drop-mark');
    mark.hidden = true;
    document.body.append(ghost, mark);
    card.classList.add('dragging');
    document.body.classList.add('is-dragging');
    drag = { card, cfg, ghost, mark, target: null, scroll: 0 };
    dragMove(e);
  }
  function dropTarget(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !hit.closest('#board')) return null;
    const grp = hit.closest('.grp');
    const gid = grp ? grp.dataset.gid : null;
    const grid = grp ? grp.querySelector(':scope > .grp-body > .item-grid') : document.querySelector('#board > .board-loose > .item-grid');
    const card = hit.closest('.card');
    if (card === drag.card) return { none: true };
    if (card && grid && card.parentNode === grid) {
      const r = card.getBoundingClientRect();
      return { gid, ref: card.dataset.id, before: x < r.left + r.width / 2, rect: r };
    }
    if (grid && hit.closest('.item-grid') === grid) {
      const gr = grid.getBoundingClientRect();
      const cs = getComputedStyle(grid);
      const cols = cs.gridTemplateColumns.split(' ').map(parseFloat);
      const gap = parseFloat(cs.columnGap) || 0;
      let c = 0, acc = gr.left;
      for (let k = 0; k < cols.length; k++) { if (x < acc + cols[k] + gap / 2) { c = k; break; } acc += cols[k] + gap; c = k; }
      const span = itemSpan(drag.cfg);
      c = Math.max(0, Math.min(c, cols.length - span));
      let left = gr.left; for (let k = 0; k < c; k++) left += cols[k] + gap;
      let w = 0; for (let k = c; k < c + span; k++) w += cols[k] + (k > c ? gap : 0);
      // 읽는 순서에서 놓일 자리: 아래에 있거나 같은 줄 오른쪽에 있는 첫 개체 앞
      const items = Array.from(grid.children).filter((n) => n !== drag.card && n.classList.contains('card'));
      const next = items.find((n) => { const r = n.getBoundingClientRect(); return r.top > y || (r.bottom > y && r.left >= left - 1); });
      return { gid, col: c + 1, beforeId: next ? next.dataset.id : null, rect: { left, top: y - 50, width: w, height: 100 } };
    }
    // 그룹 머리줄·빈 그룹·보드 빈 곳: 그 위치의 맨 뒤로
    const head = grp ? grp.querySelector(':scope > .grp-head') : null;
    return { gid, append: true, rect: head ? head.getBoundingClientRect() : null };
  }
  function dragMove(e) {
    const d = drag;
    d.ghost.style.left = e.clientX + 'px';
    d.ghost.style.top = e.clientY + 'px';
    d.target = d.group ? groupDropTarget(e.clientX, e.clientY) : dropTarget(e.clientX, e.clientY);
    const t = d.target, m = d.mark;
    if (!t || t.none || !t.rect) { m.hidden = true; }
    else if (d.group) {
      m.hidden = false;
      m.className = 'drop-mark ' + (t.box ? 'grp' : 'hline');
      const r = t.rect;
      Object.assign(m.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    } else {
      m.hidden = false;
      m.className = 'drop-mark ' + (t.ref ? 'line' : t.col ? 'cell' : 'grp');
      const r = t.rect;
      if (t.ref) Object.assign(m.style, { left: (t.before ? r.left - 7 : r.right + 3) + 'px', top: r.top + 'px', width: '4px', height: r.height + 'px' });
      else Object.assign(m.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    }
    // 화면 위·아래 가장자리에서는 자동 스크롤
    const edge = 70;
    d.scroll = e.clientY < edge ? -12 : e.clientY > window.innerHeight - edge ? 12 : 0;
    if (d.scroll && !d.raf) {
      const tick = () => { if (!drag || !drag.scroll) { if (drag) drag.raf = 0; return; } window.scrollBy(0, drag.scroll); drag.raf = requestAnimationFrame(tick); };
      d.raf = requestAnimationFrame(tick);
    }
  }
  function dragAbort() {
    if (!drag) return;
    drag.ghost.remove(); drag.mark.remove();
    drag.card.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    drag = null;
  }
  function dragEnd() {
    if (drag && drag.group) { const tg = drag.target; const gd = drag; dragAbort(); drag = gd; applyGroupDrop(tg); drag = null; return; }
    const d = drag;
    const t = d && d.target;
    dragAbort();
    if (!t || t.none) return;
    const cfg = d.cfg;
    const n = String(curN());
    const gid = t.gid || null;
    state.layout = state.layout.filter((c) => c !== cfg);
    cfg.group = gid;
    if (cfg.pos) { delete cfg.pos[n]; if (!Object.keys(cfg.pos).length) cfg.pos = null; }
    let at;
    if (t.ref) {
      const k = state.layout.findIndex((c) => c.id === t.ref);
      at = t.before ? k : k + 1;
    } else if (t.col) {
      at = t.beforeId ? state.layout.findIndex((c) => c.id === t.beforeId) : -1;
      cfg.pos = Object.assign({}, cfg.pos || {}, { [n]: t.col });
    }
    if (at === undefined || at < 0) {
      // 그 위치(그룹)의 마지막 개체 뒤, 없으면 맨 뒤
      let last = -1;
      state.layout.forEach((c, k) => { if ((c.group || null) === gid) last = k; });
      at = last >= 0 ? last + 1 : state.layout.length;
    }
    state.layout.splice(at, 0, cfg);
    const g = gid && groupOf(gid);
    if (g) { g.open = true; if (g.parent) groupOf(g.parent).open = true; }
    flashTarget = { chart: cfg.id };
    saveLayout(); renderBoard();
  }

  // 한 위치(보드 또는 그룹)의 개체: 종류와 관계없이 순서대로 한 격자에 배치 (통계는 반 칸, 그래프는 한 칸)
  function renderItems(host, gid) {
    const items = state.layout.filter((c) => (c.group || null) === gid);
    if (!items.length) return 0;
    const grid = el('div', 'item-grid');
    grid.dataset.gid = gid || '';
    items.forEach((c, i) => renderCard(c, i, items.length, grid, grid));
    host.append(grid);
    return items.length;
  }

  function renderGroup(host, g, i, n) {
    const depth = g.parent ? 2 : 1;
    const sec = el('section', 'grp d' + depth + (g.open ? ' open' : ''));
    sec.dataset.gid = g.id;
    const head = el('div', 'grp-head');
    const tg = el('button', 'grp-toggle');
    tg.type = 'button';
    tg.setAttribute('aria-expanded', String(g.open));
    const nm = el('span', 'grp-name');
    // 하위 그룹은 상위 그룹 이름을 앞에 작게 붙여 소속을 표시
    if (g.parent) nm.append(el('span', 'grp-parent', groupOf(g.parent).name + ' › '));
    nm.append(document.createTextNode(g.name));
    tg.append(icon('chev'), icon('folder'), nm, el('span', 'grp-count', String(groupItemCount(g.id))));
    tg.addEventListener('click', (e) => { if (Date.now() - groupDragEndAt < 400) { e.preventDefault(); return; } toggleGroup(g.id); });
    head.append(tg, groupTools(g, i, n));
    bindGroupDrag(head, sec, g);
    sec.append(head);
    if (g.open) {
      const body = el('div', 'grp-body');
      const cnt = renderItems(body, g.id);
      const subs = childGroups(g.id);
      subs.forEach((s, k) => renderGroup(body, s, k, subs.length));
      if (!cnt && !subs.length) body.append(el('p', 'grp-empty', '비어 있습니다. 개체의 그룹 이동 단추로 이 그룹에 넣을 수 있습니다.'));
      sec.append(body);
    }
    host.append(sec);
  }

  // 개체 격자: 짧은 개체 아래 빈 공간이 생기지 않도록 높이만큼 줄을 차지 (4px 단위)
  function packGrids() {
    document.querySelectorAll('#board .item-grid').forEach((grid) => {
      const gap = parseFloat(getComputedStyle(grid).getPropertyValue('--pack-gap')) || 16;
      Array.from(grid.children).forEach((c) => {
        c.style.gridRowEnd = '';
        const h = c.getBoundingClientRect().height;
        c.style.gridRowEnd = 'span ' + Math.max(1, Math.ceil((h + gap) / 4));
      });
    });
  }
  let packTimer = null;
  window.addEventListener('resize', () => { clearTimeout(packTimer); packTimer = setTimeout(packGrids, 120); });

  // 방금 옮긴 개체·그룹을 잠깐 깜빡여 표시
  let flashTarget = null;
  function flashMoved() {
    if (!flashTarget) return;
    const t = flashTarget;
    flashTarget = null;
    const node = t.chart ? document.querySelector('#board .card[data-id="' + CSS.escape(t.chart) + '"]')
      : document.querySelector('#board .grp[data-gid="' + CSS.escape(t.group) + '"] > .grp-head');
    if (!node) return;
    node.classList.remove('moved'); void node.offsetWidth; node.classList.add('moved');
    const r = node.getBoundingClientRect();
    if (r.top < 70 || r.bottom > window.innerHeight) node.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    setTimeout(() => node.classList.remove('moved'), 1800);
  }

  function renderBoard() {
    destroyCharts();
    closeCardMenu();
    const board = $('board');
    board.replaceChildren();
    const loose = el('div', 'board-loose');
    renderItems(loose, null);
    if (loose.childNodes.length) board.append(loose);
    const tops = childGroups(null);
    tops.forEach((g, i) => renderGroup(board, g, i, tops.length));

    // 빈 보드 안내
    if (!state.layout.length && !state.groups.length) {
      const empty = el('div', 'board-empty');
      empty.append(el('b', null, '아직 개체가 없습니다.'), el('span', null, '오른쪽 아래 [개체] 단추로 그래프나 통계를 만드십시오.'));
      board.append(empty);
    }
    if ($('dlg-groups').open) renderGroupMgr();
    packGrids();
    requestAnimationFrame(flashMoved);
  }

  // 명단: 해당 항목 수와 이름 목록
  function renderList(result, cfg) {
    const box = el('div', 'list-out');
    const n = result.labels.length;
    const total = result.rangeInfo ? result.rangeInfo.before : n;
    const head = el('p', 'list-n');
    head.append(document.createTextNode(n + '개'));
    if (total !== n) head.append(el('small', null, ' / ' + total + '개'));
    box.append(head);
    const ul = el('div', 'list-items');
    const showV = !(cfg.range && (cfg.read === 'blank' || cfg.read === 'filled') && !isPercent(cfg) && result.series[0].data.every((v) => v === result.series[0].data[0]));
    result.labels.forEach((l, i) => {
      const it = el('span', 'list-item', l);
      if (showV) it.append(el('small', null, fmtVal(result.series[0].data[i], cfg)));
      ul.append(it);
    });
    if (!n) ul.append(el('p', 'pv-empty', '해당 항목이 없습니다.'));
    box.append(ul);
    return box;
  }

  function renderTable(result, cfg) {
    const wrap = el('div', 'table-wrap');
    const table = el('table', 'table');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', null, result.hist ? metricLabel(cfg) + ' 구간' : cfg.mode === 'col' ? '열' : labelOf(cfg.label)));
    const al = cfg.align || 'right';
    result.series.forEach((s) => { const th = el('th', 'num', result.series.length === 1 && !result.hist ? valueName(cfg) : s.name); th.style.textAlign = al; hr.append(th); });
    thead.append(hr);
    const tbody = el('tbody');
    result.labels.forEach((lab, i) => {
      const tr = el('tr');
      tr.append(el('td', null, lab));
      result.series.forEach((s) => { const td = el('td', 'num', result.hist ? String(s.data[i]) : fmtVal(s.data[i], cfg)); td.style.textAlign = al; tr.append(td); });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  // 최저·최고값 강조 색
  function hlColors(cfg, data, base, skip) {
    if (skip || !cfg.hl || cfg.hl === 'none') return base;
    const vals = data.filter((v) => v !== null);
    if (!vals.length) return base;
    const t = cfg.hl === 'min' ? Math.min.apply(null, vals) : Math.max.apply(null, vals);
    const hc = chartColor(cfg, 'point');
    return data.map((v) => (v === t ? hc : base));
  }

  // 색상: 개체 지정 → 레이아웃 설정(기본 색상) → 화면 밝기에 맞춘 기본값
  const COLOR_BASE = ['#8b95f0', '#7cb8f2', '#6fcfc4', '#8fd19e', '#f2b36b', '#f29bb8', '#b79cf2', '#a8b0bf'];
  const COLOR_POINT = ['#f27a7a', '#f5a25d', '#f2cf5b', '#6fcf97', '#f290c3', '#9b8cf2', '#5bb3f2', '#8a93a3'];
  let globalColors = {};
  function chartColor(cfg, k) {
    return (cfg && cfg.color && cfg.color[k]) || globalColors[k] || (k === 'base' ? cssVar('--c-out') : cssVar('--danger'));
  }

  function drawChart(cfg, canvas, result, pv) {
    pv = pv || null;
    if (typeof window.Chart !== 'function') {
      canvas.parentNode.replaceWith(el('p', 'card-warn', '그래프 도구(vendor/chart.umd.js)를 불러오지 못하였습니다.'));
      return null;
    }
    const text = cssVar('--text-2');
    const grid = cssVar('--line-soft') || cssVar('--line');
    const hist = !!result.hist;
    const horizontal = cfg.type === 'hbar';
    const multi = result.series.length > 1;
    const stacked = multi && cfg.read !== 'num';
    const colors = multi ? PALETTE : [chartColor(cfg, 'base')];
    const metric = metricLabel(cfg);
    const valueAxis = {
      beginAtZero: true,
      stacked,
      title: { display: true, text: hist ? '항목 수' : stacked ? '입력 칸 수 (열별 누적)' : valueName(cfg), color: cssVar('--c-out'), font: { weight: '600' } },
      ticks: hist ? { color: text, precision: 0 } : { color: text, callback: (v) => fmtVal(v, cfg) },
      grid: { color: grid }
    };
    if (isPercent(cfg) && !hist) valueAxis.max = 100;
    // 항목 이름이 다 들어가지 않으면 띄엄띄엄 표시하지 않고, 처음·끝 이름 사이를 ⋮(…)로 생략 표시
    const labels = result.labels || [];
    const tickFont = 12;
    const catTick = function (value, index) {
      const n = labels.length;
      const name = String(labels[index] == null ? '' : labels[index]);
      if (hist) return name;
      const ch = this.chart;
      let cap;
      if (horizontal) cap = Math.floor((ch.height * 0.85) / (tickFont + 3));
      else {
        const longest = labels.reduce((m, l) => Math.max(m, String(l).length), 1);
        cap = Math.floor((ch.width * 0.85) / Math.max(24, longest * tickFont * 0.62 + 10));
      }
      if (n <= cap) return name;
      if (index === 0 || index === n - 1) return name;
      if (index === Math.round((n - 1) / 2)) return horizontal ? '⋮' : '…';
      return '';
    };
    const catAxis = { stacked, ticks: { color: text, autoSkip: hist, maxRotation: 0, font: { size: tickFont }, callback: catTick }, grid: { display: false } };
    catAxis.title = { display: !pv, text: hist ? valueName(cfg) + ' 구간' : itemName(cfg), color: text, font: { weight: '600' } };
    valueAxis.title.display = false; catAxis.title.display = false;
    return new window.Chart(canvas, {
      type: cfg.type === 'line' ? 'line' : 'bar',
      data: {
        labels: result.labels,
        datasets: result.series.map((s, i) => ({
          label: s.name,
          data: s.data,
          backgroundColor: hlColors(cfg, s.data, colors[i % colors.length], multi || hist),
          borderWidth: cfg.type === 'line' ? 2 : hist ? 1 : 0,
          borderRadius: cfg.type === 'line' || stacked || hist ? 0 : 5,
          barPercentage: hist ? 1 : undefined,
          categoryPercentage: hist ? 1 : undefined,
          borderColor: hist ? cssVar('--surface') : colors[i % colors.length],
          pointRadius: cfg.type === 'line' ? 3 : undefined,
          tension: 0.2,
          maxBarThickness: hist ? undefined : 36
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: reducedMotion() ? 0 : 250 },
        indexAxis: horizontal ? 'y' : 'x',
        plugins: {
          legend: { display: multi, position: 'bottom', labels: { color: text, boxWidth: 12 } },
          tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + (hist ? ctx.parsed.y + '개' : fmtVal(horizontal ? ctx.parsed.x : ctx.parsed.y, cfg)) } }
        },
        scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis }
      }
    });
  }

  // 같은 그룹 안에서 순서 이동 (그래프·통계 구분 없음)
  function moveChart(id, d) {
    const cur = state.layout.findIndex((c) => c.id === id);
    if (cur < 0) return;
    const kind = state.layout[cur].kind;
    const grp = state.layout[cur].group || null;
    const same = state.layout.map((c, idx) => ((c.group || null) === grp ? idx : -1)).filter((x) => x >= 0);
    const pos = same.indexOf(cur);
    const j = same[pos + d];
    if (j === undefined) return;
    flashTarget = { chart: id };
    const t = state.layout[cur]; state.layout[cur] = state.layout[j]; state.layout[j] = t;
    saveLayout(); renderBoard();
  }

  // 복제: 바로 뒤에 같은 그룹으로, 제목은 '원래 제목 (2)'처럼 차례로 번호
  function duplicateChart(id) {
    const k = state.layout.findIndex((c) => c.id === id);
    if (k < 0 || state.layout.length >= MAX_CHARTS) return;
    const src = state.layout[k];
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    copy.title = uniqueTitle(src.title || autoTitle(src));
    // 이미 이어서 놓인 복제본(같은 제목 + 번호)이 있으면 그 뒤에
    const base = (src.title || autoTitle(src)).replace(/ \(\d+\)$/, '');
    const isCopy = (c) => c && (c.group || null) === (src.group || null) && new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(\\d+\\)$').test(c.title || '');
    let at = k + 1;
    while (isCopy(state.layout[at])) at++;
    state.layout.splice(at, 0, copy);
    flashTarget = { chart: copy.id };
    saveLayout(); renderBoard();
  }

  async function removeChart(id) {
    const cfg = state.layout.find((c) => c.id === id);
    if (!cfg) return;
    if (!(await askConfirm('‘' + (cfg.title || autoTitle(cfg)) + '’ 항목을 삭제합니다. 계속하시겠습니까?'))) return;
    state.layout = state.layout.filter((c) => c.id !== id);
    saveLayout(); renderBoard();
  }

  // ───────────── 항목 작성 창 ─────────────
  let draft = null;
  let previewChart = null;

  const info = (k) => state.keyInfo.get(k);

  // 행 구분 후보: 학번·이름 같은 식별 열, 또는 반처럼 같은 값이 반복되는 분류 열 (수치·날짜 열 제외)
  function labelCandidates() {
    const N = state.rows.length;
    const dateLike = /^\d{4}[-./]\d{1,2}([-./]\d{1,2})?/;
    const out = state.keys.filter((k) => {
      const ki = info(k);
      if (ki.type !== 'string' && ki.type !== 'boolean') return false;
      if (ki.idLike) return true;
      const vals = state.rows.map((r) => r[k]).filter((v) => !isBlank(v)).map(rawStr);
      if (!vals.length) return false;
      if (vals.filter((v) => dateLike.test(v)).length > vals.length / 2) return false;
      const d = new Set(vals).size;
      return d >= 2 && d <= Math.max(2, Math.floor(N / 2));
    });
    return out.length ? out : state.keys.filter((k) => info(k).type !== 'number');
  }

  function idKey() {
    const cand = labelCandidates();
    if (cand.length) return cand.find((k) => info(k).idLike) || cand[0];
    return state.keys.find((k) => info(k).idLike && info(k).type === 'string') ||
      state.keys.find((k) => info(k).idLike && info(k).type !== 'number') ||
      state.keys.find((k) => info(k).idLike) ||
      state.keys.find((k) => info(k).type === 'string') ||
      state.keys.find((k) => info(k).type !== 'number') || state.keys[0];
  }

  // 집계 단위: ‘학번별’·‘반별’(행 묶음) 또는 ‘열별’ 중 선택
  function updateLabHint() {
    const box = $('cf-by');
    if (!box || !draft) return;
    const cand = labelCandidates();
    if (draft.label && !cand.includes(draft.label) && state.keys.includes(draft.label)) cand.unshift(draft.label);
    box.replaceChildren();
    const mk = (text, on, fn) => { const b = el('button', 'chip', text); b.type = 'button'; b.setAttribute('aria-pressed', String(on)); b.addEventListener('click', fn); box.append(b); };
    cand.forEach((k) => mk(labelOf(k) + '별', draft.mode === 'row' && draft.label === k, () => {
      draft.mode = 'row'; draft.label = k;
      draft.cols = draft.cols.filter((x) => x !== k);
      if (!draft.cols.length) draft.cols = valueKeys(k);
      if (draft.type === 'bar' && state.rows.length > 12) draft.type = 'hbar';
      syncBuilder();
    }));
    mk('열별', draft.mode === 'col', () => { draft.mode = 'col'; if (draft.how === 'each') draft.how = 'sum'; if (draft.range) draft.range = draft.range; syncBuilder(); });
    const h = $('lab-hint');
    if (draft.mode === 'col') h.textContent = '선택한 열마다 막대 하나로 표시합니다. 예: 단원별 완료 인원';
    else {
      const ki = info(draft.label);
      const n = new Set(state.rows.map((r) => (isBlank(r[draft.label]) ? '' : rawStr(r[draft.label])))).size;
      h.textContent = ki.idLike
        ? labelOf(draft.label) + '마다 막대 하나로 표시합니다. 막대 ' + n + '개'
        : labelOf(draft.label) + ' 값이 같은 행을 묶어 막대 하나로 표시합니다. 막대 ' + n + '개';
    }
  }



  // 값을 담은 열 (학번·이름처럼 행마다 고유한 식별 열 제외)
  function valueKeys(excludeLabel) {
    const vals = state.keys.filter((k) => !info(k).idLike && k !== excludeLabel);
    return vals.length ? vals : state.keys.filter((k) => k !== excludeLabel);
  }

  function defaultConfig(kind) {
    const label = idKey();
    const base = { id: uid(), kind, title: '', type: 'bar', sort: 'none', width: 1, label };
    const nums = state.keys.filter((k) => info(k).type === 'number' && !info(k).idLike);
    if (kind === 'stat') {
      if (nums.length) return Object.assign(base, { mode: 'col', cols: [nums[0]], read: 'num', how: 'avg' });
      return Object.assign(base, { mode: 'col', cols: valueKeys(), read: 'filled', how: 'sum', pct: true });
    }
    if (nums.length) return Object.assign(base, { mode: 'row', cols: [nums[0]], read: 'num', how: 'sum', type: 'hbar' });
    return Object.assign(base, { mode: 'row', cols: valueKeys(label), read: 'filled', how: 'sum', type: 'hbar' });
  }

  function openChartDialog(id, kind, preset) {
    editingId = id || null;
    const src = id ? state.layout.find((c) => c.id === id) : preset || defaultConfig(kind || 'chart');
    peekBase = null; delete $("builder-visual").dataset.peek; autoStep = -1;
    draft = JSON.parse(JSON.stringify(src));
    if (!draft.kind) draft.kind = 'chart';
    kindDrafts = {};
    modeCols = {};
    if (!draft.label || !state.keys.includes(draft.label)) draft.label = idKey();
    $('cf-ok').textContent = id ? '적용' : '추가';
    if (id && !draft.title) draft.title = autoTitle(draft);
    $('cf-title').value = draft.title || '';
    $('cf-title').hidden = true; $('dlg-chart-title').hidden = false; $('btn-title-edit').hidden = false;
    showTitle();

    $('cf-error').textContent = '';
    applyKind();


    const mkChips = (boxId, list, field) => {
      const box = $(boxId);
      box.replaceChildren();
      list.forEach((x) => {
        const b = el('button', 'chip', x.label);
        b.type = 'button';
        b.dataset.id = x.id;
        b.addEventListener('click', () => {
          draft[field] = x.id;
          if (field === 'type' && x.id === 'list' && !draft.range && (draft.read === 'blank' || (draft.read === 'filled' && !draft.pct))) draft.range = { mode: 'ge', n: 1, unit: 'pct' };
          syncBuilder();
        });
        if (typeof x.id === 'number') b.dataset.num = '1';
        box.append(b);
      });
    };
    mkChips('cf-type', CHART_TYPES, 'type');
    mkChips('cf-sort', SORTS, 'sort');
    mkChips('cf-width', WIDTHS, 'width');
    $('cf-type').querySelectorAll('.chip').forEach((b) => {
      const t = CHART_TYPES.find((x) => x.id === b.dataset.id);
      if (t) b.prepend(icon(t.icon));
    });

    renderFilter();
    $('dlg-chart').showModal();
    setVisPane('preview');
    setVisCollapsed(false);
    syncBuilder();
    buildStepNav();
    $('builder-controls').scrollLeft = 0;
    $('builder-controls').scrollTop = 0;
  }

  // 개체 종류(그래프/통계)에 따라 단계 구성 변경
  function applyKind() {
    const stat = isStat(draft);
    const noun = stat ? '통계' : '그래프·표';
    $('kd-chart').setAttribute('aria-checked', String(!stat));
    if (!editingId) $('cf-ok').textContent = noun + ' 추가';
    $('kd-stat').setAttribute('aria-checked', String(stat));
    $('kind-name').textContent = noun + (editingId ? ' 설정' : ' 추가');
    // 그래프: 유형 → X축 → Y축 → 대상 행 → 서식 / 통계: 값 → 대상 행
    // 통계: 값 → 대상 행 (그래프와 같은 화면 구성, 유형·축·서식 단계 없음)
    $('step-item').hidden = stat;
    $('step-style').hidden = false;
    $('opt-width').hidden = stat;
    $('cf-type').hidden = stat; $('cf-stype').hidden = !stat;
    $('help-type').textContent = stat ? '숫자 하나로 무엇을 나타낼지 고릅니다. ‘비율’은 전체 칸 중 입력된 칸의 비율(예: 전체 진도율), ‘개수’는 칸이나 행의 수(예: 미해결 학생 수), ‘평균·합계·최고값·최저값’은 숫자 칸을 계산합니다. 각 카드에 실제 자료로 계산한 값이 표시됩니다.' : HELP_TYPE;
    ['step-cols', 'step-what'].forEach((id) => { $(id).hidden = true; });
    $('slot-cols').append($('step-usecols')); $('slot-method').append(document.querySelector('.calc-m')); $('slot-range').append($('range-sec'));
    if (stat) {
      $('step-value').dataset.name = '값';
      $('t-value').textContent = '값';
      document.querySelector('#step-value .ax-role').hidden = true;
      $('vname-label').textContent = '값 이름';
      $('slot-cols').append($('step-usecols')); $('usecols-label').textContent = '계산에 쓸 열';
      document.querySelector('.calc-m').hidden = true; $('stat-opt').hidden = false;
    } else {
      document.querySelector('#step-value .ax-role').hidden = false;
      $('vname-label').textContent = '축 이름';
      document.querySelector('.calc-m').hidden = false; $('stat-opt').hidden = true;
      orderAxes();
    }
    numberSteps();
    renderDraftColors();
  }
  let HELP_TYPE = '';
  function numberSteps() {
    visibleSteps().forEach((st, i) => { const b = st.querySelector('.step-q b'); if (b) b.textContent = String(i + 1); });
  }
  // 가로 막대는 항목이 Y축: 단계 순서를 항상 X축 → Y축으로 맞춤
  function orderAxes() {
    const hz = draft && draft.type === 'hbar';
    const it = $('step-item'), va = $('step-value');
    const itemIsX = !hz;
    $('t-item').textContent = itemIsX ? 'X축' : 'Y축';
    $('t-value').textContent = itemIsX ? 'Y축' : 'X축';
    it.dataset.name = (itemIsX ? 'X축' : 'Y축');
    va.dataset.name = (itemIsX ? 'Y축' : 'X축');
    const firstIsItem = it.compareDocumentPosition(va) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (itemIsX && !firstIsItem) va.before(it);
    if (!itemIsX && firstIsItem) it.before(va);
  }
  // 열 이름에서 숫자를 뺀 공통 이름 (예: 1단원~6단원 → 단원, 과제1~5 → 과제)
  function colGroupName(c) {
    const ls = selCols(c).filter((k) => state.keyInfo.has(k)).map((k) => labelOf(k).replace(/[0-9]+/g, '').replace(/[\s()._-]+/g, ' ').trim());
    if (ls.length > 1 && ls[0] && ls.every((x) => x === ls[0])) return ls[0];
    return '항목';
  }
  const defItemName = (c) => (c.mode === 'col' ? colGroupName(c) : labelOf(c.label));
  const defValueName = (c) => {
    if (isStat(c)) {
      if (c.statRow) return c.statRow === 'full' ? '모두 입력된 행 수' : '빈칸이 있는 행 수';
      const st = stypeOf(c);
      if (st === 'rate') return c.read === 'blank' ? '빈칸 비율(%)' : '입력률(%)';
      if (st === 'count') return c.read === 'blank' ? '빈칸 수' : '입력 칸 수';
    }
    // 숫자 계산은 열이 하나면 열 이름을 붙임 (예: 정답률(%) 평균)
    const cols = selCols(c).filter((k) => state.keyInfo.has(k));
    if (c.read === 'num' && cols.length === 1 && (isStat(c) || c.mode !== 'col')) return labelOf(cols[0]) + ' ' + metricLabel(c);
    return metricLabel(c);
  };
  function itemName(c) { return (c.itemName || '').trim() || defItemName(c); }
  function valueName(c) { return (c.valueName || '').trim() || defValueName(c); }
  // X축(항목) 선택: 학번·반 등 행 기준 열 또는 선택한 열
  function renderItem() {
    const box = $('cf-item');
    if (!box || isStat(draft)) return;
    box.replaceChildren();
    const cand = labelCandidates();
    if (draft.label && !cand.includes(draft.label) && state.keys.includes(draft.label)) cand.unshift(draft.label);
    // 실제 값 예시 카드: 막대에 붙을 이름을 자료에서 미리 보여 줌
    const sample = (arr) => {
      const v = arr.slice(0, 3).join(' · ');
      return arr.length > 3 ? v + ' … ' + arr.length + '개' : v;
    };
    const mk = (title, sub, on, fn) => {
      const b = el('button', 'ib-card');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.append(el('span', 'ib-t', title), el('span', 'ib-s', sub));
      b.addEventListener('click', fn);
      box.append(b);
    };
    cand.forEach((k) => {
      const vals = [...new Set(state.rows.map((r) => (isBlank(r[k]) ? '' : rawStr(r[k]))).filter((v) => v !== ''))];
      mk(labelOf(k) + '별', sample(vals), draft.mode === 'row' && draft.label === k, () => {
        if (draft.mode === 'col') { modeCols.col = draft.cols.slice(); if (modeCols.row) draft.cols = modeCols.row.slice(); }
        draft.mode = 'row'; draft.label = k;
        draft.cols = draft.cols.filter((x) => x !== k);
        if (!draft.cols.length) draft.cols = valueKeys(k);
        syncBuilder();
      });
    });
    // 열별 카드: 이름이 같은 열 묶음(예: 과제1~과제5)을 우선 사용
    const strip = (k) => labelOf(k).replace(/[0-9]+/g, '').replace(/[\s()._-]+/g, ' ').trim();
    let colKeys, cg;
    if (draft.mode === 'col') { colKeys = selCols(draft).filter((k) => state.keyInfo.has(k)); cg = colGroupName(draft); }
    else {
      // 숫자 계산 중이면 문자 열(예: 최근 제출일)은 제외
      const pool = state.keys.filter((k) => !cand.includes(k) && k !== draft.label && !(draft.read === 'num' && tyOf(k) === 'string'));
      const groups = new Map();
      pool.forEach((k) => { const g = strip(k); if (g) groups.set(g, (groups.get(g) || []).concat(k)); });
      const best = [...groups.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length)[0];
      colKeys = best ? best[1] : pool;
      cg = best ? best[0] : '항목';
    }
    const cgName = cg !== '항목' ? cg : '열';
    mk(cgName + '별', sample(colKeys.map(labelOf)), draft.mode === 'col', () => {
      if (draft.mode === 'col') return;
      modeCols.row = draft.cols.slice();
      draft.mode = 'col'; draft.cols = (modeCols.col && modeCols.col.length ? modeCols.col : colKeys).slice();
      if (draft.how === 'each') draft.how = 'sum';
      if (draft.type === 'hist' || draft.type === 'list') draft.type = 'bar';
      syncBuilder();
    });
    const unitW = draft.type === 'line' ? '점' : '막대';
    let hint;
    if (draft.mode === 'col') hint = '아래에서 고른 ' + cgName + '마다 ' + unitW + ' 하나를 표시합니다. 값은 전체 ' + state.rows.length + '행으로 계산합니다.';
    else {
      const n = new Set(state.rows.map((r) => (isBlank(r[draft.label]) ? '' : rawStr(r[draft.label])))).size;
      hint = info(draft.label).idLike ? labelOf(draft.label) + '마다 ' + unitW + ' 하나를 표시합니다(' + n + '개). 값은 Y축에서 고른 열로 계산합니다.' : '같은 ' + labelOf(draft.label) + '끼리 묶어 ' + unitW + ' 하나를 표시합니다(' + n + '개). 값은 Y축에서 고른 열로 계산합니다.';
    }
    $('item-hint').textContent = hint;
    // 열마다: X축에 놓을 열을 X축 단계에서 / 행마다: 계산에 쓸 열을 Y축 단계에서 선택
    const uc = $('step-usecols');
    if (draft.mode === 'col') { if (uc.parentNode !== $('slot-xcols')) $('slot-xcols').append(uc); $('usecols-label').textContent = '사용할 ' + cgName; }
    else { if (uc.parentNode !== $('slot-cols')) $('slot-cols').append(uc); $('usecols-label').textContent = '계산에 쓸 열'; }
    const ii = $('cf-iname'), vi = $('cf-vname');
    ii.placeholder = defItemName(draft); vi.placeholder = defValueName(draft);
    if (document.activeElement !== ii) ii.value = draft.itemName || '';
    if (document.activeElement !== vi) vi.value = draft.valueName || '';
  }

  // 그래프·통계 설정을 각각 보관: 전환했다가 돌아와도 이전 설정 유지
  let kindDrafts = {};
  // 항목 기준(행별·열별)마다 고른 열을 따로 기억: 열별을 눌렀다가 돌아와도 이전 선택 유지
  let modeCols = {};
  function setKind(kind) {
    if (draft.kind === kind) return;
    if (peekBase) { draft = peekBase; peekBase = null; delete $('builder-visual').dataset.peek; }
    kindDrafts[draft.kind] = draft;
    if (kindDrafts[kind]) {
      draft = kindDrafts[kind];
    } else {
      // 처음 전환할 때는 현재 선택한 행·열을 이어받음
      const prev = draft;
      draft = defaultConfig(kind);
      draft.id = prev.id;
      draft.label = prev.label;
      draft.title = prev.title;
      if (prev.cols.length) draft.cols = prev.cols.slice();
      if (prev.filter) draft.filter = JSON.parse(JSON.stringify(prev.filter));
      if (kind === 'stat' && draft.how === 'each') draft.how = 'sum';
    }
    renderFilter();
    $('cf-title').value = draft.title || '';
    showTitle();
    const curName = (visibleSteps()[currentStep()] || {}).dataset ? visibleSteps()[currentStep()].dataset.name : null;
    applyKind();
    buildStepNav();
    // 종류를 바꿔도 보던 단계 유지 (없는 단계면 첫 단계)
    const idx = Math.max(0, visibleSteps().findIndex((st) => st.dataset.name === curName));
    const box = $('builder-controls');
    const st = visibleSteps()[idx];
    if (st) box.scrollLeft = st.offsetLeft - box.offsetLeft;
    markStep();
    setVisPane($('builder-visual').dataset.pane);
    syncBuilder();
  }

  function renderColChips() {
    const box = $('cf-cols');
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    box.replaceChildren();
    state.keys.forEach((k) => {
      if (k === draft.label) return;
      const ki = info(k);
      const b = el('button', 'chip col-chip' + (ki.overridden ? ' custom' : ''));
      b.type = 'button';
      b.dataset.key = k;
      b.setAttribute('aria-pressed', String(draft.cols.includes(k)));
      b.title = '길게 누르거나 우클릭하여 자료형 변경';
      b.append(el('span', null, labelOf(k)), el('small', null, (ki.idLike ? '식별·' : '') + TYPE_LABEL[ki.type]));
      b.addEventListener('click', (e) => {
        if (b.dataset.lp === '1') { b.dataset.lp = ''; e.preventDefault(); return; }
        draft.cols = draft.cols.includes(k) ? draft.cols.filter((c) => c !== k) : state.keys.filter((c) => c === k || draft.cols.includes(c));
        syncBuilder();
      });
      bindLongPress(b, () => openColPop(k, b));
      box.append(b);
    });
    if (focused) { const f = box.querySelector('[data-key="' + CSS.escape(focused) + '"]'); if (f) f.focus(); }
  }

  // ───────────── 가로 스크롤 영역 보조 ─────────────
  // 숨겨진 쪽 가장자리 흐림 표시, 마우스: 가장자리에 올리면 자동 이동·휠·끌기 이동 (터치는 기본 밀기)
  function enhanceHScroll(box) {
    if (!box || box.dataset.hs) return;
    box.dataset.hs = '1';
    box.classList.add('hs');
    const update = () => {
      const max = box.scrollWidth - box.clientWidth;
      box.classList.toggle('fade-l', box.scrollLeft > 2);
      box.classList.toggle('fade-r', max > 2 && box.scrollLeft < max - 2);
    };
    box._hsUpdate = update;
    box.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);

    // 가장자리 자동 이동
    let speed = 0, raf = null;
    const loop = () => {
      if (!speed) { raf = null; return; }
      box.scrollLeft += speed;
      raf = requestAnimationFrame(loop);
    };
    box.addEventListener('mousemove', (e) => {
      if (dragging) return;
      const r = box.getBoundingClientRect();
      const edge = Math.min(56, r.width / 4);
      const x = e.clientX - r.left;
      speed = x < edge ? -Math.ceil((edge - x) / 6) : x > r.width - edge ? Math.ceil((x - (r.width - edge)) / 6) : 0;
      if (speed && !raf) raf = requestAnimationFrame(loop);
    });
    box.addEventListener('mouseleave', () => { speed = 0; });

    // 휠: 세로 휠을 가로 이동으로
    box.addEventListener('wheel', (e) => {
      if (box.scrollWidth <= box.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      box.scrollLeft += e.deltaY;
    }, { passive: false });

    // 마우스 끌기
    let dragging = false, moved = false, sx = 0, sl = 0;
    box.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      dragging = true; moved = false; sx = e.clientX; sl = box.scrollLeft; speed = 0;
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      if (Math.abs(dx) > 4) { moved = true; box.classList.add('dragging'); }
      if (moved) box.scrollLeft = sl - dx;
    });
    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      box.classList.remove('dragging');
      if (moved) box.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
    });
    requestAnimationFrame(update);
  }
  const hsRefresh = (box) => { if (box && box._hsUpdate) requestAnimationFrame(box._hsUpdate); };

  // ───────────── 단계 이동 (휴대전화: 좌우 넘김) ─────────────
  function visibleSteps() {
    return Array.from($('builder-controls').querySelectorAll(':scope > .step')).filter((s) => !s.hidden);
  }

  function buildStepNav() {
    const nav = $('step-nav');
    nav.replaceChildren();
    visibleSteps().forEach((st, i) => {
      const b = el('button', 'sn-item');
      b.type = 'button';
      b.append(el('span', 'sn-num', String(i + 1)), el('span', 'sn-name', st.dataset.name));
      b.addEventListener('click', () => goStep(i));
      nav.append(b);
    });
    enhanceHScroll(nav);
    markStep();
    hsRefresh(nav);
  }

  function gotoStepId(id) {
    const i = visibleSteps().findIndex((s) => s.id === id);
    if (i < 0) return;
    goStep(i);
    const st = visibleSteps()[i];
    if (!isNarrow()) st.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash');
  }

  function goStep(i) {
    const steps = visibleSteps();
    const st = steps[Math.max(0, Math.min(i, steps.length - 1))];
    if (!st) return;
    const box = $('builder-controls');
    // 즉시 이동 (부드러운 이동은 스크롤 맞춤과 겹쳐 느리게 느껴짐)
    box.style.scrollSnapType = 'none';
    box.scrollLeft = st.offsetLeft - box.offsetLeft;
    box.style.scrollSnapType = '';
    st.classList.remove('step-in'); void st.offsetWidth; st.classList.add('step-in');
    markStep();
  }

  function currentStep() {
    const box = $('builder-controls');
    const w = box.clientWidth || 1;
    return Math.round(box.scrollLeft / w);
  }

  // 단계에 맞춰 위쪽 보기 자동 전환: 선택 단계는 구조, 모양·제목 단계는 결과
  let autoStep = -1;
  function autoPane(idx) {
    if (idx === autoStep) return;
    autoStep = idx;
    const st = visibleSteps()[idx];
    if (!st) return;
    return;
    const want = 'schema';
    if ($('builder-visual').dataset.pane !== want) { setVisPane(want); if (want === 'preview') renderPreview(); }
  }
  function markStep() {
    const idx = currentStep();
    autoPane(idx);
    $('step-nav').querySelectorAll('.sn-item').forEach((b, i) => {
      b.setAttribute('aria-current', i === idx ? 'step' : 'false');
      if (i === idx) {
        const nav = $('step-nav');
        const l = b.offsetLeft - nav.offsetLeft, r = l + b.offsetWidth;
        if (l < nav.scrollLeft + 24) nav.scrollTo({ left: Math.max(0, l - 32), behavior: 'smooth' });
        else if (r > nav.scrollLeft + nav.clientWidth - 24) nav.scrollTo({ left: r - nav.clientWidth + 32, behavior: 'smooth' });
      }
    });
  }

  // 세부 설정 시트 안의 대상 열 선택 (가로 스크롤)
  function renderVisCols() {
    const box = $('vis-cols');
    const sl = box.scrollLeft;
    box.replaceChildren();
    state.keys.forEach((k) => {
      if (k === draft.label) return;
      const b = el('button', 'vchip', labelOf(k));
      b.type = 'button';
      b.dataset.key = k;
      b.setAttribute('aria-pressed', String(draft.cols.includes(k)));
      b.addEventListener('click', (e) => {
        if (b.dataset.lp === '1') { b.dataset.lp = ''; e.preventDefault(); return; }
        draft.cols = draft.cols.includes(k) ? draft.cols.filter((c) => c !== k) : state.keys.filter((c) => c === k || draft.cols.includes(c));
        syncBuilder();
      });
      bindLongPress(b, () => openColPop(k, b));
      box.append(b);
    });
    box.scrollLeft = sl;
    enhanceHScroll(box);
    hsRefresh(box);
  }

  // 길게 누르기(터치) 또는 우클릭(마우스)
  function bindLongPress(elm, fn) {
    let timer = null, sx = 0, sy = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    elm.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); if ($('col-pop').dataset.key !== elm.dataset.key || $('col-pop').hidden) fn(); });
    elm.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { timer = null; elm.dataset.lp = '1'; fn(); if (navigator.vibrate) { try { navigator.vibrate(10); } catch (x) { /* 무시 */ } } }, 480);
    });
    elm.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => elm.addEventListener(t, cancel));
  }

  // ───────────── 열 자료형 설정 창 ─────────────
  function openColPop(k, anchor) {
    const pop = $('col-pop');
    const ki = info(k);
    pop.dataset.key = k;
    $('cp-name').textContent = labelOf(k);
    const list = $('cp-types');
    list.replaceChildren();
    TYPE_ORDER.forEach((t) => {
      const b = el('button', 'cp-type');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(ki.type === t));
      b.append(el('span', 'cp-dot'), el('span', null, TYPE_LABEL[t]));
      if (ki.autoType === t) b.append(el('small', null, '자동'));
      b.addEventListener('click', () => changeType(k, t));
      list.append(b);
    });
    $('cp-id').checked = ki.idLike;
    $('cp-id-auto').textContent = ki.autoId ? '자동 판정: 식별' : '자동 판정: 일반';
    $('cp-reset').hidden = !ki.overridden;
    pop.hidden = false;
    // 위치: 열 단추 아래 (화면 밖으로 나가지 않게)
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function closeColPop() { $('col-pop').hidden = true; $('col-pop').dataset.key = ''; }

  async function changeType(k, t) {
    const ki = info(k);
    if (ki.type === t) return;
    if (t === 'number' && ki.type !== 'boolean') {
      // 수치로 해석할 수 없는 값의 개수
      const lost = state.rawRows.filter((r) => !isBlank(r[k]) && toNumber(r[k]) === null && typeof r[k] !== 'boolean').length;
      if (lost > 0) {
        closeColPop();
        const ok = await askConfirm('‘' + labelOf(k) + '’ 열을 수치로 전환하면 숫자로 해석할 수 없는 값 ' + lost + '개가 빈 값으로 대체됩니다. 계속하시겠습니까?');
        if (!ok) return;
      }
    }
    setOverride(k, { type: t === ki.autoType ? undefined : t });
  }

  function setOverride(k, patch) {
    const cur = Object.assign({}, state.typeOver[k] || {}, patch);
    Object.keys(cur).forEach((x) => { if (cur[x] === undefined) delete cur[x]; });
    if (Object.keys(cur).length) state.typeOver[k] = cur; else delete state.typeOver[k];
    afterTypeChange(k);
  }

  function afterTypeChange(k) {
    applyTypes();
    saveTypes();
    syncBuilder();
    renderBoard();
    if (k && !$('col-pop').hidden && $('col-pop').dataset.key === k) {
      const sel = '[data-key="' + CSS.escape(k) + '"]';
      const fromSheet = $('builder-visual').dataset.collapsed === 'false' && isNarrow();
      const anchor = (fromSheet && $('vis-cols').querySelector(sel)) || $('cf-cols').querySelector(sel);
      if (anchor) openColPop(k, anchor); else closeColPop();
    }
  }

  // 접힌 미리보기 막대에 표시할 요약
  function visSummary() {
    const r = compute(draft);
    if (r.error) return '열 미선택';
    if (isStat(draft)) return metricLabel(draft) + ' ' + fmtVal(r.value, draft);
    return metricLabel(draft) + ' · 막대 ' + r.labels.length + '개';
  }

  function recipeText() {
    if (!isStat(draft) && draft.mode === 'row' && draft.how === 'each') return '‘' + readLabel(draft.read) + '’ 값을 열별로 개별 표시';
    return '‘' + readLabel(draft.read) + '’ × ‘' + combineLabel(effHow(draft)) + '’ = ' + metricLabel(draft) + (isPercent(draft) ? ' (' + pctFormula(draft) + ')' : '');
  }

  // ───────────── 산출 기준 (미리 정한 조합) ─────────────
  // 집계 기준(mode)·칸 해석(read)·계산(how)·비율(pct)을 일상적인 이름 하나로 묶은 선택지
  function presetList() {
    const L = labelOf(draft.label);
    if (isStat(draft)) {
      return [
        { id: 's-pct', num: false, label: '전체 입력률(%)', desc: '선택한 열의 모든 칸 중 값이 입력된 칸의 비율 (예: 전체 진도율)', p: { read: 'filled', how: 'sum', pct: true } },
        { id: 's-cnt', num: false, label: '전체 입력 칸 수', desc: '선택한 열의 모든 칸 중 값이 입력된 칸의 수', p: { read: 'filled', how: 'sum', pct: false } },
        { id: 's-blank', num: false, label: '전체 미입력 칸 수', desc: '선택한 열의 모든 칸 중 빈칸의 수 (예: 미제출 건수)', p: { read: 'blank', how: 'sum', pct: false } },
        { id: 's-sum', num: true, label: '전체 합계', desc: '선택한 열의 모든 칸의 숫자 합', p: { read: 'num', how: 'sum', pct: false } },
        { id: 's-avg', num: true, label: '전체 평균', desc: '선택한 열의 모든 칸의 숫자 평균', p: { read: 'num', how: 'avg', pct: false } },
        { id: 's-max', num: true, label: '최댓값', desc: '선택한 열의 모든 칸 중 가장 큰 값', p: { read: 'num', how: 'max', pct: false } },
        { id: 's-min', num: true, label: '최솟값', desc: '선택한 열의 모든 칸 중 가장 작은 값', p: { read: 'num', how: 'min', pct: false } }
      ];
    }
    return [
      { id: 'r-sum', num: true, label: L + '별 합계', desc: '행마다 선택한 열의 숫자를 더함 (예: 학생별 총점)', p: { mode: 'row', read: 'num', how: 'sum', pct: false } },
      { id: 'r-avg', num: true, label: L + '별 평균', desc: '행마다 선택한 열의 숫자 평균 (예: 학생별 평균 점수)', p: { mode: 'row', read: 'num', how: 'avg', pct: false } },
      { id: 'r-each-num', num: true, label: L + '별 값 (열별 구분)', desc: '행마다 열별 값을 나란히 표시', p: { mode: 'row', read: 'num', how: 'each', pct: false } },
      { id: 'c-avg', num: true, label: '열별 평균', desc: '열마다 모든 행의 숫자 평균 (예: 문항별 평균 점수)', p: { mode: 'col', read: 'num', how: 'avg', pct: false } },
      { id: 'c-sum', num: true, label: '열별 합계', desc: '열마다 모든 행의 숫자 합', p: { mode: 'col', read: 'num', how: 'sum', pct: false } },
      { id: 'c-max', num: true, label: '열별 최댓값', desc: '열마다 가장 큰 값', p: { mode: 'col', read: 'num', how: 'max', pct: false } },
      { id: 'c-min', num: true, label: '열별 최솟값', desc: '열마다 가장 작은 값', p: { mode: 'col', read: 'num', how: 'min', pct: false } },
      { id: 'r-pct', num: false, label: L + '별 입력률(%)', desc: '행마다 선택한 열 중 입력된 칸의 비율 (예: 학생별 진도율)', p: { mode: 'row', read: 'filled', how: 'sum', pct: true } },
      { id: 'r-cnt', num: false, label: L + '별 입력 칸 수', desc: '행마다 선택한 열 중 입력된 칸의 수 (예: 완료한 단원 수)', p: { mode: 'row', read: 'filled', how: 'sum', pct: false } },
      { id: 'r-each', num: false, label: L + '별 입력 현황 (열별 구분)', desc: '행마다 어느 열이 입력되었는지 쌓아서 표시', p: { mode: 'row', read: 'filled', how: 'each', pct: false } },
      { id: 'r-blank', num: false, label: L + '별 미입력 칸 수', desc: '행마다 빈칸의 수 (예: 미완료 단원 수)', p: { mode: 'row', read: 'blank', how: 'sum', pct: false } },
      { id: 'c-cnt', num: false, label: '열별 입력 칸 수', desc: '열마다 값이 입력된 행의 수 (예: 단원별 완료 인원)', p: { mode: 'col', read: 'filled', how: 'sum', pct: false } },
      { id: 'c-pct', num: false, label: '열별 입력률(%)', desc: '열마다 입력된 행의 비율 (예: 단원별 완료율)', p: { mode: 'col', read: 'filled', how: 'sum', pct: true } },
      { id: 'c-blank', num: false, label: '열별 미입력 칸 수', desc: '열마다 빈칸의 수 (예: 단원별 미완료 인원)', p: { mode: 'col', read: 'blank', how: 'sum', pct: false } }
    ];
  }

  function presetMatches(x) {
    return Object.keys(x.p).every((k) => (k === 'pct' ? !!draft.pct === x.p.pct : draft[k] === x.p[k]));
  }

  // 각 선택지의 예시 값 (첫 항목)
  function presetSample(x) {
    const test = Object.assign({}, draft, x.p, { type: 'bar', sort: 'none' });
    const r = compute(test, { noSort: true });
    if (r.error) return '';
    if (isStat(test)) return '결과: ' + fmtVal(r.value, test);
    if (!r.labels.length) return '';
    if (test.how === 'each') return '예: ' + r.labels[0] + ' → 열 ' + r.series.length + '개 구분';
    return '예: ' + r.labels[0] + ' → ' + fmtVal(r.series[0].data[0], test);
  }

  // ── 통계 유형: 비율·개수·평균·합계·최고값·최저값 ──
  const STYPES = [
    { id: 'rate', label: '비율', icon: '%', desc: '전체 칸 중 입력된(또는 빈) 칸의 비율', ex: '예: 전체 진도율' },
    { id: 'count', label: '개수', icon: '#', desc: '입력된·빈 칸 수, 또는 조건에 맞는 행 수', ex: '예: 빈칸 수' },
    { id: 'avg', label: '평균', icon: 'x̄', num: true, desc: '숫자 칸의 평균', ex: '예: 평균 정답률' },
    { id: 'sum', label: '합계', icon: 'Σ', num: true, desc: '숫자 칸의 합', ex: '예: 총 해결 문항 수' },
    { id: 'max', label: '최고값', icon: '↑', num: true, desc: '숫자 칸 중 가장 큰 값', ex: '예: 최고 점수' },
    { id: 'min', label: '최저값', icon: '↓', num: true, desc: '숫자 칸 중 가장 작은 값', ex: '예: 최저 점수' }
  ];
  const SOPTS = {
    rate: [{ id: 'filled', label: '입력된 칸', p: { read: 'filled', pct: true } }, { id: 'blank', label: '빈칸', p: { read: 'blank', pct: true } }],
    count: [
      { id: 'blank', label: '빈칸', p: { read: 'blank', pct: false, statRow: null } },
      { id: 'filled', label: '입력된 칸', p: { read: 'filled', pct: false, statRow: null } },
      { id: 'gap', label: '빈칸이 있는 행', p: { read: 'blank', pct: false, statRow: 'gap' } },
      { id: 'full', label: '모두 입력된 행', p: { read: 'filled', pct: false, statRow: 'full' } }
    ]
  };
  function stypeOf(c) {
    if (c.statRow) return 'count';
    if (c.read === 'num') return ({ avg: 'avg', sum: 'sum', max: 'max', min: 'min' })[c.how] || 'avg';
    return c.pct ? 'rate' : 'count';
  }
  function soptOf(c) { return c.statRow ? c.statRow : c.read === 'blank' ? 'blank' : 'filled'; }
  function setStype(id) {
    draft.statRow = null;
    if (id === 'rate') Object.assign(draft, { read: 'filled', how: 'sum', pct: true });
    else if (id === 'count') Object.assign(draft, { read: 'blank', how: 'sum', pct: false });
    else Object.assign(draft, { read: 'num', how: id, pct: false });
    syncBuilder();
  }
  function statSub(result, cfg) {
    if (cfg.statRow && cfg.range && result.rangeInfo) return '전체 ' + result.rangeInfo.before.toLocaleString('ko-KR') + '행 중 ' + rangeText(cfg) + '에 해당하는 행';
    if (cfg.statRow) return '행 ' + result.rowCount.toLocaleString('ko-KR') + '개 중 ' + (cfg.statRow === 'full' ? '선택한 열이 모두 입력된 행' : '빈칸이 하나라도 있는 행');
    const st = stypeOf(cfg);
    if (st === 'rate') return '칸 ' + result.cells.toLocaleString('ko-KR') + '개 중 ' + (cfg.read === 'blank' ? '빈칸' : '입력된 칸') + '의 비율';
    if (st === 'count') return '칸 ' + result.cells.toLocaleString('ko-KR') + '개 중 ' + (cfg.read === 'blank' ? '빈칸' : '입력된 칸') + ' 수';
    return '숫자 칸 ' + result.cells.toLocaleString('ko-KR') + '개의 ' + (STYPES.find((t) => t.id === st) || {}).label;
  }
  function renderStype() {
    if (!isStat(draft)) return;
    const vi = $('cf-vname');
    vi.placeholder = defValueName(draft);
    if (document.activeElement !== vi) vi.value = draft.valueName || '';
    const cols = selCols(draft).filter((k) => state.keyInfo.has(k));
    const hasText = cols.some((k) => info(k).type === 'string');
    const cur = stypeOf(draft);
    const box = $('cf-stype');
    box.replaceChildren();
    STYPES.forEach((t) => {
      const b = el('button', 'st-card');
      b.type = 'button';
      const off = t.num && hasText;
      b.setAttribute('aria-pressed', String(cur === t.id));
      if (off) b.classList.add('warn');
      const test = Object.assign({}, draft, { statRow: null, range: null });
      if (t.id === 'rate') Object.assign(test, { read: 'filled', how: 'sum', pct: true });
      else if (t.id === 'count') Object.assign(test, { read: 'blank', how: 'sum', pct: false });
      else Object.assign(test, { read: 'num', how: t.id, pct: false });
      const r = off ? null : compute(test);
      b.append(el('span', 'st-ic', t.icon), el('b', null, t.label), el('small', null, t.desc),
        el('span', 'st-ex', off ? '숫자 열에서만 계산 가능' : (r && !r.error ? fmtVal(r.value, test) + ' · ' : '') + t.ex.replace('예: ', '')));
      b.addEventListener('click', () => setStype(t.id));
      box.append(b);
    });
    // 값 단계: 유형별 세부 선택
    const so = $('stat-opt');
    so.replaceChildren();
    const opts = SOPTS[cur];
    so.hidden = !opts;
    if (opts) {
      so.append(el('div', 'field-head', ''));
      so.firstChild.append(el('span', 'field-label', cur === 'rate' ? '비율 기준' : '개수 기준'));
      const chips = el('div', 'chips');
      const sel = soptOf(draft);
      opts.forEach((o) => {
        const c = el('button', 'chip', o.label);
        c.type = 'button';
        c.setAttribute('aria-pressed', String(sel === o.id));
        c.addEventListener('click', () => { Object.assign(draft, { how: 'sum' }, o.p); syncBuilder(); });
        chips.append(c);
      });
      so.append(chips);
      if (cur === 'count') so.append(el('p', 'by-hint', '‘빈칸이 있는 행’은 선택한 열 중 하나라도 빈 행(예: 미해결 학생 수), ‘모두 입력된 행’은 모두 입력된 행(예: 모든 문항 해결 학생 수)을 셉니다.'));
    }
  }

  // ── 계산: 방향(열마다·행마다·전체 하나로) + 방식 ──
  const METHODS = [
    { id: 'avg', label: '평균', num: true, p: { read: 'num', how: 'avg', pct: false } },
    { id: 'sum', label: '합계', num: true, p: { read: 'num', how: 'sum', pct: false } },
    { id: 'max', label: '최댓값', num: true, p: { read: 'num', how: 'max', pct: false } },
    { id: 'min', label: '최솟값', num: true, p: { read: 'num', how: 'min', pct: false } },
    { id: 'cnt', label: '입력 칸 수', p: { read: 'filled', how: 'sum', pct: false } },
    { id: 'rate', label: '입력률(%)', p: { read: 'filled', how: 'sum', pct: true } },
    { id: 'blank', label: '미입력 칸 수', p: { read: 'blank', how: 'sum', pct: false } }
  ];
  const curDir = () => (isStat(draft) ? 'all' : draft.mode === 'col' ? 'col' : 'row');
  function methodOf(c) {
    const m = METHODS.find((x) => x.p.read === c.read && x.p.how === (c.how === 'each' ? 'sum' : c.how) && (x.p.read !== 'filled' || x.p.pct === !!c.pct));
    return m ? m.id : null;
  }
  const DIR_ICON = {
    col: '<svg viewBox="0 0 40 28" aria-hidden="true"><rect x="1" y="1" width="38" height="26" rx="3" class="t"/><path d="M14 1v26M27 1v26M1 10h38M1 19h38" class="g"/><path d="M7.5 6v15M20.5 6v15M33.5 6v15" class="a"/><path d="M5 18l2.5 3 2.5-3M18 18l2.5 3 2.5-3M31 18l2.5 3 2.5-3" class="a"/></svg>',
    row: '<svg viewBox="0 0 40 28" aria-hidden="true"><rect x="1" y="1" width="38" height="26" rx="3" class="t"/><path d="M14 1v26M27 1v26M1 10h38M1 19h38" class="g"/><path d="M5 5.5h29M5 14.5h29M5 23h29" class="a"/><path d="M31 3l3 2.5-3 2.5M31 12l3 2.5-3 2.5M31 20.5l3 2.5-3 2.5" class="a"/></svg>',
    all: '<svg viewBox="0 0 40 28" aria-hidden="true"><rect x="1" y="1" width="38" height="26" rx="3" class="t f"/><path d="M14 1v26M27 1v26M1 10h38M1 19h38" class="g"/></svg>'
  };
  function setDir(d) {
    if (curDir() === d) return;
    const curName = (visibleSteps()[currentStep()] || {}).dataset ? visibleSteps()[currentStep()].dataset.name : null;
    if (d === 'all') draft.kind = 'stat';
    else {
      draft.kind = 'chart';
      draft.mode = d;
      if (d === 'row' && (!draft.label || !state.keys.includes(draft.label))) draft.label = idKey();
      if (d === 'row') draft.cols = draft.cols.filter((k) => k !== draft.label);
      if (d === 'col' && (draft.type === 'hist' || draft.type === 'list')) draft.type = 'bar';
    }
    if (draft.how === 'each') draft.how = 'sum';
    applyKind();
    buildStepNav();
    const idx = Math.max(0, visibleSteps().findIndex((st) => st.dataset.name === curName));
    const st = visibleSteps()[idx];
    if (st) $('builder-controls').scrollLeft = st.offsetLeft - $('builder-controls').offsetLeft;
    markStep();
    setVisPane($('builder-visual').dataset.pane);
    syncBuilder();
  }
  function renderCalc() {
    const cols = selCols(draft).filter((k) => state.keyInfo.has(k));
    // 방향
    const dbox = $('cf-dir');
    dbox.replaceChildren();
    const groups = draft.label && state.keys.includes(draft.label) ? new Set(state.rows.map((r) => (isBlank(r[draft.label]) ? '' : rawStr(r[draft.label])))).size : state.rows.length;
    const rowLab = draft.label && state.keys.includes(draft.label) ? labelOf(draft.label) : '행';
    [['col', '열마다', '열마다 값 하나 · ' + cols.length + '개'], ['row', '행마다', rowLab + '마다 값 하나 · ' + groups + '개'], ['all', '전체 하나로', '모든 칸을 값 하나로']].forEach(([id, t, s]) => {
      const b = el('button', 'dir-card');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(curDir() === id));
      const ic = el('span', 'dir-ic'); ic.innerHTML = DIR_ICON[id];
      b.append(ic, el('b', null, t), el('small', null, s));
      b.addEventListener('click', () => setDir(id));
      dbox.append(b);
    });
    // 행 기준 (행마다)
    const rb = $('row-by');
    rb.hidden = curDir() !== 'row';
    rb.replaceChildren();
    if (curDir() === 'row') {
      const cand = labelCandidates();
      if (draft.label && !cand.includes(draft.label) && state.keys.includes(draft.label)) cand.unshift(draft.label);
      rb.append(el('span', 'by-lead', '기준'));
      const chips = el('div', 'chips');
      cand.forEach((k) => {
        const c = el('button', 'chip', labelOf(k) + '마다');
        c.type = 'button';
        c.setAttribute('aria-pressed', String(draft.label === k));
        c.addEventListener('click', () => { draft.label = k; draft.cols = draft.cols.filter((x) => x !== k); if (!draft.cols.length) draft.cols = valueKeys(k); syncBuilder(); });
        chips.append(c);
      });
      rb.append(chips);
      if (!info(draft.label).idLike) rb.append(el('p', 'by-hint', '같은 ' + labelOf(draft.label) + '끼리 묶어 계산합니다.'));
    }
    // 방식
    const hasText = cols.some((k) => info(k).type === 'string');
    const textCols = cols.filter((k) => info(k).type === 'string').map(labelOf);
    const mbox = $('cf-method');
    mbox.replaceChildren();
    const cur = methodOf(draft);
    METHODS.forEach((m) => {
      const c = el('button', 'chip', m.label);
      c.type = 'button';
      c.setAttribute('aria-pressed', String(cur === m.id));
      if (m.num && hasText) { c.classList.add('warn'); c.title = '문자 열이 포함되어 있어 계산할 수 없습니다.'; }
      c.addEventListener('click', () => { Object.assign(draft, m.p); syncBuilder(); });
      mbox.append(c);
      if (m.id === 'min') mbox.append(el('span', 'chip-sep'));
    });
    const note = $('method-note');
    note.hidden = true; // 계산 불가 사유는 위쪽 결과 영역에 표시
    if (hasText) note.textContent = '문자 열(' + textCols.slice(0, 3).join(', ') + (textCols.length > 3 ? ' 외 ' + (textCols.length - 3) + '개' : '') + ')이 있어 평균·합계 등 숫자 계산은 선택할 수 없습니다. 위 ‘사용할 열’에서 수치 열만 선택하거나, 열을 길게 눌러 자료형을 변경하십시오.';
    // 결과 예
    const ex = $('method-ex');
    const r = compute(Object.assign({}, draft, { type: 'bar', sort: 'none', range: null }), { noSort: true });
    ex.textContent = r.error ? '' : isStat(draft) ? '결과: ' + fmtVal(r.value, draft) : r.labels.length ? '결과 예: ' + r.labels[0] + ' → ' + fmtVal(r.series[0].data[0], draft) + (r.labels.length > 1 ? ', ' + r.labels[1] + ' → ' + fmtVal(r.series[0].data[1], draft) : '') + ' …' : '';
    // 표시 단계: 명단·히스토그램은 행마다에서만
    const isRow = curDir() === 'row';
    $('cf-type').querySelectorAll('.chip').forEach((b) => { if (b.dataset.id === 'list') b.disabled = !isRow; });
    if ($('cf-align')) $('cf-align').querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String((draft.align || 'right') === b.dataset.id)));
    if ($('cf-hl')) $('cf-hl').querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String((draft.hl || 'none') === b.dataset.id)));
  }

  // ── 대상 행: 열별 필터 (열 하나에 조건 하나, 열끼리는 모두 만족) ──
  function filterRoot() {
    if (!isGroup(draft.filter)) draft.filter = { op: 'and', not: false, items: [] };
    return draft.filter;
  }
  const ffKind = (k) => (tyOf(k) === 'number' ? 'range' : 'vals');
  function valueCounts(k) {
    const m = new Map();
    let blank = 0;
    for (const r of state.rows) {
      if (isBlank(r[k])) { blank++; continue; }
      const s = rawStr(r[k]);
      m.set(s, (m.get(s) || 0) + 1);
    }
    return { list: Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0], 'ko', { numeric: true })), blank };
  }
  function numsOf(k) {
    const out = [];
    for (const r of state.rows) { const v = r[k]; const a = typeof v === 'number' ? v : typeof v === 'string' ? parseNumStr(v) : null; if (a !== null) out.push(a); }
    return out;
  }
  function renderFilter() {
    const box = $('cf-filter');
    if (!box || !draft) return;
    const root = filterRoot();
    box.replaceChildren();
    root.items.forEach((c, i) => {
      const row = el('div', 'ff-row');
      const main = el('button', 'ff-main');
      main.type = 'button';
      main.append(el('span', 'ff-col', labelOf(c.col)), el('span', 'ff-sum', c.kind ? ffSummary(c) : exprText(c, true).replace(labelOf(c.col) + ' ', '')));
      main.title = '눌러서 수정';
      if (c.kind) main.addEventListener('click', () => openFF(c, false));
      row.append(main, miniBtn('fx-btn', 'x', labelOf(c.col) + ' 조건 삭제', () => { root.items.splice(i, 1); filterChanged(); }));
      box.append(row);
    });
    const add = el('button', 'ff-add', '＋ 조건 추가');
    add.type = 'button';
    add.addEventListener('click', openColPick);
    box.append(add);
  }
  function filterChanged() { renderFilter(); syncBuilder(); }
  function miniBtn(cls, name, label, fn) {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(name));
    b.addEventListener('click', fn);
    return b;
  }
  // 선택 창 (아래에서 올라오는 창)
  let ffWork = null, ffTarget = null, ffQuery = '';
  function openColPick() {
    ffWork = null; ffTarget = null;
    const used = new Set(filterRoot().items.map((c) => c.col));
    $('ff-title').textContent = '조건 기준 열';
    $('ff-ok').hidden = true;
    const body = $('ff-body');
    body.replaceChildren();
    const list = el('div', 'ff-cols');
    state.keys.forEach((k) => {
      const b = el('button', 'ff-colbtn');
      b.type = 'button';
      b.append(el('span', null, labelOf(k)), el('small', null, used.has(k) ? '조건 있음' : (ffKind(k) === 'range' ? '범위 선택' : '값 선택')));
      b.addEventListener('click', () => {
        const ex = filterRoot().items.find((c) => c.col === k && c.kind);
        if (ex) { openFF(ex, false); return; }
        const nums = numsOf(k);
        const c = ffKind(k) === 'range'
          ? { col: k, kind: 'range', not: false, lo: nums.length ? Math.min.apply(null, nums) : null, hi: nums.length ? Math.max.apply(null, nums) : null }
          : { col: k, kind: 'vals', not: false, blank: false, vals: [] };
        openFF(c, true);
      });
      list.append(b);
    });
    body.append(list);
    if (!$('dlg-ff').open) $('dlg-ff').showModal();
  }
  function openFF(c, isNew) {
    ffTarget = isNew ? null : c;
    ffWork = JSON.parse(JSON.stringify(c));
    ffQuery = '';
    $('ff-title').textContent = labelOf(c.col);
    $('ff-ok').hidden = false;
    renderFF();
    if (!$('dlg-ff').open) $('dlg-ff').showModal();
  }
  function ffSeg(a, b) {
    const seg = el('div', 'seg-wide');
    [[false, a], [true, b]].forEach(([v, t]) => {
      const x = el('button', null, t);
      x.type = 'button';
      x.setAttribute('aria-pressed', String(ffWork.not === v));
      x.addEventListener('click', () => { ffWork.not = v; seg.querySelectorAll('button').forEach((y, i) => y.setAttribute('aria-pressed', String((i === 1) === v))); ffCount(); });
      seg.append(x);
    });
    return seg;
  }
  function renderFF() {
    const w = ffWork;
    const body = $('ff-body');
    body.replaceChildren();
    if (w.kind === 'vals') {
      body.append(ffSeg('선택한 값만', '선택한 값 제외'));
      const { list, blank } = valueCounts(w.col);
      const tools = el('div', 'ff-tools');
      if (list.length > 10) {
        const q = el('input', 'ff-search');
        q.type = 'text'; q.placeholder = '값 검색'; q.value = ffQuery;
        q.setAttribute('aria-label', '값 검색');
        q.addEventListener('input', () => { ffQuery = q.value; drawList(); });
        tools.append(q);
      }
      const all = el('button', 'link', '전체 선택'); all.type = 'button';
      const none = el('button', 'link', '선택 해제'); none.type = 'button';
      all.addEventListener('click', () => { w.vals = list.map((x) => x[0]); w.blank = blank > 0; drawList(); });
      none.addEventListener('click', () => { w.vals = []; w.blank = false; drawList(); });
      tools.append(el('span', 'ff-sp'), all, none);
      const ul = el('div', 'ff-list');
      body.append(tools, ul);
      const drawList = () => {
        ul.replaceChildren();
        const q = ffQuery.trim();
        const items = list.filter((x) => !q || x[0].includes(q));
        if (blank && (!q || '(빈칸)'.includes(q))) items.push([null, blank]);
        items.forEach(([v, n]) => {
          const lab = el('label', 'ff-item');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = v === null ? !!w.blank : w.vals.includes(v);
          cb.addEventListener('change', () => {
            if (v === null) w.blank = cb.checked;
            else if (cb.checked) { if (!w.vals.includes(v)) w.vals.push(v); }
            else w.vals = w.vals.filter((x) => x !== v);
            ffCount();
          });
          lab.append(cb, el('span', 'ff-v' + (v === null ? ' blank' : ''), v === null ? '(빈칸)' : v), el('span', 'ff-n', n + '행'));
          ul.append(lab);
        });
        if (!items.length) ul.append(el('p', 'ff-none', '일치하는 값이 없습니다.'));
        ffCount();
      };
      drawList();
    } else {
      body.append(ffSeg('범위 안', '범위 밖'));
      const nums = numsOf(w.col);
      if (!nums.length) { body.append(el('p', 'ff-none', '이 열에는 숫자 값이 없습니다.')); ffCount(); return; }
      const mn = Math.min.apply(null, nums), mx = Math.max.apply(null, nums);
      const ints = nums.every((x) => Number.isInteger(x));
      const step = ints ? 1 : +((mx - mn) / 100 || 1).toPrecision(2);
      if (w.lo == null) w.lo = mn;
      if (w.hi == null) w.hi = mx;
      // 분포 막대
      const B = Math.min(12, Math.max(4, ints ? mx - mn + 1 : 10));
      const bw = (mx - mn) / B || 1;
      const bins = new Array(B).fill(0);
      nums.forEach((x) => { bins[Math.min(B - 1, Math.floor((x - mn) / bw))]++; });
      const top = Math.max.apply(null, bins);
      const hist = el('div', 'ff-hist');
      const bars = bins.map((n, i) => { const s = el('i'); s.style.height = Math.max(4, n / top * 100) + '%'; s.title = fmtNum(mn + i * bw) + ' ~ ' + fmtNum(mn + (i + 1) * bw) + ': ' + n + '행'; hist.append(s); return s; });
      const sl = el('div', 'ff-slider');
      const fill = el('span', 'ff-fill');
      const r1 = el('input'), r2 = el('input');
      [r1, r2].forEach((r) => { r.type = 'range'; r.min = mn; r.max = mx; r.step = step; });
      r1.value = w.lo; r2.value = w.hi;
      r1.setAttribute('aria-label', '최솟값'); r2.setAttribute('aria-label', '최댓값');
      sl.append(fill, r1, r2);
      const nums2 = el('div', 'ff-nums');
      const n1 = el('input'), n2 = el('input');
      [n1, n2].forEach((n) => { n.type = 'text'; n.inputMode = 'decimal'; });
      n1.value = fmtNum(w.lo).replace(/,/g, ''); n2.value = fmtNum(w.hi).replace(/,/g, '');
      n1.setAttribute('aria-label', '최솟값'); n2.setAttribute('aria-label', '최댓값');
      nums2.append(n1, el('span', null, '~'), n2);
      const paint = () => {
        const p = (x) => ((x - mn) / ((mx - mn) || 1)) * 100;
        fill.style.left = p(Math.min(w.lo, w.hi)) + '%';
        fill.style.width = Math.abs(p(w.hi) - p(w.lo)) + '%';
        bars.forEach((s, i) => { const a = mn + i * bw, b = a + bw; const inR = b > w.lo && a <= w.hi; s.classList.toggle('in', w.not ? !inR : inR); });
        ffCount();
      };
      r1.addEventListener('input', () => { w.lo = Math.min(+r1.value, w.hi); r1.value = w.lo; n1.value = fmtNum(w.lo).replace(/,/g, ''); paint(); });
      r2.addEventListener('input', () => { w.hi = Math.max(+r2.value, w.lo); r2.value = w.hi; n2.value = fmtNum(w.hi).replace(/,/g, ''); paint(); });
      n1.addEventListener('input', () => { const v = parseNumStr(n1.value); if (v !== null) { w.lo = v; r1.value = v; paint(); } });
      n2.addEventListener('input', () => { const v = parseNumStr(n2.value); if (v !== null) { w.hi = v; r2.value = v; paint(); } });
      body.append(hist, sl, nums2);
      body.querySelectorAll('.seg-wide button').forEach((b) => b.addEventListener('click', paint));
      paint();
    }
  }
  function ffCount() {
    const items = filterRoot().items.filter((c) => c !== ffTarget).concat([ffWork]);
    const g = { op: 'and', not: false, items };
    const n = state.rows.filter((r) => evalNode(g, r)).length;
    const ok = $('ff-ok');
    ok.textContent = '적용 · ' + n + '행';
    ok.classList.toggle('zero', n === 0);
  }
  function closeFF(apply) {
    if (apply && ffWork) {
      if (ffWork.lo != null && ffWork.hi != null && ffWork.lo > ffWork.hi) { const t = ffWork.lo; ffWork.lo = ffWork.hi; ffWork.hi = t; }
      const root = filterRoot();
      if (ffTarget) Object.assign(ffTarget, ffWork); else root.items.push(ffWork);
    }
    ffWork = null; ffTarget = null;
    $('dlg-ff').close();
    filterChanged();
  }
  function updateFilterSum() {
    const s = $('cf-filter-sum');
    if (!s) return;
    const N = state.rows.length;
    if (!filterOn(draft)) { s.replaceChildren(el('b', null, '조건 없음'), document.createTextNode(' · 모든 행(' + N + '개)을 사용합니다.')); return; }
    const n = state.rows.filter((r) => evalNode(draft.filter, r)).length;
    s.replaceChildren(el('b', n ? null : 'zero', '조건에 맞는 행 ' + n + '개'), document.createTextNode(' / 전체 ' + N + '개'));
  }
  // ── 산출 범위 (산출 기준 단계) ──
  function renderRange() {
    const sec = $('range-sec');
    if (!sec) return;
    const row = !isStat(draft) && draft.mode === 'row';
    const g = draft.range;
    const mode = g ? g.mode : 'all';
    $('cf-range').querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === mode)));
    $('range-opt').hidden = !g;
    const m = valueName(draft);
    const who = row ? labelOf(draft.label) : '행';
    if (!g) { $('range-desc').textContent = row ? '모든 ' + who + ' 값을 표시합니다.' : '모든 행을 사용합니다.'; return; }
    const inp = $('cf-range-n');
    if (document.activeElement !== inp) inp.value = String(g.n);
    const rank = g.mode === 'top' || g.mode === 'bottom';
    $('range-unit').hidden = !rank;
    $('range-unit').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.u === g.unit)));
    $('range-suffix').textContent = rank ? '' : (isPercent(draft) ? '%' : '');
    $('range-desc').textContent = row
      ? m + ' 기준 ' + rangeText(draft) + '에 해당하는 ' + who + '만 표시합니다.'
      : '행별 ' + m + ' 기준 ' + rangeText(draft) + '에 해당하는 행만 사용하여 산출합니다.';
  }


  // 제목: 미입력 시 ‘개체 (n)’, 같은 이름이 있으면 다음 번호
  function usedTitles(exceptId) { return new Set(state.layout.filter((c) => c.id !== exceptId).map((c) => c.title || autoTitle(c))); }
  function autoName() {
    const used = usedTitles(null);
    let n = 1;
    while (used.has('개체 (' + n + ')')) n++;
    return '개체 (' + n + ')';
  }
  function uniqueTitle(t, exceptId) {
    const used = usedTitles(exceptId);
    if (!used.has(t)) return t;
    const m = t.match(/^(.*) \((\d+)\)$/);
    const base = m ? m[1] : t;
    let n = m ? Number(m[2]) + 1 : 2;
    while (used.has(base + ' (' + n + ')')) n++;
    return base + ' (' + n + ')';
  }
  function showTitle() { $('dlg-chart-title').textContent = draft.title || autoTitle(draft); }

  // 휴대전화: 보기 전환 단추 왼쪽 빈 곳에 범례(구조) 또는 값 이름(결과) 표시
  function syncPaneCap() {
    const d = $('pane-desc');
    if (!d || !draft) return;
    d.replaceChildren();
    if ($('builder-visual').dataset.pane === 'schema') {
      const lg = document.querySelector('#vp-schema .legend');
      if (lg) { const c = lg.cloneNode(true); c.removeAttribute('id'); c.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id')); d.append(c); }
    }
  }

  // ───────────── 드롭다운: 기본 목록 대신 직접 그린 목록 사용 ─────────────
  const fancy = new WeakMap();
  let ddOpen = null;
  function enhanceSelect(sel) {
    if (!sel) return;
    if (fancy.has(sel)) { syncFancy(sel); return; }
    const btn = el('button', 'dd-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const lab = el('span', 'dd-label');
    btn.append(lab, icon('chev'));
    if (sel.id) btn.dataset.for = sel.id;
    sel.classList.add('dd-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel.after(btn);
    fancy.set(sel, { btn, lab });
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (ddOpen && ddOpen.sel === sel) closeDD(); else openDD(sel); });
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openDD(sel); } });
    sel.addEventListener('change', () => syncFancy(sel));
    new MutationObserver(() => syncFancy(sel)).observe(sel, { childList: true, subtree: true });
    // 라벨을 누르면 목록 열기
    const lbl = sel.closest('label') || (sel.id && document.querySelector('label[for="' + sel.id + '"]'));
    if (lbl) lbl.addEventListener('click', (e) => { if (e.target === btn || btn.contains(e.target)) return; e.preventDefault(); btn.focus(); });
    syncFancy(sel);
  }
  function syncFancy(sel) {
    const f = fancy.get(sel);
    if (!f) return;
    const o = sel.options[sel.selectedIndex];
    f.lab.textContent = o ? o.textContent : '';
    f.btn.disabled = sel.disabled;
    f.btn.setAttribute('aria-label', (sel.getAttribute('aria-label') || '선택') + ': ' + f.lab.textContent);
  }
  function refreshSelects() { document.querySelectorAll('select.dd-native').forEach(syncFancy); }
  function openDD(sel) {
    closeDD();
    const f = fancy.get(sel);
    const host = sel.closest('dialog') || document.body;
    const list = el('div', 'dd-list');
    list.setAttribute('role', 'listbox');
    Array.from(sel.options).forEach((o, i) => {
      const it = el('button', 'dd-opt' + (i === sel.selectedIndex ? ' on' : ''));
      it.type = 'button';
      it.setAttribute('role', 'option');
      it.setAttribute('aria-selected', String(i === sel.selectedIndex));
      it.append(el('span', 'dd-opt-t', o.textContent), icon('check'));
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        closeDD();
        if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        syncFancy(sel);
        const b2 = fancy.get(sel); if (b2 && b2.btn.isConnected) b2.btn.focus();
      });
      list.append(it);
    });
    host.append(list);
    // 위치: 단추 바로 아래 (공간이 부족하면 위)
    const r = f.btn.getBoundingClientRect();
    const hr = host === document.body ? { left: 0, top: 0 } : host.getBoundingClientRect();
    list.style.position = host === document.body ? 'fixed' : 'absolute';
    list.style.minWidth = Math.max(r.width, 140) + 'px';
    list.style.left = Math.min(r.left, window.innerWidth - Math.max(r.width, 140) - 8) - hr.left + 'px';
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const want = Math.min(list.scrollHeight, 300);
    if (below >= Math.min(want, 180) || below >= above) { list.style.top = r.bottom + 4 - hr.top + 'px'; list.style.maxHeight = Math.max(120, Math.min(300, below)) + 'px'; }
    else { list.style.maxHeight = Math.min(300, above) + 'px'; list.style.top = r.top - 4 - hr.top - Math.min(want, Math.min(300, above)) + 'px'; }
    f.btn.setAttribute('aria-expanded', 'true');
    const cur = list.querySelector('.dd-opt.on') || list.firstChild;
    if (cur) { cur.scrollIntoView({ block: 'nearest' }); cur.focus({ preventScroll: true }); }
    list.addEventListener('keydown', (e) => {
      const opts = Array.from(list.children), k = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (opts[k + 1] || opts[k]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (opts[k - 1] || opts[k]).focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDD(); f.btn.focus(); }
      else if (e.key === 'Tab') closeDD();
    });
    ddOpen = { sel, list };
  }
  function closeDD() {
    if (!ddOpen) return;
    const f = fancy.get(ddOpen.sel);
    if (f) f.btn.setAttribute('aria-expanded', 'false');
    ddOpen.list.remove();
    ddOpen = null;
  }
  document.addEventListener('pointerdown', (e) => { if (ddOpen && !ddOpen.list.contains(e.target)) { const f = fancy.get(ddOpen.sel); if (!f || !f.btn.contains(e.target)) closeDD(); } }, true);
  document.addEventListener('scroll', (e) => { if (ddOpen && !ddOpen.list.contains(e.target)) closeDD(); }, true);
  window.addEventListener('resize', closeDD);

  let peekBase = null;
  function renderPresets() {
    const box = $('cf-presets');
    box.replaceChildren();
    const hasText = selCols(draft).some((k) => state.keyInfo.has(k) && info(k).type === 'string');
    let list = presetList().filter((x) => isStat(draft) || (x.p.mode || 'row') === draft.mode);
    const textCols = selCols(draft).filter((k) => state.keyInfo.has(k) && info(k).type === 'string').map(labelOf);
    // 묶음: 행마다(○○별) → 열마다(열별), 각 묶음 안에서는 숫자 계산 먼저
    const grp = (x) => (x.p.mode === 'col' ? 1 : 0);
    const offOf = (x) => (x.num && hasText ? 1 : 0); // 선택 불가 항목은 묶음 안에서 뒤로
    list = list.map((x, i) => ({ x, i })).sort((a, b2) => grp(a.x) - grp(b2.x) || offOf(a.x) - offOf(b2.x) || a.i - b2.i).map((o) => o.x);
    let lastG = null;
    list.forEach((x) => {
      if (!isStat(draft) && grp(x) !== lastG) {
        lastG = grp(x);
        box.append(el('p', 'pr-group', lastG === 0 ? labelOf(draft.label) + '별 · ' + labelOf(draft.label) + '마다 막대 하나' : '열별 · 선택한 열마다 막대 하나'));
      }
      const b = el('button', 'preset');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      const on = presetMatches(x);
      const off = x.num && hasText;
      b.setAttribute('aria-checked', String(on && !off));
      if (off) { b.disabled = true; b.classList.add('off'); }
      b.append(el('span', 'pr-dot'));
      const body = el('span', 'pr-body');
      body.append(el('span', 'pr-label', x.label), el('span', 'pr-desc', x.desc));
      const smp = off ? null : presetSample(x);
      if (smp) body.append(el('span', 'pr-sample', smp));
      if (off) body.append(el('span', 'pr-off', '선택 불가: 문자 열 포함 (' + textCols.slice(0, 3).join(', ') + (textCols.length > 3 ? ' 외 ' + (textCols.length - 3) + '개' : '') + ')'));
      b.append(body);
      // 마우스를 올리면 선택 전에 구조·결과를 미리 표시
      b.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse' || on || off) return;
        if (!peekBase) peekBase = draft;
        draft = JSON.parse(JSON.stringify(peekBase));
        Object.assign(draft, x.p);
        if (!isStat(draft) && draft.mode === 'row' && draft.type === 'bar' && state.rows.length > 12) draft.type = 'hbar';
        $('builder-visual').dataset.peek = '1';
        renderSchema(); renderPreview();
      });
      b.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'mouse' || !peekBase) return;
        draft = peekBase; peekBase = null;
        delete $('builder-visual').dataset.peek;
        renderSchema(); renderPreview();
      });
      b.addEventListener('click', () => {
        if (peekBase) { draft = peekBase; peekBase = null; delete $('builder-visual').dataset.peek; }
        Object.assign(draft, x.p);
        if (!isStat(draft) && draft.mode === 'row' && draft.type === 'bar' && state.rows.length > 12) draft.type = 'hbar';
        syncBuilder();
      });
      box.append(b);
    });
    if (hasText) box.prepend(el('p', 'pr-note', '선택한 열에 문자 열(' + textCols.slice(0, 3).join(', ') + (textCols.length > 3 ? ' 외 ' + (textCols.length - 3) + '개' : '') + ')이 있어 합계·평균 등 숫자 계산 항목은 선택할 수 없습니다. 1단계에서 수치 열만 선택하거나, 열을 길게 눌러 자료형을 변경하십시오.'));
  }

  function syncBuilder() {
    const stat = isStat(draft);
    setTimeout(updateLabHint);
    // 선택한 열에 맞지 않는 조합이면 사용 가능한 조합으로 조정
    const hasText = selCols(draft).some((k) => state.keyInfo.has(k) && info(k).type === 'string');
    if (stat && draft.how === 'each') draft.how = 'sum';
    if (draft.read !== 'num' && (draft.how === 'max' || draft.how === 'min' || draft.how === 'avg')) { const wasAvg = draft.how === 'avg'; draft.how = 'sum'; if (wasAvg) draft.pct = true; }
    const row = !stat && draft.mode === 'row';
    draft.cols = draft.cols.filter((k) => k !== draft.label);
    renderColChips();
    renderVisCols();
    renderCalc();
    renderItem();
    renderStype();
    if (!isStat(draft)) {
      const before = $('step-item').dataset.name;
      orderAxes();
      if ($('step-item').dataset.name !== before) { const cur = visibleSteps()[currentStep()]; buildStepNav(); numberSteps(); const k = visibleSteps().indexOf(cur); if (k >= 0) goStep(k); }
    }
    $('vis-sum').textContent = visSummary();
    updateFilterSum();
    renderRange();
    refreshSelects();
    const histOk = row && draft.how !== 'each';
    if (draft.type === 'hist' && !histOk) draft.type = 'hbar';
    if (draft.type === 'list' && !row) draft.type = 'hbar';
    $('cf-type').querySelectorAll('.chip').forEach((b) => {
      b.disabled = (b.dataset.id === 'hist' && !histOk) || (b.dataset.id === 'list' && !row);
      b.title = b.dataset.id === 'hist' ? '행별 값이 어느 구간에 몰려 있는지 표시합니다. (‘○○별’ 항목에서 사용)' : '';
      b.setAttribute('aria-pressed', String(b.dataset.id === draft.type));
    });
    $('opt-sort').hidden = draft.type === 'hist';
    $('opt-align').hidden = isStat(draft) || draft.type !== 'table';
    $('opt-hl').hidden = isStat(draft) || ['hist', 'list', 'table'].includes(draft.type) || draft.how === 'each';
    renderDraftColors();
    $('cf-sort').querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === draft.sort)));
    $('cf-width').querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.id) === draft.width)));
    $('cf-error').textContent = '';
    renderSchema();
    renderPreview();
  }

  // 구조: 대상 열·항목 이름·칸 값 해석·집계 결과를 실제 자료로 표시
  function renderSchema() {
    const box = $('schema');
    $('lg-lab-item').hidden = isStat(draft) || draft.mode !== 'row';
    syncPaneCap();
    box.replaceChildren();
    const stat = isStat(draft);
    const row = !stat && draft.mode === 'row';
    const each = row && draft.how === 'each';
    const result = compute(draft, { noSort: true });
    const sel = result.error ? draft.cols.filter((k) => state.keys.includes(k)) : result.cols;
    const narrow = window.innerWidth < 640;
    const maxShown = narrow ? (row ? 2 : 3) : (row ? 4 : 5);
    const shown = sel.slice(0, maxShown);
    const more = sel.length - shown.length;
    const others = state.keys.filter((k) => !sel.includes(k) && !(row && k === draft.label)).length;

    const cols = [];
    if (row) cols.push({ kind: 'label', key: draft.label });
    shown.forEach((k) => cols.push({ kind: 'sel', key: k }));
    if (more > 0) cols.push({ kind: 'more' });
    if (others > 0) cols.push({ kind: 'dim' });
    if (!sel.length) cols.push({ kind: 'empty' });
    // 모든 열을 같은 너비로, 영역 너비를 고르게 채움
    const tpl = cols.map(() => 'minmax(44px,1fr)');
    if (row) tpl.push('minmax(64px,max-content)');
    box.style.gridTemplateColumns = tpl.join(' ');

    const cell = (cls, text, title) => { const d = el('div', 'sc ' + cls, text); if (title) d.title = title; box.append(d); return d; };

    cols.forEach((c) => {
      if (c.kind === 'label') { const d = cell('h lab', labelOf(c.key)); d.prepend(el('span', 'tag', '기준')); }
      else if (c.kind === 'sel') cell('h sel', labelOf(c.key), labelOf(c.key));
      else if (c.kind === 'more') cell('h sel more', '외 ' + more + '개');
      else if (c.kind === 'dim') {
        const names = state.keys.filter((k) => !sel.includes(k) && !(row && k === draft.label)).map(labelOf);
        cell('h dim', '제외\n' + names.length + '개', '계산에서 제외된 열: ' + names.join(', '));
      }
      else cell('h dim', '열 미선택');
    });
    if (row) cell('h out-h', each ? '열별 개별' : metricLabel(draft).replace(/\s*\(.*\)$/, ''));

    const showRead = draft.read !== 'num';
    const sample = (result.rows || state.rows).slice(0, 4);
    const groupVal = new Map();
    if (row && !each && !result.error) result.labels.forEach((l, i) => groupVal.set(l, result.series[0].data[i]));
    sample.forEach((r) => {
      cols.forEach((c) => {
        if (c.kind === 'label') cell('c lab', display(r[c.key]) || '(빈칸)');
        else if (c.kind === 'sel') {
          const v = r[c.key];
          const raw = isBlank(v) ? '' : display(v);
          const d = cell('c sel ' + (isBlank(v) ? 'empty' : 'fill'), raw.length > 6 ? raw.slice(0, 6) + '…' : raw);
          // 자료 표에는 실제 값을 그대로 표시하고, 변환 값은 마우스를 올렸을 때만 안내
          if (showRead) d.title = (raw || '빈칸') + ' → ' + readLabel(draft.read) + ' ' + readCell(v, draft.read, tyOf(c.key));
        } else if (c.kind === 'more') cell('c sel more', '…');
        else cell('c dim', '');
      });
      if (row) {
        const out = cell('out', '');
        if (!result.error && !each) {
          const key = result.rowKeyOf(r);
          const outR = result.rangeInfo && !result.rangeInfo.kept.has(key);
          out.append(el('span', 'arrow', '→'), outR ? el('span', 'pill ghost', '범위 외') : el('span', 'pill', fmtVal(groupVal.get(key), draft)));
        }
        if (each) out.append(el('span', 'out-note', '칸별 표시'));
      }
    });
    cols.forEach(() => cell('c gap', '⋮'));
    if (row) cell('out gap', result.error || each ? '' : '⋮');

    if (!row && !result.error) {
      if (stat) {
        const d = cell('foot total', '');
        d.style.gridColumn = '1 / -1';
        d.append(el('span', 'arrow', '↓ 선택한 열 전체 집계'), el('span', 'pill big', fmtVal(result.value, draft)));
      } else {
        cols.forEach((c, i) => {
          const d = cell('foot', '');
          if (c.kind === 'sel') d.append(el('span', 'arrow', '↓'), el('span', 'pill', fmtVal(result.series[0].data[i], draft)));
          else if (c.kind === 'more') d.append(el('span', 'arrow', '↓'), el('span', 'pill ghost', '…'));
        });
      }
    }

    enhanceHScroll(document.querySelector('.schema-wrap'));
    hsRefresh(document.querySelector('.schema-wrap'));
    const t = $('schema-text');
    const note = $('schema-note');
    if (result.error) { t.textContent = result.error; t.className = 'schema-text error'; note.className = 'note warn'; return; }
    t.className = 'schema-text'; note.className = 'note info';
    const readPart = showRead ? '각 칸을 ‘' + readLabel(draft.read) + '’ 값으로 변환한 후 ' : '';
    const m = josa(metricLabel(draft), '을', '를');
    if (stat) {
      t.textContent = readPart + '선택한 열 ' + result.cols.length + '개의 모든 칸(' + result.cells.toLocaleString('ko-KR') + '개)을 집계하여 ' + m + ' 산출합니다.';
    } else if (row && each) {
      t.textContent = readPart + '선택한 열 ' + result.cols.length + '개를 ' + labelOf(draft.label) + '별로 개별 표시합니다. 항목 ' + result.labels.length + '개.';
    } else if (row) {
      t.textContent = readPart + labelOf(draft.label) + '별로 선택한 열 ' + result.cols.length + '개를 집계하여 ' + m + ' 산출합니다. 막대 ' + result.labels.length + '개.' + (result.merged ? ' 같은 ' + labelOf(draft.label) + '끼리 묶어 계산합니다.' : '');
    } else {
      t.textContent = readPart + '선택한 열 ' + result.cols.length + '개를 열별로 집계하여 ' + m + ' 산출합니다. 막대 ' + result.labels.length + '개.';
    }
    if (result.rowsN < result.rowsAll) t.textContent = '조건을 만족하는 행 ' + result.rowsN + '개(전체 ' + result.rowsAll + '개)만 사용합니다. ' + t.textContent;
    if (result.rangeInfo) t.textContent += ' 산출 범위 ' + rangeText(draft) + ': ' + result.rangeInfo.before + result.rangeInfo.unit + ' 중 ' + result.rangeInfo.after + result.rangeInfo.unit + (result.rangeInfo.unit === '행' ? ' 사용.' : ' 표시.');
  }

  // 그래프 한 줄 설명: 막대 하나가 무엇이고 높이가 무엇인지
  // 그래프 의미 한 줄: 열 이름은 작은 칩으로 표시 (누르면 열 선택 단계로 이동)
  function graphDesc(c) {
    const m = metricLabel(c).replace(/\s*\(.*\)$/, '');
    const cols = selCols(c).filter((k) => state.keyInfo.has(k));
    const unit = c.type === 'line' ? '점' : '막대';
    const p = el('p', 'pv-desc');
    const colStep = c.mode === 'col' ? 'step-item' : 'step-value';
    const chip = (text) => {
      const b = el('button', 'desc-chip', text);
      b.type = 'button';
      b.title = '열 선택';
      b.addEventListener('click', () => gotoStepId(colStep));
      return b;
    };
    const chips = () => {
      const names = cols.map(labelOf);
      const span = el('span', 'desc-chips');
      if (names.length <= 3) names.forEach((n) => span.append(chip(n)));
      else span.append(chip(names[0]), chip('외 ' + (names.length - 1) + '개'));
      return span;
    };
    const t = (s) => document.createTextNode(s);
    if (c.type === 'hist') { p.append(t(labelOf(c.label) + '별 '), chips(), t('의 ' + m + '을 구간으로 나누어, 구간마다 해당 ' + labelOf(c.label) + ' 수를 표시')); return p; }
    if (c.mode === 'col') { const g = colGroupName(c); p.append(t(g + '별 ' + unit + ' 의미: 각 ' + (g === '항목' ? '열' : g) + '의 ' + m)); return p; }
    p.append(t(labelOf(c.label) + '별 ' + unit + ' 의미: '), chips(), t('의 ' + m));
    return p;
  }
  function dummyResult(c) {
    if (isStat(c)) return { value: null, cells: 0, rowCount: 0, rowsN: 0, rowsAll: state.rows.length, warnings: [], cols: [], rangeInfo: null };
    const d = [3, 5, 2, 6, 4, 5, 3, 4];
    return { labels: d.map(() => ''), series: [{ name: '', data: d }], warnings: [], cols: [], rowKeyOf: () => '', rangeInfo: null, rowsN: 0, rowsAll: state.rows.length };
  }
  function renderPreview() {
    if (previewChart) { previewChart.destroy(); previewChart = null; }
    const box = $('pv-box');
    box.replaceChildren();
    const real = compute(draft);
    renderPreviewInner(box, real.error ? dummyResult(draft) : real);
    if (!real.error) { mountToggle(); return; }
    // 계산할 수 없는 조합: 평소와 같은 모양·높이로 아주 연하게 그리고 그 위에 이유 표시
    const dim = el('div', 'pv-dim');
    dim.append(...Array.from(box.childNodes));
    const msg = el('div', 'pv-msg');
    msg.append(el('b', null, isStat(draft) ? '통계 처리 불가' : '그래프 표시 불가'), el('p', null, real.error));
    if (real.fix) {
      const go = el('button', 'link', '설정으로 이동 ›');
      go.type = 'button';
      go.addEventListener('click', () => gotoStepId(real.fix));
      msg.append(go);
    }
    const blk = el('div', 'pv-block');
    blk.append(dim, msg);
    box.append(blk);
    mountToggle();
  }
  function renderPreviewInner(box, result) {
    const cap = el('p', 'pv-cap');
    cap.append(el('span', 'lg out'), document.createTextNode('값: '), el('b', null, metricLabel(draft)));
    box.append(cap);
    if (isStat(draft)) {
      cap.remove();
      // 통계 미리보기: 카드의 각 부분을 눌러 해당 설정으로 이동
      const fOn = filterOn(draft) || draft.range;
      const stl = (STYPES.find((t) => t.id === stypeOf(draft)) || {}).label || '';
      const part = (tag, cls, text, step, title) => {
        const b = el('button', 'sp-part ' + cls);
        b.type = 'button';
        b.title = title;
        b.append(el(tag === 'b' ? 'b' : 'span', 'sp-t', text), icon('edit'));
        b.addEventListener('click', () => gotoStepId(step));
        return b;
      };
      const card = el('div', 'stat-preview sp');
      if (globalColors.base || (draft.color && draft.color.base)) card.style.setProperty('--c-out', chartColor(draft, 'base'));
      const head = el('div', 'sp-head');
      head.append(el('p', 'stat-title', draft.title || autoTitle(draft)), el('span', 'pv-mark', '미리보기'), part('s', 'sp-type', stl, 'step-type', '유형 설정'));
      card.append(head);
      if (result.error) { card.append(el('p', 'card-warn', result.error)); box.append(card); return; }
      result.warnings.forEach((w) => card.append(el('p', 'card-warn', w)));
      card.append(part('s', 'sp-label', valueName(draft), 'step-value', '값 설정'));
      card.append(el('p', 'stat-value', fmtVal(result.value, draft)));
      if (isPercent(draft) && result.value !== null) {
        const bar = el('div', 'stat-meter'); const fill = el('i');
        fill.style.width = Math.max(0, Math.min(100, result.value)) + '%';
        bar.append(fill); card.append(bar);
      } else card.append(el('div', 'stat-meter sp-ph')); // 유형이 바뀌어도 카드 높이 유지
      card.append(part('s', 'sp-sub', colsText(selCols(draft)) + ' · ' + statSub(result, draft), 'step-value', '사용할 열 설정'));
      card.append(part('s', 'sp-foot', '조건: ' + (fOn ? '행 ' + result.rowsN + '개' + (draft.range ? ' · ' + rangeText(draft) : '') : '없음 (모든 행)'), 'step-filter', '조건 설정'));
      const wrapC = el('div', 'sp-wrap');
      wrapC.append(card);
      box.append(wrapC, el('div', 'tgl-slot tgl-stat'));
      return;
    }
    cap.remove();
    result.warnings.forEach((w) => box.append(el('p', 'card-warn', w)));
    // 축 표시: 누르면 아래에서 해당 축 설정
    const hz = draft.type === 'hbar', hist = draft.type === 'hist', flat = draft.type === 'table' || draft.type === 'list';
    const tname = (CHART_TYPES.find((t) => t.id === draft.type) || {}).label || '';
    const axBtn = (k, v, step, cls) => {
      const b = el('button', 'ax-chip ' + cls);
      b.type = 'button';
      b.append(el('span', 'ax-k', k), el('span', 'ax-v', v), icon('edit'));
      b.title = k + ' 설정';
      b.addEventListener('click', () => gotoStepId(step));
      return b;
    };
    const top = el('div', 'ax-top');
    const tb = axBtn('유형', tname, 'step-type', 'ax-type');
    let yBtn, xBtn;
    if (flat) { yBtn = axBtn('항목', itemName(draft), 'step-item', 'ax-y'); xBtn = axBtn('값', valueName(draft), 'step-value', 'ax-x'); }
    else if (hist) { yBtn = axBtn('Y축', '항목 수', 'step-item', 'ax-y'); xBtn = axBtn('X축', valueName(draft) + ' 구간', 'step-value', 'ax-x'); }
    else if (hz) { yBtn = axBtn('Y축', itemName(draft), 'step-item', 'ax-y'); xBtn = axBtn('X축', valueName(draft), 'step-value', 'ax-x'); }
    else { yBtn = axBtn('Y축', valueName(draft), 'step-value', 'ax-y'); xBtn = axBtn('X축', itemName(draft), 'step-item', 'ax-x'); }
    const mark = () => el('span', 'pv-mark', '미리보기');
    if (flat) {
      top.append(yBtn, mark(), tb);
      box.append(top);
      const xrowF = el('div', 'ax-xrow');
      xrowF.append(el('span'), xBtn, el('span', 'tgl-slot'));
      if (draft.type === 'table') box.append(renderTable(result, draft), xrowF); else box.append(renderList(result, draft), xrowF);
      return;
    }
    // 그래프: 축 이름 자리에 누를 수 있는 축 이름을 둠 (Y축 이름은 세로로)
    // Y축 이름은 세로축 위쪽, X축 이름은 가로축 아래쪽에 둠
    top.append(yBtn, mark(), tb);
    xBtn.classList.add('ax-horz');
    const plot = el('div', 'pv-plot one');
    const wrap = el('div', 'chart-box small');
    const canvas = el('canvas');
    wrap.append(canvas);
    const xrow = el('div', 'ax-xrow');
    xrow.append(el('span'), xBtn, el('span', 'tgl-slot'));
    plot.append(wrap, xrow);
    box.append(top, plot, graphDesc(draft));
    // 축(눈금) 부분을 눌러도 해당 축 설정으로 이동
    const roleAt = (e, ch) => {
      const xs = ch.scales.x, ys = ch.scales.y;
      if (!xs || !ys) return null;
      if (e.y >= xs.top) return hz || hist ? 'step-value' : 'step-item';
      if (e.x <= ys.right) return hz || hist ? 'step-item' : 'step-value';
      return null;
    };
    previewChart = drawChart(draft, canvas, result, roleAt);
    if (previewChart) {
      const pos = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
      canvas.addEventListener('click', (ev) => { const s = roleAt(pos(ev), previewChart); if (s) gotoStepId(s); });
      canvas.addEventListener('pointermove', (ev) => { canvas.style.cursor = roleAt(pos(ev), previewChart) ? 'pointer' : 'default'; });
    }
  }

  function closeBuilder() {
    if (previewChart) { previewChart.destroy(); previewChart = null; }
    $('dlg-chart').close();
  }

  function submitDialog() {
    draft.title = uniqueTitle((draft.title || autoName()).slice(0, 100), editingId);

    const res = compute(draft);
    if (res.error) { $('cf-error').textContent = res.error; return; }
    const cfg = sanitizeConfig(Object.assign({}, draft, { cols: res.cols }));
    if (editingId) state.layout = state.layout.map((c) => (c.id === editingId ? Object.assign(cfg, { group: c.group || null }) : c));
    else { cfg.group = state.addGroup || null; state.layout.push(cfg); }
    saveLayout();
    closeBuilder();
    renderBoard();
  }

  const isNarrow = () => true; // 모든 화면에서 휴대전화 화면 형태 사용

  function setVisCollapsed(c) {
    const act = document.querySelector('#dlg-chart .dialog-actions');
    if (act) $('dlg-chart').style.setProperty('--act-h', act.offsetHeight + 'px');
    const bv = $('builder-visual');
    // 펼칠 때 접힌 막대 높이만큼 입력 영역 아래 여백을 유지하여 배치가 바뀌지 않게 함
    if (c === false && bv.dataset.collapsed === 'true') $('dlg-chart').style.setProperty('--bar-h', bv.offsetHeight + 'px');
    bv.dataset.collapsed = String(c);
    $('vis-scrim').hidden = c || !isNarrow();
    $('vt-toggle').setAttribute('aria-expanded', String(!c));
    $('vt-toggle').setAttribute('aria-label', c ? '세부 설정 펼치기' : '세부 설정 접기');
  }

  // 표 ↔ 결과 전환 단추: 미리보기를 다시 그려도 사라지지 않도록 참조를 보관하고, 결과 영역 오른쪽 아래에 배치
  const tblBtn = document.getElementById('btn-table');
  const tblText = document.getElementById('btn-table-text');
  // [표로 전환]·[미리보기로 전환]은 같은 자리(위쪽 영역 오른쪽 아래)에 고정하여 바로 다시 누를 수 있게 함
  function mountToggle() {
    if (!tblBtn) return;
    const bv = $('builder-visual');
    tblBtn.classList.add('tgl-fixed');
    if (tblBtn.parentNode !== bv) bv.append(tblBtn);
  }
  function setVisPane(p) {
    setVisCollapsed(false);
    const bv = $('builder-visual');
    // 결과 ↔ 자료 표 전환 시 위쪽 영역 높이를 그대로 유지 (표는 안에서 스크롤)
    if (p === 'schema' && bv.dataset.pane !== 'schema') bv.style.height = bv.offsetHeight + 'px';
    else if (p === 'preview') bv.style.height = '';
    bv.dataset.pane = p;
    const stat = draft && isStat(draft);
    $('pane-desc').textContent = '';
    const tbl = p === 'schema';
    tblText.textContent = tbl ? '미리보기로 전환' : '표로 전환';
    tblBtn.setAttribute('aria-pressed', String(tbl));
    mountToggle();
    const pn = document.querySelector('#builder-visual .pane-name');
    if (pn) pn.textContent = tbl ? '자료 표' : '미리보기';
    syncPaneCap();
  }

  function initBuilder() {
    // 단계별 도움말(?)과 사용 안내
    document.querySelectorAll('#dlg-chart .help-btn').forEach((btn) => btn.addEventListener('click', () => {
      const t = $('help-' + btn.dataset.help);
      t.hidden = !t.hidden;
      btn.setAttribute('aria-expanded', String(!t.hidden));
    }));
    $('btn-help').addEventListener('click', () => $('dlg-help').showModal());
    $('help-close').addEventListener('click', () => $('dlg-help').close());
    let snTimer = null;
    $('builder-controls').addEventListener('scroll', () => { clearTimeout(snTimer); snTimer = setTimeout(markStep, 60); }, { passive: true });
    $('cp-id').addEventListener('change', (e) => {
      const k = $('col-pop').dataset.key;
      if (!k) return;
      setOverride(k, { id: e.target.checked === info(k).autoId ? undefined : e.target.checked });
    });
    $('cp-reset').addEventListener('click', () => {
      const k = $('col-pop').dataset.key;
      if (!k) return;
      delete state.typeOver[k];
      afterTypeChange(k);
    });
    $('cp-close').addEventListener('click', closeColPop);
    $('dlg-chart').addEventListener('pointerdown', (e) => {
      if (!$('col-pop').hidden && !e.target.closest('#col-pop') && !e.target.closest('.col-chip') && !e.target.closest('.vchip')) closeColPop();
    });
    $('dlg-chart').addEventListener('close', closeColPop);
    $('cf-cols').addEventListener('scroll', closeColPop, true);
    $('kd-chart').addEventListener('click', () => setKind('chart'));
    $('kd-stat').addEventListener('click', () => setKind('stat'));
    tblBtn.addEventListener('click', () => {
      if ($('builder-visual').dataset.pane === 'schema') { setVisPane('preview'); renderPreview(); }
      else setVisPane('schema');
    });
    $('se-ok').addEventListener('click', () => $('dlg-spec').close());
    $('vt-toggle').addEventListener('click', (e) => { e.stopPropagation(); setVisCollapsed($('builder-visual').dataset.collapsed !== 'true'); });
    $('vis-scrim').addEventListener('click', () => setVisCollapsed(true));
    document.querySelector('#builder-visual .vis-tabs').addEventListener('click', (e) => {
      if ($('builder-visual').dataset.collapsed === 'true' && !e.target.closest('.vis-seg')) setVisCollapsed(false);
    });
    $('cf-all').addEventListener('click', () => {
      draft.cols = valueKeys(draft.label);
      syncBuilder();
    });
    $('cf-none').addEventListener('click', () => { draft.cols = []; syncBuilder(); });

    $('cf-cancel').addEventListener('click', closeBuilder);
    $('dlg-chart').addEventListener('cancel', () => { if (previewChart) { previewChart.destroy(); previewChart = null; } });
    $('cf-ok').addEventListener('click', submitDialog);
    HELP_TYPE = $('help-type').textContent;
    const startKind = (kind) => { $('dlg-kind').close(); openChartDialog(null, kind); draft.title = autoName(); $('cf-title').value = draft.title; showTitle(); renderPreview(); };
    $('kc-chart').addEventListener('click', () => startKind('chart'));
    $('kc-stat').addEventListener('click', () => startKind('stat'));
    $('kc-cancel').addEventListener('click', () => $('dlg-kind').close());
    $('cf-iname').addEventListener('input', (e) => { draft.itemName = e.target.value.slice(0, 40); renderPreview(); });
    $('cf-vname').addEventListener('input', (e) => { draft.valueName = e.target.value.slice(0, 40); renderPreview(); });
    $('cf-hl').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { draft.hl = b.dataset.id; syncBuilder(); }));
    $('cf-align').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { draft.align = b.dataset.id === 'right' ? null : b.dataset.id; syncBuilder(); }));
    $('dlg-chart').addEventListener('close', closeDD);
    $('ff-ok').addEventListener('click', () => closeFF(true));
    $('ff-cancel').addEventListener('click', () => closeFF(false));
    $('dlg-ff').addEventListener('cancel', (e) => { e.preventDefault(); closeFF(false); });
    $('dlg-ff').addEventListener('click', (e) => { if (e.target === $('dlg-ff')) closeFF(false); });
    // 제목: 연필 단추로 수정
    const tEdit = () => {
      $('dlg-chart-title').hidden = true; $('btn-title-edit').hidden = true;
      const inp = $('cf-title'); inp.hidden = false; inp.value = draft.title || ''; inp.focus(); inp.select();
    };
    const tDone = (ok) => {
      const inp = $('cf-title');
      if (inp.hidden) return;
      const v = inp.value.trim().slice(0, 100);
      if (ok && v) draft.title = v;
      inp.value = draft.title || '';
      inp.hidden = true; $('dlg-chart-title').hidden = false; $('btn-title-edit').hidden = false;
      showTitle();
      if (isStat(draft)) renderPreview();
    };
    $('btn-title-edit').addEventListener('click', tEdit);
    $('dlg-chart-title').addEventListener('click', tEdit);
    $('cf-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); tDone(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); tDone(false); }
    });
    $('cf-title').addEventListener('blur', () => tDone(true));
    $('cf-range').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
      const m = b.dataset.id;
      const prev = draft.range;
      if (m === 'all') draft.range = null;
      else {
        const rank = m === 'top' || m === 'bottom';
        const wasRank = prev && (prev.mode === 'top' || prev.mode === 'bottom');
        draft.range = { mode: m, n: prev && wasRank === rank ? prev.n : (rank ? 10 : 50), unit: prev ? prev.unit : 'pct' };
      }
      syncBuilder();
    }));
    $('cf-range-n').addEventListener('input', (e) => {
      const n = parseNumStr(e.target.value);
      if (n === null || n < 0 || !draft.range) return;
      draft.range.n = n;
      syncBuilder();
    });
    $('range-unit').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (!draft.range) return;
      draft.range.unit = b.dataset.u;
      if (b.dataset.u === 'cnt') draft.range.n = Math.max(1, Math.round(draft.range.n));
      syncBuilder();
    }));
  }

  // ───────────── 분석 파트너 (외부 AI 모델) ─────────────
  // - 브라우저가 공급자 주소로 직접 요청합니다. 인증 키는 메모리에만 보관합니다.
  // - AI에게 원자료를 통째로 보내지 않고, AI가 도구(자료 구조 확인·행 조회·집계·보드 확인·개체 제안)를 호출하면
  //   계산은 이 브라우저에서 하고 결과만 보냅니다. 열마다 전송·가명·제외를 교사가 정합니다.
  const AI_PROVIDERS = {
    openai: { label: 'OpenAI', model: 'gpt-6.1-sol', api: 'oai', url: 'https://api.openai.com/v1/chat/completions', list: 'https://api.openai.com/v1/models' },
    anthropic: { label: 'Anthropic', model: 'claude-sonnet-5-5', api: 'ant', url: 'https://api.anthropic.com/v1/messages', list: 'https://api.anthropic.com/v1/models' },
    gemini: { label: 'Gemini', model: 'gemini-3.5-flash', api: 'gem', url: 'https://generativelanguage.googleapis.com/v1beta/models/', list: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200' },
    upstage: { label: 'Upstage', model: 'solar-pro3', api: 'oai', url: 'https://api.upstage.ai/v1/chat/completions', list: 'https://api.upstage.ai/v1/models' }
  };
  const AI_MAX_ROUNDS = 8;
  const AI_TIMEOUT_MS = 90000;
  let aiCfg = { provider: 'openai', model: '' };
  let aiKey = '';                 // 인증 키: 메모리에만 보관
  let aiMsgs = [];                // 대화 기록 (공급자 공통 형식)
  let aiBusy = false;
  let aiAbort = null;
  let aiPol = {};                 // 열별 전송 방식 { key: 'send'|'alias'|'drop' }
  let aiAlias = null;             // { fwd: Map(key -> Map(값 -> 가명)), back: Map(가명 -> { key, value }) }
  let aiConfirmed = '';           // 전송 확인을 받은 설정 (자료·전송 방식이 바뀌면 다시 확인)
  let aiCharts = [];
  let aiProposals = new Map();

  function aiProv() {
    return AI_PROVIDERS[aiCfg.provider] || AI_PROVIDERS.openai;
  }
  function aiModel() { return (aiCfg.model || '').trim() || aiProv().model; }
  function loadAiCfg() {
    try {
      const o = JSON.parse(store.get('ai') || 'null');
      if (o && AI_PROVIDERS[o.provider]) aiCfg = { provider: o.provider, model: typeof o.model === 'string' ? o.model.slice(0, 100) : '' };
    } catch (e) { /* 무시 */ }
  }
  function saveAiCfg() { store.set('ai', JSON.stringify(aiCfg)); }

  // ── 레이아웃 파일에 담는 분석 파트너 설정 (인증 키 제외) ──
  function aiExport() {
    const columns = {};
    state.keys.forEach((k) => { columns[k] = polOf(k); });
    return { provider: aiCfg.provider, model: aiCfg.model || '', columns };
  }
  function aiSanitizeImport(o) {
    if (!o || typeof o !== 'object' || !AI_PROVIDERS[o.provider]) return null;
    const columns = {};
    if (o.columns && typeof o.columns === 'object') Object.keys(o.columns).slice(0, MAX_KEYS).forEach((k) => { if (['send', 'alias', 'drop'].includes(o.columns[k])) columns[k] = o.columns[k]; });
    return { provider: o.provider, model: typeof o.model === 'string' ? o.model.trim().slice(0, 100) : '', columns };
  }
  function aiApplyImport(o) {
    const provChanged = aiCfg.provider !== o.provider;
    aiCfg = { provider: o.provider, model: o.model };
    if (provChanged) dropKey();
    saveAiCfg();
    Object.keys(o.columns).forEach((k) => { if (state.keys.includes(k)) aiPol[k] = o.columns[k]; });
    saveAiPol();
    aiMsgs = [];
    aiConfirmed = '';
    renderAiSettings();
    syncAiFab();
    return true;
  }
  // ── 인증 키 보관 ──
  // · 웹 앱(Apps Script) 안: 웹 앱이 중계 함수를 제공하면 키를 스크립트 속성에 보관하고, AI 요청도 웹 앱이 대신 보냄(키가 화면으로 오지 않음)
  // · 그 밖: 저장 안 함(메모리) / 이 탭 동안(세션 저장소) / 이 기기에 잠금 저장(패스키 PRF로 암호화, 30일)
  const KEY_SS = 'duruboard:aikey';
  const LOCK_DAYS = 30;
  let gasRelay = null;            // 웹 앱 중계 사용 시 { saved: { 공급자: true } }
  let prfCap = null;              // 패스키 잠금 지원: true / false / null(시도 전 알 수 없음)
  let keepMode = 'none';          // 'none' | 'tab' | 'device'
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  const unb64 = (s) => { const t = atob(s); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

  function lockRec() {
    try {
      const o = JSON.parse(store.get('aikeylock') || 'null');
      if (!o || o.v !== 1) return null;
      if (!(o.exp > Date.now())) { store.del('aikeylock'); return null; }
      return o;
    } catch (e) { return null; }
  }
  function lockFor(p) { const o = lockRec(); return o && o.p === p ? o : null; }
  function aiLocked() { return !gasRelay && !aiKey && !!lockFor(aiCfg.provider); }
  function setSession(on) {
    try {
      if (on && aiKey) window.sessionStorage.setItem(KEY_SS, JSON.stringify({ p: aiCfg.provider, k: aiKey }));
      else window.sessionStorage.removeItem(KEY_SS);
    } catch (e) { /* 사용 불가 */ }
  }
  // 보관 방식에 맞게 저장 위치를 정리 (탭 저장은 즉시, 기기 잠금은 별도 처리)
  function keepKey() {
    setSession(keepMode === 'tab');
    if (keepMode !== 'device') { store.del('aikeylock'); }
  }
  function prfAvailable() {
    return !EMBED && window.isSecureContext && !!window.PublicKeyCredential && !!(navigator.credentials && navigator.credentials.create) && !!location.hostname && !!(window.crypto && crypto.subtle);
  }
  async function detectPrf() {
    if (!prfAvailable()) return false;
    try {
      if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
        const c = await PublicKeyCredential.getClientCapabilities();
        if (c && Object.prototype.hasOwnProperty.call(c, 'extension:prf')) return !!c['extension:prf'];
      }
    } catch (e) { /* 알 수 없음 */ }
    return null;
  }
  async function prfEval(credId, salt) {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: rnd(32), allowCredentials: [{ type: 'public-key', id: credId }], userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: salt } } }
    } });
    const r = a && a.getClientExtensionResults ? a.getClientExtensionResults().prf : null;
    return r && r.results && r.results.first ? r.results.first : null;
  }
  async function newCred(salt) {
    const c = await navigator.credentials.create({ publicKey: {
      rp: { name: '두루보드' },
      user: { id: rnd(16), name: '두루보드 인증 키 잠금', displayName: '두루보드 인증 키 잠금' },
      challenge: rnd(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } }
    } });
    const r = (c.getClientExtensionResults && c.getClientExtensionResults().prf) || {};
    return { id: new Uint8Array(c.rawId), ok: r.enabled === true || !!r.results, first: r.results && r.results.first ? r.results.first : null };
  }
  function lockErr(e) {
    if (e && e.code === 'noprf' && keepMode === 'device') { keepMode = 'none'; store.set('aikeep', 'none'); store.del('aikeycred'); }
    if (e && e.code === 'noprf') return '이 기기·브라우저는 잠금 저장을 지원하지 않습니다. [이 탭 동안]을 사용하십시오.';
    if (e && e.code === 'again') return '잠금 등록을 마쳤습니다. [저장]을 한 번 더 눌러 잠금 저장을 완료하십시오.';
    if (e && e.name === 'NotAllowedError') return '인증이 취소되었거나 시간이 초과되었습니다. 다시 시도하십시오.';
    if (e && e.name === 'OperationError') return '인증 키를 해제하지 못하였습니다. 잠금이 손상되었을 수 있으니 [저장 안 함]을 눌러 삭제한 뒤 다시 입력하십시오.';
    return '잠금 처리에 실패하였습니다.' + (e && e.message ? ' (' + String(e.message).slice(0, 120) + ')' : '');
  }
  // 지문·얼굴·PIN 확인으로 얻은 값(PRF)으로 인증 키를 암호화하여 이 기기에 저장
  async function lockKey(key) {
    if (!prfAvailable()) throw Object.assign(new Error('noprf'), { code: 'noprf' });
    const salt = rnd(32);
    let id = null, secret = null;
    const saved = store.get('aikeycred');
    if (saved) { try { id = unb64(saved); } catch (e) { id = null; } }
    if (!id) {
      const c = await newCred(salt);
      if (!c.ok) { prfCap = false; throw Object.assign(new Error('noprf'), { code: 'noprf' }); }
      id = c.id;
      store.set('aikeycred', b64(id));
      secret = c.first;
      if (!secret) {
        try { secret = await prfEval(id, salt); } catch (e) { if (e && e.name === 'NotAllowedError') throw Object.assign(new Error('again'), { code: 'again' }); throw e; }
      }
    } else secret = await prfEval(id, salt);
    if (!secret) { prfCap = false; throw Object.assign(new Error('noprf'), { code: 'noprf' }); }
    prfCap = true;
    const ck = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
    const iv = rnd(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, new TextEncoder().encode(key));
    store.set('aikeylock', JSON.stringify({ v: 1, p: aiCfg.provider, cred: b64(id), salt: b64(salt), iv: b64(iv), ct: b64(ct), exp: Date.now() + LOCK_DAYS * 864e5 }));
  }
  async function unlockKey() {
    const o = lockFor(aiCfg.provider);
    if (!o) return false;
    const secret = await prfEval(unb64(o.cred), unb64(o.salt));
    if (!secret) throw Object.assign(new Error('noprf'), { code: 'noprf' });
    const ck = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, ck, unb64(o.ct));
    aiKey = new TextDecoder().decode(pt);
    $('ai-key').value = aiKey;
    syncKeyUi();
    syncAiFab();
    if ($('ai-log').querySelector('.ai-hello-warn')) aiReset();
    return true;
  }
  async function doUnlock() {
    msgTo('ai-set-msg', '지문·얼굴·PIN으로 잠금을 해제하십시오.');
    try {
      if (await unlockKey()) msgTo('ai-set-msg', '인증 키 잠금을 해제하였습니다. 이 페이지를 닫으면 다시 잠깁니다.', 'ok');
    } catch (e) { msgTo('ai-set-msg', lockErr(e), 'error'); }
  }
  function lockDays() { const o = lockFor(aiCfg.provider); return o ? Math.max(1, Math.ceil((o.exp - Date.now()) / 864e5)) : 0; }

  // 보관 방식 선택 (웹 앱 중계 시에는 숨김)
  function renderKeep() {
    const field = $('ai-keep-field');
    field.hidden = !!gasRelay;
    $('ai-key-hint').textContent = gasRelay
      ? '인증 키는 이 웹 앱(Apps Script 스크립트 속성)에 보관되며 화면으로 전달되지 않습니다. AI 요청은 웹 앱이 대신 보냅니다.'
      : '두루보드 전용 키를 발급하고, 공급자 화면에서 사용 한도를 설정하여 사용하십시오.';
    if (gasRelay) return;
    $('ai-keep').querySelectorAll('button').forEach((b) => {
      const v = b.dataset.v;
      b.setAttribute('aria-checked', String(v === keepMode));
      if (v === 'device') { b.disabled = prfCap === false; b.title = prfCap === false ? '이 기기·브라우저에서는 사용할 수 없습니다' : ''; }
    });
    const d = lockDays();
    $('ai-keep-note').textContent = keepMode === 'none' ? '페이지를 닫거나 새로 고치면 삭제됩니다.'
      : keepMode === 'tab' ? '이 탭을 닫으면 삭제됩니다. 새로 고침해도 다시 입력하지 않습니다.'
      : prfCap === false ? '이 기기·브라우저에서는 잠금 저장을 사용할 수 없습니다.'
      : (d ? '이 기기에 잠금 저장되어 있습니다(' + d + '일 후 자동 삭제). 사용할 때 지문·얼굴·PIN으로 해제합니다. 개인 기기에서만 사용하십시오.'
        : '키를 저장할 때 지문·얼굴·PIN으로 잠가 이 기기에 ' + LOCK_DAYS + '일간 보관합니다. 개인 기기에서만 사용하십시오.');
  }
  async function setKeep(v) {
    if (v === keepMode && !(v === 'device' && aiKey && !lockFor(aiCfg.provider))) return;
    const had = !!lockFor(aiCfg.provider) || keepMode === 'tab';
    keepMode = v;
    store.set('aikeep', v);
    if (v === 'none') store.del('aikeycred');
    keepKey();
    syncKeyUi();
    renderKeep();
    syncAiFab();
    if (v === 'device' && aiKey) {
      msgTo('ai-set-msg', '지문·얼굴·PIN으로 확인하십시오.');
      try { await lockKey(aiKey); msgTo('ai-set-msg', '인증 키를 이 기기에 잠금 저장하였습니다. ' + LOCK_DAYS + '일 후 자동 삭제됩니다.', 'ok'); }
      catch (e) { msgTo('ai-set-msg', lockErr(e), 'error'); }
      renderKeep();
    } else if (v === 'none' && had) msgTo('ai-set-msg', '이 브라우저에 보관한 인증 키를 삭제하였습니다.', 'ok');
    else msgTo('ai-set-msg', '');
  }

  function syncKeyUi() {
    const inp = $('ai-key'), btn = $('ai-key-btn');
    if (gasRelay) {
      const saved = !!gasRelay.saved[aiCfg.provider];
      const editing = inp.dataset.editing === '1';
      inp.readOnly = saved && !editing;
      inp.classList.toggle('locked', saved && !editing);
      if (!editing) inp.value = '';
      inp.placeholder = saved && !editing ? '웹 앱에 저장되어 있습니다' : '공급자에서 발급받은 API 키';
      btn.textContent = saved && !editing ? '변경' : '저장';
      btn.classList.toggle('primary', !(saved && !editing));
      btn.disabled = !(saved && !editing) && !inp.value.trim();
      $('ai-key-del').hidden = !saved;
      return;
    }
    $('ai-key-del').hidden = true;
    const locked = aiLocked();
    const has = !!aiKey;
    inp.readOnly = has || locked;
    inp.classList.toggle('locked', has || locked);
    if (locked) inp.value = '';
    inp.placeholder = locked ? '잠금 저장됨 · 지문·얼굴·PIN으로 해제' : '공급자에서 발급받은 API 키';
    btn.textContent = locked ? '해제' : has ? '수정' : '저장';
    btn.classList.toggle('primary', !has);
    btn.disabled = !has && !locked && !inp.value.trim();
  }
  function editKey() {
    const inp = $('ai-key');
    inp.dataset.editing = '1';
    inp.readOnly = false;
    inp.classList.remove('locked');
    if (gasRelay) { inp.value = ''; inp.placeholder = '새 API 키'; }
    $('ai-key-btn').textContent = '저장';
    $('ai-key-btn').classList.add('primary');
    $('ai-key-btn').disabled = !!gasRelay;
    inp.focus();
    inp.select();
  }
  function cancelEdit() {
    const inp = $('ai-key');
    delete inp.dataset.editing;
    if (!gasRelay && aiKey) inp.value = aiKey;
    syncKeyUi();
  }
  async function commitKey() {
    const inp = $('ai-key');
    const v = inp.value.trim();
    if (gasRelay) {
      if (!v) { cancelEdit(); return; }
      msgTo('ai-set-msg', '웹 앱에 저장하는 중입니다.');
      try {
        await gasSetKey(v);
        delete inp.dataset.editing;
        inp.value = '';
        syncKeyUi();
        syncAiFab();
        if ($('ai-log').querySelector('.ai-hello-warn')) aiReset();
        msgTo('ai-set-msg', '인증 키를 웹 앱에 저장하였습니다.' + (state.source ? ' 왼쪽 아래 단추로 분석 파트너를 엽니다.' : ''), 'ok');
      } catch (e) { msgTo('ai-set-msg', e.message, 'error'); }
      return;
    }
    if (!v) { cancelEdit(); return; }
    const changed = v !== aiKey;
    delete inp.dataset.editing;
    aiKey = v;
    keepKey();
    syncKeyUi();
    syncAiFab();
    if ($('ai-log').querySelector('.ai-hello-warn')) aiReset();
    const tail = state.source ? ' 왼쪽 아래 단추로 분석 파트너를 엽니다.' : '';
    if (keepMode === 'device' && (changed || !lockFor(aiCfg.provider))) {
      msgTo('ai-set-msg', '지문·얼굴·PIN으로 확인하십시오.');
      try { await lockKey(v); msgTo('ai-set-msg', '인증 키를 이 기기에 잠금 저장하였습니다. ' + LOCK_DAYS + '일 후 자동 삭제됩니다.' + tail, 'ok'); }
      catch (e) { msgTo('ai-set-msg', lockErr(e) + ' 지금은 이 페이지를 닫을 때까지만 사용합니다.', 'error'); }
      renderKeep();
      return;
    }
    if (changed) msgTo('ai-set-msg', '인증 키를 저장하였습니다. ' + (keepMode === 'tab' ? '이 탭을 닫으면 삭제됩니다.' : keepMode === 'device' ? '' : '페이지를 닫거나 새로 고치면 삭제됩니다.') + tail, 'ok');
  }
  function onKeyBtn() {
    const inp = $('ai-key');
    if (!gasRelay && aiLocked()) { doUnlock(); return; }
    if (inp.readOnly) editKey(); else commitKey();
  }
  // 입력만 하고 저장하지 않은 키는 대화 열기·모델 목록을 누를 때 함께 반영
  function pendingKey() { if (!gasRelay && !$('ai-key').readOnly && $('ai-key').value.trim()) commitKey(); }
  function restoreKey() {
    const k = store.get('aikeep');
    keepMode = ['none', 'tab', 'device'].includes(k) ? k : 'none';
    if (lockRec()) keepMode = 'device';
    try {
      const o = JSON.parse(window.sessionStorage.getItem(KEY_SS) || 'null');
      if (o && o.p === aiCfg.provider && typeof o.k === 'string') { aiKey = o.k; $('ai-key').value = o.k; if (keepMode !== 'device') keepMode = 'tab'; }
    } catch (e) { /* 무시 */ }
    syncKeyUi();
    renderKeep();
    detectPrf().then((c) => { if (prfCap === null) prfCap = c; renderKeep(); });
  }
  // 공급자를 바꾸거나 초기화할 때
  function dropKey() {
    aiKey = '';
    const inp = $('ai-key');
    inp.value = '';
    delete inp.dataset.editing;
    setSession(false);
    syncKeyUi();
    renderKeep();
  }
  function aiKeyReset() {
    try { window.sessionStorage.removeItem(KEY_SS); } catch (e) { /* 무시 */ }
    keepMode = 'none';
    dropKey();
  }

  // ── 웹 앱 중계 (Apps Script: duruboardAiStatus · duruboardAiSetKey · duruboardAi) ──
  function gasCall(fn, args, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(Object.assign(new Error('timeout'), { name: 'AbortError' })); } }, ms || 30000);
      const r = window.google.script.run
        .withSuccessHandler((v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); })
        .withFailureHandler((e) => { if (done) return; done = true; clearTimeout(timer); reject(new Error(e && e.message ? String(e.message).slice(0, 200) : '웹 앱 오류')); });
      r[fn].apply(r, args || []);
    });
  }
  function gasStatus(v) {
    let o = v;
    if (typeof v === 'string') { try { o = JSON.parse(v); } catch (e) { o = null; } }
    if (!o || !o.saved || typeof o.saved !== 'object') return null;
    const saved = {};
    Object.keys(AI_PROVIDERS).forEach((id) => { saved[id] = !!o.saved[id]; });
    return { saved };
  }
  async function initGasRelay() {
    if (!EMBED) return;
    try {
      const s = gasStatus(await gasCall('duruboardAiStatus', [], 20000));
      if (!s) return;
      gasRelay = s;
      aiKey = '';
      setSession(false);
      syncKeyUi();
      renderKeep();
      syncAiFab();
    } catch (e) { /* 중계 함수가 없으면 이 화면에서 키를 입력하는 방식 사용 */ }
  }
  async function gasSetKey(key) {
    let v;
    try { v = await gasCall('duruboardAiSetKey', [aiCfg.provider, key], 30000); }
    catch (e) { throw new Error('웹 앱에 저장하지 못하였습니다. (' + e.message + ')'); }
    const s = gasStatus(v);
    if (s) gasRelay = s;
  }
  async function gasDelKey() {
    const ok = await askConfirm(aiProv().label + ' 인증 키를 웹 앱에서 삭제합니다. 이 웹 앱을 쓰는 다른 교사도 분석 파트너를 사용할 수 없게 됩니다.', { ok: '삭제', danger: true });
    if (!ok) return;
    try {
      await gasSetKey('');
      syncKeyUi();
      syncAiFab();
      msgTo('ai-set-msg', '웹 앱에서 인증 키를 삭제하였습니다.', 'ok');
    } catch (e) { msgTo('ai-set-msg', e.message, 'error'); }
  }

  // ── 열별 전송 방식 ──
  function aiDefaultPol(k) {
    const inf = state.keyInfo.get(k) || {};
    if (inf.idLike) return 'alias';
    if (inf.type === 'string') {
      const vals = state.rows.map((r) => r[k]).filter((v) => !isBlank(v));
      const uniq = new Set(vals.map(rawStr)).size;
      if (vals.length >= 5 && uniq / vals.length > 0.8) return 'alias'; // 행마다 거의 다른 문자 값(이름 등)
    }
    return 'send';
  }
  function loadAiPol() {
    aiPol = {};
    let saved = {};
    if (state.source) { try { saved = JSON.parse(store.get('aipol:' + state.source.id) || '{}') || {}; } catch (e) { saved = {}; } }
    state.keys.forEach((k) => { aiPol[k] = ['send', 'alias', 'drop'].includes(saved[k]) ? saved[k] : aiDefaultPol(k); });
    aiAlias = null;
  }
  function saveAiPol() {
    if (!state.source) return;
    const diff = {};
    state.keys.forEach((k) => { if (aiPol[k] !== aiDefaultPol(k)) diff[k] = aiPol[k]; });
    if (Object.keys(diff).length) store.set('aipol:' + state.source.id, JSON.stringify(diff)); else store.del('aipol:' + state.source.id);
    aiAlias = null;
  }
  const polOf = (k) => aiPol[k] || 'send';
  function aiPolSig() { return (state.source ? state.source.id : '') + '|' + state.rows.length + '|' + state.keys.map((k) => k + ':' + polOf(k)).join(','); }

  // 가명표: 열마다 값 순서대로 번호 부여 (가명 열이 여러 개면 ID1-, ID2- …)
  // 가명표: 열마다 값이 처음 나온 순서대로 번호 부여. 자료를 다시 불러와도 이미 부여한 번호는 유지하고 새 값만 이어서 부여
  const aliasWidth = () => Math.max(2, String(state.rows.length).length);
  function aliasTable() {
    if (!aiAlias) aiAlias = { fwd: new Map(), back: new Map(), cols: [] };
    const cols = state.keys.filter((k) => polOf(k) === 'alias');
    if (cols.join('\u0000') !== aiAlias.cols.join('\u0000')) { aiAlias = { fwd: new Map(), back: new Map(), cols }; }
    cols.forEach((k) => { if (!aiAlias.fwd.has(k)) aiAlias.fwd.set(k, new Map()); state.rows.forEach((r) => aliasAssign(k, r[k])); });
    return aiAlias;
  }
  function aliasAssign(k, v) {
    if (isBlank(v)) return null;
    const m = aiAlias.fwd.get(k);
    const s = rawStr(v);
    if (m.has(s)) return m.get(s);
    const ci = aiAlias.cols.indexOf(k);
    const pre = aiAlias.cols.length > 1 ? 'ID' + (ci + 1) + '-' : 'ID-';
    const a = pre + String(m.size + 1).padStart(aliasWidth(), '0');
    m.set(s, a);
    aiAlias.back.set(a, { key: k, value: display(v) });
    return a;
  }
  function outVal(k, v) {
    if (isBlank(v)) return null;
    if (polOf(k) === 'alias') { aliasTable(); return aliasAssign(k, v); }
    if (typeof v === 'object') return display(v);
    return v;
  }
  // AI가 보낸 값(가명일 수 있음)을 실제 값으로 되돌림
  function inVal(k, v) {
    if (polOf(k) !== 'alias' || v === null || v === undefined) return v;
    const hit = aliasTable().back.get(String(v).trim());
    return hit && hit.key === k ? hit.value : v;
  }
  function aiColCheck(cols) {
    const bad = cols.filter((k) => !state.keys.includes(k));
    if (bad.length) return '자료에 없는 열입니다: ' + bad.join(', ') + '. get_schema로 열 이름을 확인하십시오.';
    const drop = cols.filter((k) => polOf(k) === 'drop');
    if (drop.length) return '교사가 전송에서 제외한 열이므로 사용할 수 없습니다.';
    return '';
  }

  // ── 도구 정의 ──
  const WHERE_SCHEMA = {
    type: 'array',
    description: '행 조건 목록(모두 만족하는 행만 사용). 가명 열은 가명 값으로 지정합니다.',
    items: {
      type: 'object',
      properties: {
        col: { type: 'string', description: '열 이름' },
        op: { type: 'string', enum: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'has', 'empty', 'filled'], description: 'eq 같음, ne 다름, lt 미만, le 이하, gt 초과, ge 이상, has 포함, empty 빈칸, filled 입력됨' },
        value: { type: 'string', description: '비교할 값 (empty·filled는 생략)' }
      },
      required: ['col', 'op']
    }
  };
  const AI_TOOLS = [
    { name: 'get_schema', description: '자료의 행 수와 열 목록(자료형, 입력 수, 예시 값, 수치 열의 최소·최대·평균, 전송 방식)을 확인합니다. 대화를 시작할 때 먼저 호출하십시오.', parameters: { type: 'object', properties: {} } },
    {
      name: 'query_rows', description: '조건에 맞는 행을 조회합니다. 최대 100행까지 반환합니다.',
      parameters: {
        type: 'object',
        properties: {
          columns: { type: 'array', items: { type: 'string' }, description: '반환할 열 (생략 시 전송 가능한 모든 열)' },
          where: WHERE_SCHEMA,
          sort_by: { type: 'string', description: '정렬 기준 열' },
          order: { type: 'string', enum: ['asc', 'desc'] },
          limit: { type: 'integer', description: '최대 행 수 (기본 30, 최대 100)' }
        }
      }
    },
    {
      name: 'aggregate', description: '여러 열의 값을 읽어 집계합니다. per=row는 행마다(label_col 값별) 열들의 값을 합치고, per=column은 열마다 모든 행의 값을 합치며, per=all은 전체를 하나의 값으로 계산합니다. group_by를 지정하면 그 열의 값별로 나누어 계산합니다.',
      parameters: {
        type: 'object',
        properties: {
          columns: { type: 'array', items: { type: 'string' }, description: '읽을 열' },
          read: { type: 'string', enum: ['num', 'filled', 'blank'], description: 'num 숫자 값, filled 입력 여부(입력=1), blank 미입력 여부(빈칸=1)' },
          how: { type: 'string', enum: ['sum', 'avg', 'max', 'min'], description: '합치는 방식' },
          per: { type: 'string', enum: ['row', 'column', 'all'] },
          label_col: { type: 'string', description: 'per=row일 때 행 이름으로 쓸 열' },
          group_by: { type: 'string', description: '값별로 나누어 계산할 열 (per=all 또는 per=column에서 사용)' },
          where: WHERE_SCHEMA,
          sort: { type: 'string', enum: ['none', 'asc', 'desc'] },
          limit: { type: 'integer', description: '최대 결과 수 (기본 50, 최대 200)' }
        },
        required: ['columns', 'read', 'how', 'per']
      }
    },
    { name: 'get_board', description: '현재 보드에 있는 개체(그래프·통계)의 제목, 구성, 계산 결과를 확인합니다.', parameters: { type: 'object', properties: {} } },
    {
      name: 'propose_object', description: '보드에 추가할 개체를 교사에게 제안합니다. 교사가 확인한 뒤 추가하므로 바로 추가되지 않습니다. 결과를 계산할 수 없거나 구성이 목적에 맞지 않으면 오류를 반환합니다. ' +
        '종류 선택 기준: stat은 숫자 하나(전체 평균, 해당 인원 수, 전체 입력률 등)일 때만 사용합니다. 분포·항목별 비교·학생 목록·반별 값은 반드시 chart를 사용합니다. ' +
        '예) 점수 분포: kind=chart, type=hist, mode=row, label_col=학번, columns=[점수 열], read=num, how=sum. ' +
        '반별 평균: kind=chart, type=bar, mode=row, label_col=반, read=num, how=avg (같은 반의 행이 묶여 계산됨). ' +
        '조건에 맞는 학생 목록: kind=chart, type=table, mode=row, label_col=학번, where 조건, sort=asc 또는 desc. ' +
        '0·1로 기록된 열(작성 여부 등)은 read=num으로 읽습니다. read=filled는 빈칸 여부만 보므로 값이 모두 입력된 열에는 의미가 없습니다.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['chart', 'stat'], description: 'chart 그래프·표, stat 숫자 하나로 요약하는 통계 카드' },
          title: { type: 'string', description: '개체 제목 (짧게)' },
          type: { type: 'string', enum: ['bar', 'hbar', 'line', 'hist', 'table'], description: 'chart의 표시 방식: bar 세로 막대, hbar 가로 막대, line 꺾은선, hist 히스토그램, table 표' },
          mode: { type: 'string', enum: ['row', 'col'], description: 'row: 행마다 하나의 항목(label_col 값이 항목 이름), col: 열마다 하나의 항목. stat은 col' },
          columns: { type: 'array', items: { type: 'string' }, description: '값을 읽을 열' },
          label_col: { type: 'string', description: 'mode=row일 때 항목 이름으로 쓸 열 (예: 학번)' },
          read: { type: 'string', enum: ['num', 'filled', 'blank'] },
          how: { type: 'string', enum: ['sum', 'avg', 'max', 'min'] },
          percent: { type: 'boolean', description: '비율(%)로 표시 (입력률 등)' },
          sort: { type: 'string', enum: ['none', 'desc', 'asc', 'label'] },
          range: {
            type: 'object', description: '결과 중 일부만 남김',
            properties: { mode: { type: 'string', enum: ['top', 'bottom', 'le', 'ge'] }, n: { type: 'number' }, unit: { type: 'string', enum: ['cnt', 'pct'], description: 'top·bottom에서 개수(cnt) 또는 백분율(pct)' } },
            required: ['mode', 'n']
          },
          where: WHERE_SCHEMA,
          reason: { type: 'string', description: '이 개체를 제안하는 이유 (한 문장)' }
        },
        required: ['kind', 'title', 'columns', 'read', 'how']
      }
    }
  ];

  // 대화마다 자료 구조를 미리 제공하여, 모델이 열 구성을 묻거나 허락을 구하지 않게 함
  function schemaBrief() {
    try {
      let t = JSON.stringify(toolSchema());
      if (t.length > 12000) t = t.slice(0, 12000) + '…(생략, 자세한 내용은 get_schema로 확인)';
      return t;
    } catch (e) { return '(확인 불가)'; }
  }
  function aiSystem() {
    return [
      '당신은 교사의 학급 자료 분석을 돕는 "두루보드 분석 파트너"입니다. 한국어 존댓말(하십시오체)로 간결하게 답하십시오.',
      '자료는 도구로만 확인할 수 있습니다. 필요한 계산은 query_rows·aggregate로 하십시오. 숫자를 추측하지 마십시오.',
      '도구는 교사의 허락을 구하지 말고 필요할 때 즉시 호출하십시오. "조회해도 되는지", "결과를 공유해 달라"처럼 묻지 마십시오. 도구 결과는 교사에게 보이지 않으므로 결과를 근거로 질문에 바로 답하십시오. 답변에 도구 이름(get_schema 등)을 쓰지 마십시오.',
      '이미 한 답변을 되풀이하지 마십시오.',
      'ID-07처럼 가명으로 표시된 값은 그대로 사용하여 답하십시오. 가명의 실제 값을 추측하거나 요구하지 마십시오. 교사 화면에서는 자동으로 원래 값으로 표시됩니다.',
      '교사가 그래프·표·통계 카드를 원하거나 보드에 도움이 될 개체가 있으면 propose_object로 제안하십시오. 제안은 교사가 확인한 뒤 추가됩니다.',
      '개체 종류: 숫자 하나로 요약할 때만 통계(stat), 분포는 히스토그램, 반별·항목별 비교는 막대, 학생 목록은 표(table)로 제안하십시오.',
      '도움이 필요한 학생을 찾을 때는 미입력·낮은 점수 등 자료에 근거한 기준을 밝히십시오. 답변은 짧은 문단과 목록 위주로 작성하고, 표는 꼭 필요할 때만 사용하십시오.',
      '보드 제목: ' + (state.meta.title || '(없음)'),
      '현재 자료 구조(전송 설정 반영, 가명 열은 가명으로 표시): ' + schemaBrief()
    ].join('\n');
  }

  // ── 도구 실행 (이 브라우저에서 계산) ──
  function whereToFilter(where) {
    if (!Array.isArray(where) || !where.length) return null;
    const items = where.slice(0, 20).map((w) => {
      if (!w || typeof w.col !== 'string' || !CMPS[w.op]) throw new Error('조건 형식이 올바르지 않습니다.');
      const e = aiColCheck([w.col]);
      if (e) throw new Error(e);
      const v = w.value === undefined || w.value === null ? '' : String(inVal(w.col, w.value));
      return { col: w.col, cmp: w.op, val: noVal(w.op) ? '' : v };
    });
    return { op: 'and', not: false, items };
  }
  function aiRows(where) {
    const f = whereToFilter(where);
    return f ? state.rows.filter((r) => evalNode(f, r)) : state.rows;
  }
  const r2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
  const sendable = () => state.keys.filter((k) => polOf(k) !== 'drop');

  function toolSchema() {
    const al = aliasTable();
    return {
      rowCount: state.rows.length,
      columns: sendable().map((k) => {
        const inf = state.keyInfo.get(k) || {};
        const vals = state.rows.map((r) => r[k]).filter((v) => !isBlank(v));
        const o = { name: k, type: inf.type, filled: vals.length, blank: state.rows.length - vals.length };
        if (inf.label && inf.label !== k) o.label = inf.label;
        if (polOf(k) === 'alias') { o.transfer = '가명'; o.distinct = al.fwd.get(k).size; }
        const ex = [];
        const seen = new Set();
        vals.forEach((v) => { const s = rawStr(v); if (ex.length < 5 && !seen.has(s)) { seen.add(s); ex.push(outVal(k, v)); } });
        o.examples = ex;
        if (inf.type === 'number' || inf.type === 'boolean') {
          const nums = vals.map((v) => numericOf(v, inf.type)).filter((n) => n !== null);
          if (nums.length) { o.min = r2(Math.min.apply(null, nums)); o.max = r2(Math.max.apply(null, nums)); o.avg = r2(combine(nums, 'avg')); }
        }
        return o;
      }),
      excludedColumns: state.keys.length - sendable().length
    };
  }
  function toolQuery(a) {
    const cols = Array.isArray(a.columns) && a.columns.length ? a.columns : sendable();
    const err = aiColCheck(cols);
    if (err) return { error: err };
    let rows = aiRows(a.where);
    const total = rows.length;
    if (a.sort_by) {
      const e = aiColCheck([a.sort_by]);
      if (e) return { error: e };
      const k = a.sort_by, ty = tyOf(k), dir = a.order === 'desc' ? -1 : 1;
      rows = rows.slice().sort((x, y) => {
        const p = numericOf(x[k], ty), q = numericOf(y[k], ty);
        if (p === null && q === null) return rawStr(x[k]).localeCompare(rawStr(y[k]), 'ko') * dir;
        if (p === null) return 1;
        if (q === null) return -1;
        return (p - q) * dir;
      });
    }
    const lim = Math.max(1, Math.min(100, Math.floor(Number(a.limit) || 30)));
    return { matched: total, returned: Math.min(lim, total), rows: rows.slice(0, lim).map((r) => { const o = {}; cols.forEach((k) => { o[k] = outVal(k, r[k]); }); return o; }) };
  }
  function toolAggregate(a) {
    const cols = Array.isArray(a.columns) ? a.columns : [];
    if (!cols.length) return { error: 'columns를 지정하십시오.' };
    const err = aiColCheck(cols.concat(a.label_col ? [a.label_col] : [], a.group_by ? [a.group_by] : []));
    if (err) return { error: err };
    const read = ['num', 'filled', 'blank'].includes(a.read) ? a.read : 'num';
    const how = ['sum', 'avg', 'max', 'min'].includes(a.how) ? a.how : 'sum';
    if (read === 'num') { const sc = cols.filter((k) => tyOf(k) === 'string'); if (sc.length) return { error: '문자 열은 숫자로 읽을 수 없습니다: ' + sc.join(', ') }; }
    const rows = aiRows(a.where);
    const cell = (r, k) => readCell(r[k], read, tyOf(k));
    let out;
    if (a.per === 'row') {
      const lc = a.label_col;
      out = rows.map((r, i) => ({ label: lc ? outVal(lc, r[lc]) : '행 ' + (i + 1), value: r2(combine(cols.map((k) => cell(r, k)), how)) }));
    } else {
      const groups = new Map();
      if (a.group_by) rows.forEach((r) => { const g = isBlank(r[a.group_by]) ? '(빈칸)' : outVal(a.group_by, r[a.group_by]); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); });
      else groups.set(null, rows);
      out = [];
      groups.forEach((rs, g) => {
        if (a.per === 'column') cols.forEach((k) => out.push(Object.assign(g !== null ? { group: g } : {}, { label: k, value: r2(combine(rs.map((r) => cell(r, k)), how)) })));
        else {
          const all = [];
          rs.forEach((r) => cols.forEach((k) => all.push(cell(r, k))));
          out.push(Object.assign(g !== null ? { group: g } : {}, { label: g !== null ? String(g) : '전체', value: r2(combine(all, how)) }));
        }
      });
    }
    if (a.sort === 'asc' || a.sort === 'desc') out.sort((x, y) => (x.value === null) - (y.value === null) || (a.sort === 'asc' ? x.value - y.value : y.value - x.value));
    const lim = Math.max(1, Math.min(200, Math.floor(Number(a.limit) || 50)));
    return { rowsUsed: rows.length, results: out.length, items: out.slice(0, lim) };
  }
  function aliasLabel(cfg, lab) {
    if (isStat(cfg) || cfg.mode !== 'row') return lab;
    const k = cfg.label;
    if (polOf(k) === 'drop') return '(제외된 열)';
    if (polOf(k) !== 'alias') return lab;
    const m = aliasTable().fwd.get(k);
    if (m.has(lab)) return m.get(lab);
    for (const [real, al] of m) { if (display(real) === lab) return al; }
    return '(가명)';
  }
  function toolBoard() {
    const gname = (id) => { const g = state.groups.find((x) => x.id === id); if (!g) return null; const p = g.parent && state.groups.find((x) => x.id === g.parent); return p ? p.name + ' › ' + g.name : g.name; };
    return {
      title: state.meta.title || '',
      objects: state.layout.map((cfg) => {
        const o = { title: cfg.title || autoTitle(cfg), kind: isStat(cfg) ? 'stat' : 'chart', group: gname(cfg.group) };
        const used = selCols(cfg).concat(cfg.mode === 'row' && !isStat(cfg) ? [cfg.label] : []);
        if (used.some((k) => polOf(k) === 'drop')) { o.note = '제외된 열을 사용하는 개체이므로 내용을 보내지 않습니다.'; return o; }
        if (!isStat(cfg)) o.type = cfg.type;
        o.description = describe(cfg);
        const res = compute(cfg);
        if (res.error) { o.error = res.error; return o; }
        if (isStat(cfg)) { o.value = r2(res.value); o.unit = isPercent(cfg) ? '%' : ''; return o; }
        o.items = res.labels.slice(0, 60).map((l, i) => {
          const it = { label: res.hist ? l : aliasLabel(cfg, l) };
          res.series.forEach((s) => { it[res.series.length > 1 ? s.name : 'value'] = r2(s.data[i]); });
          return it;
        });
        if (res.labels.length > 60) o.more = res.labels.length - 60;
        return o;
      })
    };
  }
  function toolPropose(a) {
    const cols = Array.isArray(a.columns) ? a.columns.filter((x) => typeof x === 'string') : [];
    const kind = a.kind === 'stat' ? 'stat' : 'chart';
    const mode = kind === 'stat' ? 'col' : a.mode === 'col' ? 'col' : 'row';
    const label = mode === 'row' ? (a.label_col || idKey()) : '';
    const err = aiColCheck(cols.concat(label ? [label] : []));
    if (err) return { error: err };
    let filter = null;
    try { filter = whereToFilter(a.where); } catch (e) { return { error: e.message }; }
    const raw = {
      kind, title: typeof a.title === 'string' ? a.title.trim().slice(0, 60) : '', mode, cols, label,
      read: a.read, how: a.how, type: a.type === 'list' ? 'table' : a.type, sort: a.sort, pct: a.percent === true,
      filter, range: a.range ? { mode: a.range.mode, n: a.range.n, unit: a.range.unit === 'pct' ? 'pct' : 'cnt' } : null
    };
    if (kind === 'chart' && raw.type === 'table') raw.align = 'center';
    // 목적과 맞지 않는 구성 걸러 내기 (AI가 다시 제안하도록 이유를 돌려줌)
    const words = (raw.title || '') + ' ' + (a.reason || '');
    if (kind === 'stat' && (a.label_col || a.mode === 'row' || /분포|[가-힣]별(\s|$)|목록|명단|비교|추이/.test(words))) {
      return { error: '통계(stat)는 숫자 하나만 표시합니다. 분포·항목별 비교·목록은 kind=chart(type=hist·bar·hbar·table)로 다시 제안하십시오.' };
    }
    if (raw.read === 'filled' || raw.read === 'blank') {
      const full = cols.filter((k) => state.rows.every((r) => !isBlank(r[k])));
      if (full.length === cols.length) return { error: '선택한 열에는 빈칸이 없어 입력 여부(filled·blank)로 읽으면 모든 값이 같습니다. 숫자 값을 쓰려면 read=num을 사용하십시오.' };
    }
    if (raw.type === 'hist' && raw.read !== 'num') return { error: '히스토그램(분포)은 read=num으로 숫자 값을 읽어야 합니다.' };
    const cfg = sanitizeConfig(raw);
    const res = compute(cfg);
    if (res.error) return { error: '이 구성으로는 계산할 수 없습니다: ' + res.error };
    cfg.title = uniqueTitle(cfg.title || autoTitle(cfg));
    const pid = uid();
    aiProposals.set(pid, { cfg, reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : '' });
    // 계산 결과 요약을 함께 돌려주어 AI가 의도와 맞는지 스스로 확인하게 함
    const preview = isStat(cfg) ? { value: r2(res.value), unit: isPercent(cfg) ? '%' : '' }
      : { items: res.labels.length, sample: res.labels.slice(0, 8).map((l, i) => ({ label: res.hist ? l : aliasLabel(cfg, l), value: r2(res.series[0].data[i]) })) };
    return { ok: true, proposalId: pid, preview, message: '교사 화면에 제안 카드를 표시하였습니다. 교사가 확인하면 보드에 추가됩니다. preview가 의도와 다르면 그 사실을 알리고 다시 제안하십시오.' };
  }
  function runTool(name, args) {
    try {
      args = args && typeof args === 'object' ? args : {};
      if (name === 'get_schema') return toolSchema();
      if (name === 'query_rows') return toolQuery(args);
      if (name === 'aggregate') return toolAggregate(args);
      if (name === 'get_board') return toolBoard();
      if (name === 'propose_object') return toolPropose(args);
      return { error: '알 수 없는 도구입니다: ' + name };
    } catch (e) { return { error: e.message || String(e) }; }
  }
  const TOOL_LABEL = { get_schema: '자료 구조 확인', query_rows: '행 조회', aggregate: '집계', get_board: '보드 확인', propose_object: '개체 제안' };

  // ── 공급자별 요청 ──
  // AbortSignal은 일부 미리보기 환경(요청을 다른 창으로 넘겨 처리)에서 복제되지 않으므로 사용하지 않고,
  // 시간 초과·중단은 별도 약속(Promise)으로 처리
  function aiFetch(url, opt) {
    let timer, rej;
    const stop = new Promise((_, r) => { rej = r; timer = setTimeout(() => r(Object.assign(new Error('timeout'), { name: 'AbortError' })), AI_TIMEOUT_MS); });
    stop.catch(() => {});
    aiAbort = { abort() { rej(Object.assign(new Error('abort'), { name: 'AbortError' })); } };
    return Promise.race([fetch(url, Object.assign({ credentials: 'omit', referrerPolicy: 'no-referrer' }, opt)), stop]).finally(() => clearTimeout(timer));
  }
  function authHead(p) {
    return p.api === 'ant' ? { 'x-api-key': aiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : p.api === 'gem' ? { 'x-goog-api-key': aiKey } : { Authorization: 'Bearer ' + aiKey };
  }
  // 공급자 요청: 웹 앱 중계가 있으면 웹 앱이 저장된 키로 대신 보내고, 없으면 이 브라우저에서 직접 보냄
  function aiReq(url, body) {
    if (gasRelay) return gasAi(url, body);
    const h = Object.assign(body ? { 'Content-Type': 'application/json' } : {}, authHead(aiProv()));
    return aiFetch(url, body ? { method: 'POST', headers: h, body } : { headers: h });
  }
  function gasAi(url, body) {
    let timer, rej;
    const stop = new Promise((_, r) => { rej = r; timer = setTimeout(() => r(Object.assign(new Error('timeout'), { name: 'AbortError' })), AI_TIMEOUT_MS); });
    stop.catch(() => {});
    aiAbort = { abort() { rej(Object.assign(new Error('abort'), { name: 'AbortError' })); } };
    const call = gasCall('duruboardAi', [JSON.stringify({ provider: aiCfg.provider, url, method: body ? 'post' : 'get', body: body || '' })], AI_TIMEOUT_MS + 5000)
      .then((v) => {
        let o = v;
        if (typeof v === 'string') { try { o = JSON.parse(v); } catch (e) { o = null; } }
        if (!o || typeof o.status !== 'number') throw new Error('웹 앱의 응답을 해석하지 못하였습니다.');
        return { ok: o.status >= 200 && o.status < 300, status: o.status, json: async () => JSON.parse(String(o.body || '')) };
      }, (e) => { if (e.name === 'AbortError') throw e; throw new Error('웹 앱을 통한 AI 요청에 실패하였습니다. (' + e.message + ')'); });
    return Promise.race([call, stop]).finally(() => clearTimeout(timer));
  }
  async function aiJson(res) {
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const m = body && (body.error && (body.error.message || body.error.type) || body.message) || '';
      const base = res.status === 401 || res.status === 403 ? '인증 키가 올바르지 않거나 권한이 없습니다.'
        : res.status === 404 ? '모델을 찾을 수 없습니다. 모델명을 확인하십시오.'
        : res.status === 429 ? '요청 한도를 초과하였습니다. 잠시 후 다시 시도하십시오.'
        : res.status === 400 ? '요청이 거부되었습니다.'
        : '공급자 오류가 발생하였습니다 (HTTP ' + res.status + ').';
      throw new Error(base + (m ? ' (' + String(m).slice(0, 200) + ')' : ''));
    }
    return body || {};
  }
  function geminiSchema(s) {
    if (Array.isArray(s)) return s.map(geminiSchema);
    if (!s || typeof s !== 'object') return s;
    const o = {};
    Object.keys(s).forEach((k) => {
      if (k === 'type') o.type = String(s.type).toUpperCase();
      else if (k === 'properties') { o.properties = {}; Object.keys(s.properties).forEach((p) => { o.properties[p] = geminiSchema(s.properties[p]); }); }
      else o[k] = geminiSchema(s[k]);
    });
    if (o.type === 'OBJECT' && o.properties && !Object.keys(o.properties).length) delete o.properties;
    return o;
  }
  async function aiCall() {
    const p = aiProv(), model = aiModel(), sys = aiSystem();
    if (p.api === 'oai') {
      const messages = [{ role: 'system', content: sys }];
      aiMsgs.forEach((m) => {
        if (m.role === 'user') messages.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant') {
          const o = { role: 'assistant', content: m.text || '' };
          if (m.calls.length) o.tool_calls = m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
          messages.push(o);
        } else m.results.forEach((r) => messages.push({ role: 'tool', tool_call_id: r.id, content: r.content }));
      });
      const res = await aiReq(p.url, JSON.stringify({ model, messages, tools: AI_TOOLS.map((t) => ({ type: 'function', function: t })) }));
      const j = await aiJson(res);
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      const calls = (msg.tool_calls || []).filter((c) => c.function).map((c) => {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch (e) { args = {}; }
        return { id: c.id || uid(), name: c.function.name, args };
      });
      return { text: typeof msg.content === 'string' ? msg.content : '', calls, raw: null };
    }
    if (p.api === 'ant') {
      const messages = [];
      aiMsgs.forEach((m) => {
        if (m.role === 'user') messages.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant') {
          const content = m.prov === 'anthropic' && m.raw ? m.raw : [].concat(m.text ? [{ type: 'text', text: m.text }] : [], m.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} })));
          messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '…' }] });
        } else messages.push({ role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) });
      });
      const res = await aiReq(p.url, JSON.stringify({ model, max_tokens: 4096, system: sys, messages, tools: AI_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }));
      const j = await aiJson(res);
      const blocks = Array.isArray(j.content) ? j.content : [];
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
        calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
        raw: blocks
      };
    }
    // Gemini
    const contents = [];
    aiMsgs.forEach((m) => {
      if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.text }] });
      else if (m.role === 'assistant') {
        const parts = m.prov === 'gemini' && m.raw ? m.raw : [].concat(m.text ? [{ text: m.text }] : [], m.calls.map((c) => ({ functionCall: { name: c.name, args: c.args || {} } })));
        contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '…' }] });
      } else {
        contents.push({ role: 'user', parts: m.results.map((r) => { let resp; try { resp = JSON.parse(r.content); } catch (e) { resp = { result: r.content }; } const fr = { name: r.name, response: { result: resp } }; if (r.gid) fr.id = r.gid; return { functionResponse: fr }; }) });
      }
    });
    const res = await aiReq(p.url + encodeURIComponent(model) + ':generateContent', JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, tools: [{ functionDeclarations: AI_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }] }));
    const j = await aiJson(res);
    const cand = j.candidates && j.candidates[0];
    if (!cand) throw new Error('응답이 비어 있습니다.' + (j.promptFeedback && j.promptFeedback.blockReason ? ' (차단 사유: ' + j.promptFeedback.blockReason + ')' : ''));
    const parts = (cand.content && cand.content.parts) || [];
    return {
      text: parts.filter((x) => typeof x.text === 'string' && !x.thought).map((x) => x.text).join('').trim(),
      calls: parts.filter((x) => x.functionCall).map((x) => ({ id: x.functionCall.id || uid(), gid: x.functionCall.id || null, name: x.functionCall.name, args: x.functionCall.args || {} })),
      raw: parts
    };
  }

  // ── 대화 화면 ──
  function aiReady() { return gasRelay ? !!gasRelay.saved[aiCfg.provider] : !!aiKey; }
  // 분석 파트너 단추: 자료를 연결하고 인증 키를 입력한 경우에만 왼쪽 아래에 표시
  function syncAiFab() { $('btn-ai').hidden = !(state.source && (aiReady() || aiLocked())); }
  function aiScroll() { const l = $('ai-log'); l.scrollTop = l.scrollHeight; }
  // 가명(ID-07 등)을 원래 값으로 복원하여 표시
  // 가명(ID-07 등)을 찾아 표시 요소로 바꿈. 모델이 다른 붙임표(‐‑–—−)나 자릿수를 쓰더라도 인식
  // 실제 값으로의 변환은 AI에 묻지 않고 이 화면의 가명표로만 처리
  function aliasKey(pre, num) {
    return 'ID' + pre + '-' + String(Number(num)).padStart(aliasWidth(), '0');
  }
  function restoreInto(node, text) {
    const al = state.source ? aliasTable() : null;
    const re = /ID(\d{0,2})\s?[-‐‑‒–—−]\s?(\d{1,6})(?!\d)/g;
    let last = 0, m;
    while (al && (m = re.exec(text))) {
      if (m.index > 0 && /[A-Za-z0-9]/.test(text[m.index - 1])) continue;
      const key = aliasKey(m[1], m[2]);
      const hit = al.back.get(key);
      if (!hit) continue;
      if (m.index > last) node.append(document.createTextNode(text.slice(last, m.index)));
      const s = el('span', 'ai-pn', m[0]);
      s.dataset.a = m[0];
      s.dataset.r = hit.value;
      s.title = '가명 ' + key;
      node.append(s);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.append(document.createTextNode(text.slice(last)));
  }
  // 답변 말풍선: 가명이 있으면 오른쪽 아래에 [실제 값 보기] 단추 (화면 공유 등을 고려해 기본은 가명 표시)
  function aiAnswer(text) {
    const md = renderMd(text);
    const b = aiBubble('bot', md);
    const pns = md.querySelectorAll('.ai-pn');
    if (!pns.length) return b;
    const bar = el('div', 'ai-pn-bar');
    const btn = el('button', 'ai-pn-btn');
    btn.type = 'button';
    const set = (on) => {
      pns.forEach((s) => { s.textContent = on ? s.dataset.r : s.dataset.a; s.classList.toggle('on', on); s.title = on ? '가명 ' + s.dataset.a + '의 실제 값 (이 화면에서만 표시)' : '가명 ' + s.dataset.a; });
      btn.textContent = on ? '가명으로 보기' : '실제 값 보기';
      btn.setAttribute('aria-pressed', String(on));
      b.classList.toggle('revealed', on);
    };
    btn.addEventListener('click', () => set(btn.getAttribute('aria-pressed') !== 'true'));
    btn.title = '가명을 이 화면의 가명표로 실제 값으로 바꾸어 표시합니다. AI에게는 전송하지 않습니다.';
    bar.append(btn);
    b.append(bar);
    set(false);
    aiScroll();
    return b;
  }
  function inlineMd(node, text) {
    const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    parts.forEach((p) => {
      if (!p) return;
      if (/^\*\*[^*]+\*\*$/.test(p)) { const b = el('b'); restoreInto(b, p.slice(2, -2)); node.append(b); }
      else if (/^`[^`]+`$/.test(p)) { const c = el('code'); restoreInto(c, p.slice(1, -1)); node.append(c); }
      else restoreInto(node, p);
    });
  }
  // 간단한 서식(문단·목록·굵게·표)만 해석하며, 모든 내용은 텍스트로만 넣음
  function renderMd(text) {
    const box = el('div', 'ai-md');
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let i = 0, list = null;
    while (i < lines.length) {
      const ln = lines[i];
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        list = null;
        const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        const wrap = el('div', 'table-wrap ai-tbl');
        const t = el('table', 'table');
        const hr = el('tr');
        cells(ln).forEach((c) => { const th = el('th'); inlineMd(th, c); hr.append(th); });
        const th = el('thead'); th.append(hr);
        const tb = el('tbody');
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const tr = el('tr');
          cells(lines[i]).forEach((c) => { const td = el('td'); inlineMd(td, c); tr.append(td); });
          tb.append(tr); i++;
        }
        t.append(th, tb); wrap.append(t); box.append(wrap);
        continue;
      }
      const li = ln.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (li) {
        const ordered = /^\s*\d/.test(ln);
        if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { list = el(ordered ? 'ol' : 'ul'); box.append(list); }
        const item = el('li'); inlineMd(item, li[1]); list.append(item);
      } else if (/^\s*#{1,4}\s+/.test(ln)) {
        list = null; const h = el('p', 'ai-h'); inlineMd(h, ln.replace(/^\s*#{1,4}\s+/, '')); box.append(h);
      } else if (ln.trim()) {
        list = null; const p = el('p'); inlineMd(p, ln); box.append(p);
      } else list = null;
      i++;
    }
    return box;
  }
  function aiBubble(role, node) {
    const b = el('div', 'ai-msg ' + role);
    b.append(node);
    $('ai-log').append(b);
    aiScroll();
    return b;
  }
  function aiToolLine(name, args, result) {
    let t = TOOL_LABEL[name] || name;
    if (result && result.error) t += ' · 실패';
    else if (name === 'query_rows' && result) t += ' · ' + result.returned + '행';
    else if (name === 'aggregate' && result) t += ' · 결과 ' + result.results + '개';
    const line = el('div', 'ai-tool');
    line.append(el('span', 'ai-tool-dot'), document.createTextNode(t));
    $('ai-log').append(line);
    aiScroll();
  }
  function proposalCard(pid) {
    const p = aiProposals.get(pid);
    if (!p) return;
    const cfg = p.cfg;
    const box = el('div', 'ai-prop');
    const head = el('div', 'ai-prop-head');
    head.append(el('span', 'ai-prop-tag', '개체 제안'), el('b', null, cfg.title));
    box.append(head);
    if (p.reason) { const r = el('p', 'ai-prop-why'); restoreInto(r, p.reason); box.append(r); }
    box.append(el('p', 'card-desc', (isStat(cfg) ? '통계 · ' : (CHART_TYPES.find((t) => t.id === cfg.type) || {}).label + ' · ') + describe(cfg)));
    const view = el('div', 'ai-prop-view');
    const res = compute(cfg);
    if (isStat(cfg)) { const s = el('div', 'card stat ai-prop-stat'); renderStatBody(res, cfg, s); view.append(s); }
    else if (res.error) view.append(el('p', 'card-warn', res.error));
    else if (cfg.type === 'table') view.append(renderTable(res, cfg));
    else {
      const cb = el('div', 'chart-box');
      const cv = el('canvas');
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', cfg.title + ' 그래프');
      cb.append(cv);
      if (cfg.type === 'hbar') cb.style.height = Math.max(200, Math.min(420, res.labels.length * 20 + 60)) + 'px';
      view.append(cb);
      requestAnimationFrame(() => { const c = drawChart(cfg, cv, res); if (c) aiCharts.push(c); });
    }
    box.append(view);
    const act = el('div', 'ai-prop-act');
    const edit = el('button', 'btn small', '편집 후 추가');
    edit.type = 'button';
    const add = el('button', 'btn small primary', '보드에 추가');
    add.type = 'button';
    const done = (t) => { act.replaceChildren(el('span', 'ai-prop-done', t)); };
    add.addEventListener('click', () => {
      const c = sanitizeConfig(JSON.parse(JSON.stringify(cfg)));
      c.id = uid();
      c.title = uniqueTitle(c.title);
      state.layout.push(c);
      saveLayout();
      renderBoard();
      done('보드에 추가하였습니다.');
    });
    edit.addEventListener('click', () => {
      $('dlg-ai').close();
      openChartDialog(null, cfg.kind, JSON.parse(JSON.stringify(cfg)));
    });
    act.append(edit, add);
    box.append(act);
    aiBubble('bot prop', box);
  }
  function aiErr(text) {
    const p = el('div', 'ai-err');
    p.append(el('b', null, '요청 실패'), el('p', null, text));
    aiBubble('bot', p);
  }
  function aiThinking(on) {
    const cur = $('ai-log').querySelector('.ai-typing');
    if (cur) cur.remove();
    if (on) { const t = el('div', 'ai-typing'); t.append(el('i'), el('i'), el('i')); $('ai-log').append(t); aiScroll(); }
  }
  function aiSetBusy(b) {
    aiBusy = b;
    $('ai-send').disabled = b || !aiIsConfirmed();
    $('ai-send').classList.toggle('stop', false);
    $('ai-in').disabled = b || !aiIsConfirmed();
    $('ai-clear').disabled = b;
    aiThinking(b);
  }
  // 전송 확인: 처음 질문하거나 전송 설정이 바뀐 뒤에는 무엇을 보내는지 먼저 확인
  function sendSummary() {
    const n = { send: [], alias: [], drop: [] };
    state.keys.forEach((k) => n[polOf(k)].push(labelOf(k)));
    return n;
  }
  // 자료 전송 확인: 대화를 시작하기 전에 전송 기준·가명 처리 방식·유의 사항을 안내하고 동의를 받음
  // (자료·열별 전송 설정·공급자가 바뀌면 다시 확인)
  function aiIsConfirmed() { return aiConfirmed === aiPolSig() && aiConfirmedProv === aiCfg.provider; }
  function aiLock(on) {
    $('ai-in').disabled = on || aiBusy;
    $('ai-send').disabled = on || aiBusy;
    $('ai-in').placeholder = on ? '자료 전송 기준을 확인하면 질문할 수 있습니다' : '자료에 대해 질문하십시오';
    $('ai-starters').hidden = on || aiMsgs.length > 0;
  }
  function aiGate() {
    $('ai-log').querySelectorAll('.ai-msg.gate').forEach((n) => n.remove());
    if (!state.source || aiIsConfirmed()) { aiLock(false); return true; }
    aiLock(true);
    const s = sendSummary();
    const box = el('div', 'ai-confirm');
    box.append(el('b', 'ai-confirm-t', '자료 전송 확인'));
    box.append(el('p', null, aiProv().label + '(' + aiModel() + ')에 질문과 함께, AI가 요청하는 범위의 자료를 아래 기준으로 전송합니다.'));
    const dl = el('dl', 'ai-confirm-dl');
    const row = (k, arr, cls) => { const d = el('div', cls); d.append(el('dt', null, k + ' ' + arr.length + '개'), el('dd', null, arr.length ? (arr.length > 8 ? arr.slice(0, 8).join(', ') + ' 외 ' + (arr.length - 8) + '개' : arr.join(', ')) : '없음')); dl.append(d); };
    row('전송', s.send, 'c-send'); row('가명', s.alias, 'c-alias'); row('제외', s.drop, 'c-drop');
    box.append(dl);
    const how = el('div', 'ai-confirm-note');
    how.append(el('b', null, '가명 처리 방식'));
    const ul = el('ul');
    [
      '가명 열의 값은 전송 전에 이 브라우저에서 ID-01과 같은 번호로 바꾸어 보냅니다.',
      '실제 값과 번호의 대응표는 이 화면에만 있으며 AI에게 전송하지 않습니다.',
      'AI 답변에 나온 번호는 [실제 값 보기]를 누르면 이 화면에서만 원래 값으로 복원됩니다.'
    ].forEach((x) => ul.append(el('li', null, x)));
    how.append(ul);
    box.append(how);
    const warn = el('div', 'ai-confirm-warn');
    warn.append(el('b', null, '유의 사항'));
    warn.append(el('p', null, '학생의 이름·연락처 등 개인을 알아볼 수 있는 정보가 담긴 열은 반드시 가명 또는 제외로 설정하십시오. 전송한 자료는 선택한 AI 공급자의 정책에 따라 처리됩니다.'));
    box.append(warn);
    box.append(el('p', 'ai-confirm-q', '위 내용을 이해하였습니까?'));
    const act = el('div', 'ai-prop-act');
    const set = el('button', 'btn small', '설정 변경');
    set.type = 'button';
    const ok = el('button', 'btn small primary', '예, 이해하였습니다');
    ok.type = 'button';
    set.addEventListener('click', () => openAiCols());
    ok.addEventListener('click', () => {
      aiConfirmed = aiPolSig();
      aiConfirmedProv = aiCfg.provider;
      const done = el('div', 'ai-confirm-done');
      done.append(el('span', 'ai-prop-done', '자료 전송 기준을 확인하였습니다.'), document.createTextNode(' 전송 ' + s.send.length + ' · 가명 ' + s.alias.length + ' · 제외 ' + s.drop.length));
      bub.classList.remove('gate');
      bub.replaceChildren(done);
      aiLock(false);
      $('ai-in').focus();
    });
    act.append(set, ok);
    box.append(act);
    const bub = aiBubble('bot gate', box);
    return false;
  }
  let aiPendingConfirm = null;
  async function aiSend(text) {
    text = String(text || '').trim();
    if (!text || aiBusy) return;
    if (!state.source) { aiErr('자료를 먼저 연결하십시오.'); return; }
    if (!aiReady() && aiLocked()) { try { await unlockKey(); } catch (e) { aiErr(lockErr(e)); return; } }
    if (!aiReady()) { aiErr('레이아웃 설정 › 분석 파트너에서 인증 키를 입력하십시오.'); return; }
    if (!aiIsConfirmed()) { aiGate(); return; }
    $('ai-in').value = '';
    autoGrow();
    $('ai-starters').hidden = true;
    const ub = el('div');
    ub.append(document.createTextNode(text));
    aiBubble('me', ub);
    aiMsgs.push({ role: 'user', text });
    aiSetBusy(true);
    let nudged = false;
    const norm = (t) => String(t || '').replace(/\s+/g, '');
    const saidBefore = (t) => aiMsgs.some((m) => m.role === 'assistant' && m.text && norm(m.text) === norm(t));
    try {
      for (let round = 0; round < AI_MAX_ROUNDS; round++) {
        const r = await aiCall();
        const dup = !!r.text && !r.calls.length && norm(r.text).length > 20 && saidBefore(r.text);
        aiMsgs.push({ role: 'assistant', text: r.text, calls: r.calls, raw: r.raw, prov: aiCfg.provider });
        if (dup && !nudged && round < AI_MAX_ROUNDS - 1) {
          // 같은 답을 되풀이하면 표시하지 않고, 확인한 자료로 바로 답하도록 한 번 더 요청함
          nudged = true;
          aiMsgs.push({ role: 'user', hidden: true, text: '방금과 같은 답변입니다. 교사에게 다시 묻지 말고, 확인한 자료를 근거로 원래 질문에 바로 답하십시오. 필요하면 도구를 더 호출하십시오.' });
          continue;
        }
        aiThinking(false);
        if (r.text && !dup) aiAnswer(r.text);
        if (!r.calls.length) break;
        const results = r.calls.map((c) => {
          const out = runTool(c.name, c.args);
          aiToolLine(c.name, c.args, out);
          if (c.name === 'propose_object' && out.ok) proposalCard(out.proposalId);
          let s = JSON.stringify(out);
          if (s.length > 60000) s = JSON.stringify({ error: '결과가 너무 큽니다. 조건이나 limit으로 범위를 줄이십시오.' });
          return { id: c.id, gid: c.gid || null, name: c.name, content: s };
        });
        aiMsgs.push({ role: 'tool', results });
        aiThinking(true);
        if (round === AI_MAX_ROUNDS - 1) aiBubble('bot', renderMd('도구 호출 횟수가 많아 이번 답변을 중단하였습니다. 질문을 좁혀 다시 시도하십시오.'));
      }
    } catch (e) {
      aiThinking(false);
      const msg = e.name === 'AbortError' ? '응답 시간이 초과되었거나 요청을 중단하였습니다.'
        : e instanceof TypeError ? '공급자에 연결하지 못하였습니다. 네트워크 상태를 확인하십시오. 공급자가 브라우저의 직접 요청을 허용하지 않는 경우에도 이 오류가 발생합니다.'
        : e.message;
      aiErr(msg);
      // 실패한 질문은 기록에서 제외하여 다음 요청이 깨지지 않게 함
      while (aiMsgs.length && !(aiMsgs[aiMsgs.length - 1].role === 'user' && !aiMsgs[aiMsgs.length - 1].hidden)) aiMsgs.pop();
      if (aiMsgs.length) aiMsgs.pop();
    } finally {
      aiAbort = null;
      aiSetBusy(false);
      $('ai-in').focus();
    }
  }
  let aiConfirmedProv = '';
  function autoGrow() { const t = $('ai-in'); t.style.height = 'auto'; const h = t.scrollHeight; t.style.height = Math.min(140, h) + 'px'; t.classList.toggle('scroll', h > 140); t.scrollLeft = 0; }
  function aiReset() {
    aiCharts.forEach((c) => { try { c.destroy(); } catch (e) { /* 무시 */ } });
    aiCharts = [];
    aiMsgs = [];
    aiProposals.clear();
    $('ai-log').replaceChildren();
    const hi = el('div', 'ai-hello');
    const t = el('p', 'ai-hello-t', '무엇을 도와드릴까요?');
    const d = el('p', null, '자료에 대해 질문하거나, 보드에 추가할 그래프·표·통계를 요청하십시오. 자료는 열별 전송 설정에 따라 필요한 만큼만 전송합니다.');
    hi.append(t, d);
    if (!aiReady() && aiLocked()) {
      const w = el('p', 'ai-hello-warn', '인증 키가 이 기기에 잠금 저장되어 있습니다. ');
      const go = el('button', 'link', '잠금 해제 ›');
      go.type = 'button';
      go.addEventListener('click', async () => { try { await unlockKey(); } catch (e) { aiErr(lockErr(e)); } });
      w.append(go);
      hi.append(w);
    } else if (!aiReady()) {
      const w = el('p', 'ai-hello-warn', '인증 키가 입력되지 않았습니다. ');
      const go = el('button', 'link', '설정 열기 ›');
      go.type = 'button';
      go.addEventListener('click', () => { $('dlg-ai').close(); openExport(); setTimeout(() => $('ai-key').focus(), 50); });
      w.append(go);
      hi.append(w);
    }
    $('ai-log').append(hi);
    const st = $('ai-starters');
    st.replaceChildren();
    ['자료 현황을 요약해 주세요', '도움이 필요한 학생을 찾아 주세요', '보드에 추가하면 좋을 개체를 제안해 주세요'].forEach((q) => {
      const b = el('button', 'ai-starter', q);
      b.type = 'button';
      b.addEventListener('click', () => aiSend(q));
      st.append(b);
    });
    st.hidden = false;
    aiGate();
  }
  // 넓은 화면: 오른쪽에 붙는 패널(뒤 화면을 가리지 않고 보드를 왼쪽으로 좁힘), 좁은 화면: 다른 창과 같은 팝업
  const AI_DOCK_MQ = '(min-width: 944px)';
  const AI_W_MIN = 340;
  const aiWide = () => window.matchMedia(AI_DOCK_MQ).matches;
  function aiDockMax() { return Math.max(AI_W_MIN, Math.min(900, window.innerWidth - 480)); }
  function aiDockW() {
    const v = Number(store.get('aiw')) || 440;
    return Math.round(Math.max(AI_W_MIN, Math.min(aiDockMax(), v)));
  }
  function syncDockN() {
    const root = document.documentElement;
    const before = curN();
    if (root.classList.contains('ai-docked')) {
      const avail = window.innerWidth - aiDockW();
      const n = avail >= 1872 ? 4 : avail >= 1408 ? 3 : avail >= 944 ? 2 : 1;
      root.style.setProperty('--n', String(n));
      root.dataset.n = String(n);
    } else { root.style.removeProperty('--n'); delete root.dataset.n; }
    if (!state.source || $('view-board').hidden) return;
    if (curN() !== before) renderBoard(); else packGrids();
  }
  function applyDock(on) {
    const root = document.documentElement;
    root.classList.toggle('ai-docked', on);
    if (on) root.style.setProperty('--dock-w', aiDockW() + 'px'); else root.style.removeProperty('--dock-w');
    syncDockN();
  }
  function openAi(toggle) {
    const d = $('dlg-ai');
    if (d.open) { if (toggle === true) d.close(); else { closePop(); closeExport(); $('ai-who').textContent = aiProv().label + ' · ' + aiModel(); $('ai-in').focus(); } return; }
    closePop(); closeExport();
    $('ai-who').textContent = aiProv().label + ' · ' + aiModel();
    if (!aiMsgs.length) aiReset(); else aiGate();
    const dock = aiWide();
    d.classList.toggle('dock', dock);
    d.classList.toggle('popup', !dock);
    if (dock) { d.show(); applyDock(true); } else d.showModal();
    setTimeout(() => { $('ai-in').focus(); aiScroll(); }, 30);
  }
  // 패널 왼쪽 가장자리를 끌어 너비 조절
  function initAiResize() {
    const h = $('ai-resize');
    let drag = null;
    const setW = (w, save) => {
      w = Math.round(Math.max(AI_W_MIN, Math.min(aiDockMax(), w)));
      document.documentElement.style.setProperty('--dock-w', w + 'px');
      if (save) { store.set('aiw', String(w)); syncDockN(); }
      return w;
    };
    h.addEventListener('pointerdown', (e) => {
      if (!$('dlg-ai').classList.contains('dock')) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId };
      document.documentElement.classList.add('ai-resizing');
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag) return;
      store.set('aiw', String(setW(window.innerWidth - e.clientX, false)));
      if (!drag.raf) drag.raf = requestAnimationFrame(() => { if (drag) { drag.raf = 0; syncDockN(); } });
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      document.documentElement.classList.remove('ai-resizing');
      syncDockN();
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setW(aiDockW() + (e.key === 'ArrowLeft' ? 24 : -24), true);
    });
    h.addEventListener('dblclick', () => setW(440, true));
    // 화면 크기가 바뀌어 형태(패널·팝업)가 달라지면 다시 엶
    window.addEventListener('resize', () => {
      const d = $('dlg-ai');
      if (!d.open) return;
      if (d.classList.contains('dock') !== aiWide()) { d.close(); openAi(); return; }
      if (d.classList.contains('dock')) { if (!document.documentElement.classList.contains('ai-docked')) applyDock(true); else { document.documentElement.style.setProperty('--dock-w', aiDockW() + 'px'); syncDockN(); } }
    });
  }

  // ── 열별 전송 설정 창 ──
  function renderAiCols() {
    const list = $('ac-list');
    list.replaceChildren();
    if (!state.source) { list.append(el('p', 'hint', '자료를 연결하면 열별로 설정할 수 있습니다.')); return; }
    state.keys.forEach((k) => {
      const inf = state.keyInfo.get(k) || {};
      const row = el('div', 'ac-row');
      const nm = el('span', 'ac-name');
      nm.append(el('b', null, labelOf(k)), el('small', null, TYPE_LABEL[inf.type] || ''));
      const seg = el('div', 'seg-theme ac-seg');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', labelOf(k) + ' 전송 방식');
      [['send', '전송'], ['alias', '가명'], ['drop', '제외']].forEach(([v, t]) => {
        const b = el('button', null, t);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.v = v;
        b.setAttribute('aria-checked', String(polOf(k) === v));
        b.addEventListener('click', () => { aiPol[k] = v; seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.v === v))); row.dataset.p = v; });
        seg.append(b);
      });
      row.dataset.p = polOf(k);
      row.append(nm, seg);
      list.append(row);
    });
  }
  function openAiCols() {
    renderAiCols();
    $('dlg-aicols').showModal();
  }
  function renderAiSendSum() {
    const box = $('ai-send-sum');
    box.replaceChildren();
    if (!state.source) { box.textContent = '자료 연결 후 설정'; $('ai-cols').disabled = true; return; }
    $('ai-cols').disabled = false;
    const s = sendSummary();
    [['send', '전송', s.send.length], ['alias', '가명', s.alias.length], ['drop', '제외', s.drop.length]].forEach(([c, t, n]) => {
      const i = el('span', 'ss ss-' + c);
      i.append(document.createTextNode(t + ' '), el('b', null, n));
      box.append(i);
    });
  }
  function renderAiSettings() {
    const seg = $('ai-prov');
    seg.replaceChildren();
    const ids = Object.keys(AI_PROVIDERS);
    ids.forEach((id) => {
      const b = el('button', null, AI_PROVIDERS[id].label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(aiCfg.provider === id));
      b.addEventListener('click', () => {
        if (aiCfg.provider === id) return;
        aiCfg = { provider: id, model: '' };
        dropKey();
        syncAiFab();
        saveAiCfg();
        renderAiSettings();
        msgTo('ai-set-msg', '');
      });
      seg.append(b);
    });
    $('ai-model').value = aiCfg.model;
    $('ai-model').placeholder = '예: ' + aiProv().model;
    $('ai-model-list').hidden = true;
    renderAiSendSum();
  }
  async function loadModelList() {
    pendingKey();
    const p = aiProv();
    if (!aiReady()) { msgTo('ai-set-msg', aiLocked() ? '[해제]를 눌러 인증 키 잠금을 먼저 해제하십시오.' : '인증 키를 먼저 입력하십시오.', 'error'); $('ai-key').focus(); return; }
    msgTo('ai-set-msg', '모델 목록을 불러오는 중입니다.');
    try {
      const j = await aiJson(await aiReq(p.list, null));
      let ids = [];
      if (Array.isArray(j.data)) ids = j.data.map((m) => m.id).filter((x) => typeof x === 'string');
      else if (Array.isArray(j.models)) ids = j.models.filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
      if (p.api === 'oai' && aiCfg.provider === 'openai') ids = ids.filter((x) => /^(gpt|o\d|chatgpt)/.test(x) && !/(audio|realtime|tts|transcribe|image|search|embedding|whisper|dall)/.test(x));
      if (aiCfg.provider === 'gemini') ids = ids.filter((x) => /^gemini/.test(x) && !/(embedding|image|tts|audio|live)/.test(x));
      ids = Array.from(new Set(ids)).sort().reverse().slice(0, 60);
      const box = $('ai-model-list');
      box.replaceChildren();
      ids.forEach((id) => {
        const b = el('button', 'chip', id);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(id === aiModel()));
        b.addEventListener('click', () => { aiCfg.model = id; saveAiCfg(); $('ai-model').value = id; box.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x.textContent === id))); });
        box.append(b);
      });
      box.hidden = !ids.length;
      msgTo('ai-set-msg', ids.length ? '모델 ' + ids.length + '개를 불러왔습니다. 사용할 모델을 선택하십시오.' : '사용할 수 있는 모델이 없습니다.', ids.length ? 'ok' : 'error');
    } catch (e) {
      msgTo('ai-set-msg', e instanceof TypeError ? '공급자에 연결하지 못하였습니다. 브라우저의 직접 요청이 허용되지 않을 수 있습니다.' : e.message, 'error');
    } finally { aiAbort = null; }
  }
  // 자료가 바뀌면 전송 설정·가명표·대화를 새로 준비
  function aiOnData() {
    loadAiPol();
    aiMsgs = [];
    aiConfirmed = '';
    renderAiSendSum();
    syncAiFab();
  }
  function initAI() {
    loadAiCfg();
    renderAiSettings();
    $('ai-model').addEventListener('change', () => { aiCfg.model = $('ai-model').value.trim().slice(0, 100); saveAiCfg(); });
    // 인증 키: 저장된 상태에서는 읽기 전용, [수정]을 눌러야 변경 → [저장](또는 Enter)으로 반영, Esc는 취소
    $('ai-key-btn').addEventListener('click', onKeyBtn);
    $('ai-key').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!$('ai-key').readOnly) commitKey(); }
      else if (e.key === 'Escape' && $('ai-key').dataset.editing === '1') { e.stopPropagation(); cancelEdit(); }
    });
    $('ai-key').addEventListener('input', () => { $('ai-key-btn').disabled = !$('ai-key').value.trim(); });
    $('ai-keep').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setKeep(b.dataset.v)));
    $('ai-key-del').addEventListener('click', gasDelKey);
    restoreKey();
    initGasRelay();
    $('ai-models').addEventListener('click', loadModelList);
    $('ai-cols').addEventListener('click', openAiCols);
    $('btn-ai').addEventListener('click', async () => {
      // 잠금 저장된 키는 단추를 누를 때 지문·얼굴·PIN으로 해제
      if (aiLocked() && !$('dlg-ai').open) {
        try { await unlockKey(); } catch (e) { openAi(true); aiErr(lockErr(e)); return; }
      }
      openAi(true);
    });
    $('ai-close').addEventListener('click', () => $('dlg-ai').close());
    $('dlg-ai').addEventListener('close', () => { if (aiAbort) aiAbort.abort(); if (aiPendingConfirm) aiPendingConfirm('cancel'); if (!$('dlg-ai').open && document.documentElement.classList.contains('ai-docked')) applyDock(false); });
    $('dlg-ai').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('dlg-ai').classList.contains('dock')) $('dlg-ai').close(); });
    initAiResize();
    $('ai-clear').addEventListener('click', aiReset);
    $('ai-send').addEventListener('click', () => aiSend($('ai-in').value));
    $('ai-in').addEventListener('input', autoGrow);
    $('ai-in').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); aiSend($('ai-in').value); } });
    $('ac-close').addEventListener('click', () => { loadAiPol(); $('dlg-aicols').close(); });
    $('ac-ok').addEventListener('click', () => {
      saveAiPol();
      $('dlg-aicols').close();
      renderAiSendSum();
      if ($('dlg-ai').open) aiGate();
    });
    $('ac-default').addEventListener('click', () => { state.keys.forEach((k) => { aiPol[k] = aiDefaultPol(k); }); renderAiCols(); });
    [['ac-all', 'send'], ['ac-alias', 'alias'], ['ac-drop', 'drop']].forEach(([id, v]) => $(id).addEventListener('click', () => { state.keys.forEach((k) => { aiPol[k] = v; }); renderAiCols(); }));
  }

  // ───────────── 이벤트 연결 ─────────────
  function init() {
    // 웹 앱 안에서 열린 경우의 화면 전환은 다른 초기화보다 먼저 (다른 부분에 문제가 있어도 적용되게)
    try { initEmbed(); } catch (e) { /* 무시 */ }
    const savedDomain = store.get('domain');
    if (savedDomain) { $('in-domain').value = savedDomain; $('chk-save-domain').checked = true; }
    updatePreview();

    $('in-domain').addEventListener('input', updatePreview);
    $('btn-fetch').addEventListener('click', () => onFetch(false));
    ['in-domain', 'in-code'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') onFetch(false); }));
    $('chk-save-domain').addEventListener('change', (e) => { if (!e.target.checked) store.del('domain'); });
    store.del('useServerLayout');

    $('fab').addEventListener('click', () => { if ($('pop').hidden) openPop(); else closePop(); });
    $('pop-close').addEventListener('click', closePop);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); closeExport(); closeCardMenu(); } });
    document.addEventListener('pointerdown', (e) => { if (cardMenu && !cardMenu.menu.contains(e.target) && !cardMenu.btn.contains(e.target)) closeCardMenu(); }, true);
    loadGlobalColors();
    ['(min-width: 944px)', '(min-width: 1408px)', '(min-width: 1872px)'].forEach((q) => {
      const mq = window.matchMedia(q);
      const f = () => { if (state.rows && state.rows.length && !$('view-board').hidden) renderBoard(); };
      try { mq.addEventListener('change', f); } catch (e) { mq.addListener(f); }
    });
    initTheme();
    $('clr-reset').addEventListener('click', () => { globalColors = {}; store.del('colors'); renderGlobalColors(); redrawForTheme(); });
    // 넓은 화면의 고정 상단: 스크롤했을 때만 아래 그라데이션 표시
    const hdr = document.querySelector('.app-header');
    const onScroll = () => hdr.classList.toggle('scrolled', window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    $('mv-cancel').addEventListener('click', () => $('dlg-move').close());
    $('btn-groups').addEventListener('click', () => { closePop(); closeExport(); renderGroupMgr(); $('dlg-groups').showModal(); });
    $('gm-close').addEventListener('click', () => $('dlg-groups').close());
    $('gm-new').addEventListener('click', () => createGroup(null));
    $('fab-add-item').addEventListener('click', () => { state.addGroup = null; $('dlg-kind').showModal(); });
    $('fab-add-group').addEventListener('click', () => createGroup(null));
    // 보드 제목: 이 기기에 자료별로 저장 (비우면 서버가 준 제목으로 돌아감)
    // 자료 정보(서버·행 수·기준 시각): 정보 단추를 눌렀을 때만 표시
    const toggleInfo = (e) => {
      e.stopPropagation();
      const s = $('board-sub');
      s.hidden = !s.hidden;
      $('btn-board-info').setAttribute('aria-expanded', String(!s.hidden));
    };
    $('btn-board-info').addEventListener('click', toggleInfo);

    document.addEventListener('pointerdown', (e) => {
      const s = $('board-sub');
      if (false && !s.hidden && !s.contains(e.target)) { s.hidden = true; $('btn-board-info').setAttribute('aria-expanded', 'false'); }
    });
    // 넓은 화면: 보드 제목을 상단 줄(두루보드 오른쪽)로 옮김
    const wideMq = window.matchMedia('(min-width: 944px)');
    // 보드 제목은 화면 너비와 관계없이 상단 줄(두루보드 오른쪽)에 둠
    const placeHead = () => {
      const bh = document.querySelector('.board-head');
      if (bh.parentNode !== document.querySelector('.app-header')) document.querySelector('.app-header .brand').after(bh);
      // 자료 정보는 상단 아래 줄(가운데 정렬)에 표시
      const sub = $('board-sub');
      if (sub.parentNode !== document.querySelector('.app-header')) document.querySelector('.app-header').append(sub);
    };
    try { wideMq.addEventListener('change', placeHead); } catch (e) { wideMq.addListener(placeHead); }
    placeHead();
    $('btn-board-title').addEventListener('click', async () => {
      if (!state.source) return;
      const cur = store.get('title:' + state.source.id) || state.meta.title || '';
      const v = await askName('보드 제목 수정', cur, { placeholder: state.meta.title || '보드 제목', label: '보드 제목', max: 60, allowEmpty: true });
      if (v === null) return;
      if (v && v !== state.meta.title) store.set('title:' + state.source.id, v); else store.del('title:' + state.source.id);
      renderBoardHead();
    });
    $('mv-new').addEventListener('click', async () => {
      const t = moveTarget;
      $('dlg-move').close();
      const g = await createGroup(null);
      if (g && t) { moveTarget = t; applyMove(g.id); }
    });
    $('btn-wipe').addEventListener('click', resetAll);
    $('btn-refresh').addEventListener('click', () => onFetch(true));
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest && (e.target.closest('dialog') || e.target.closest('.pop') || e.target.closest('.fabs') || e.target.closest('.cp-pop'))) return;
      closePop();
      closeExport();
    });

    $('btn-preview').addEventListener('click', openPreview);
    $('pv-close').addEventListener('click', () => $('dlg-preview').close());
    $('btn-refetch').addEventListener('click', () => onFetch(true));
    $('btn-disconnect').addEventListener('click', disconnect);
    $('fab-export').addEventListener('click', () => { if ($('pop-export').hidden) openExport(); else closeExport(); });
    $('ex-close').addEventListener('click', closeExport);
    $('ex-all').addEventListener('click', () => $('ex-list').querySelectorAll('input').forEach((c) => { c.checked = true; }));
    $('ex-none').addEventListener('click', () => $('ex-list').querySelectorAll('input').forEach((c) => { c.checked = false; }));
    $('ex-file').addEventListener('click', exportFile);
    $('im-pick').addEventListener('click', () => $('in-layout').click());
    $('in-layout').addEventListener('change', (e) => { readLayoutFile(e.target.files[0]); e.target.value = ''; });
    $('im-add').addEventListener('click', () => applyImport(false));
    $('im-replace').addEventListener('click', () => applyImport(true));
    $('btn-reset').addEventListener('click', async () => {
      closePop();
      if (!(await askConfirm('이 자료의 레이아웃을 모두 삭제합니다. 계속하시겠습니까?'))) return;
      state.layout = []; state.layoutFrom = 'local'; saveLayout(); renderBoard();
    });

    initBuilder();
    initAI();
    initAuto();

    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.source) renderBoard(); });
    } catch (e) { /* 구형 브라우저 */ }
  }

  init();
})();
