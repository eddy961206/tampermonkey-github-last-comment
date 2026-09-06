// ==UserScript==
// @name         GitHub 이슈 목록 - 마지막 댓글 작성자
// @namespace    https://github.com/
// @version      1.6.0
// @description  제목 아래 마지막 댓글 작성자와 날짜·요일을 작게 표시하고, 마우스/키보드로 댓글 본문을 미리 본다.
// @match        https://github.com/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/eddy961206/tampermonkey-github-last-comment/main/github-last-comment.user.js
// @downloadURL  https://raw.githubusercontent.com/eddy961206/tampermonkey-github-last-comment/main/github-last-comment.user.js
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '1.6.0';
  const CONFIG = Object.freeze({
    cacheMinutes: 2,
    noCommentCacheSeconds: 60,
    concurrency: 2,
    requestDelayMs: 350,       // 모든 요청에 적용하는 시작 간격
    requestTimeoutMs: 15_000, // 응답 본문을 받는 시간도 포함
    issueTimeoutMs: 120_000,
    pageSize: 50,
    maxTimelinePages: 40,     // 무한 조회 방지. 넘으면 추측 대신 오류 표시
    maxCacheEntries: 250,
    maxIssueJobs: 2,          // HTTP 대기가 아니라 실제 조회 시작부터 이슈 제한시간을 잰다
    staleMinutes: 15,        // 이전 결과는 반드시 이전 결과라고 표시한다
    prefetchMargin: 240,
    maintenanceMs: 30_000,
    previewChars: 16_000,
    maxPreviews: 80,
    showAvatar: true,
    showNoComments: true,
  });
  const QUERY_NAME = 'NewTimelinePaginationFrontQuery';
  // 사용자가 2026-07-30에 캡처한 값. 현재 서버에서 유효하다고 가정하지 않는다.
  // GitHub의 실제 Load more GET 요청을 관찰하면 새 해시만 학습한다.
  const FALLBACK_QUERY = 'c652a4589fe3db2aa2c32d0577666ec3';
  const PREFIX = 'gh-last-comment-author:v6:';
  const QUERY_KEY = `${PREFIX}pagination-query`;
  const MARKER = 'gh-last-comment-author';
  const OWN = 'data-gh-lca-owned';
  const STYLE_ID = 'gh-last-comment-author-style';
  const SINGLETON = '__ghLca16Running';
  if (document[SINGLETON]) return;
  document[SINGLETON] = true;

  const ERRORS = Object.freeze({
    ABORTED: '화면이 바뀌어서 이전 조회를 취소했어',
    TIMEOUT: '응답 시간이 초과됐어. 배지를 눌러 다시 시도해',
    ISSUE_TIMEOUT: '이 이슈의 조회 제한 시간을 넘었어. 배지를 눌러 다시 시도해',
    RATE_LIMIT: 'GitHub가 요청을 제한했어. 잠시 후 배지를 눌러 다시 시도해',
    AUTH: '로그인 상태 또는 이 이슈의 접근 권한을 확인해',
    HTTP: 'GitHub 응답이 정상이 아니야. 배지를 눌러 다시 시도해',
    NETWORK: '네트워크 요청에 실패했어. 배지를 눌러 다시 시도해',
    PAGE_SHAPE: '이 페이지의 댓글 구조를 확인하지 못했어. 진단 로그를 저장해줘',
    SUBJECT: '조회한 이슈와 응답 데이터가 일치하는지 확인하지 못했어',
    COMMENT_SHAPE: '일반 댓글의 작성 시각이나 주소를 확인하지 못했어',
    INCOMPLETE: '생략 구간을 전부 받았는지 확인하지 못했어',
    NO_PROGRESS: '다음 구간을 요청했지만 커서나 항목이 진행되지 않았어',
    PAGE_LIMIT: '이슈가 커서 추가 조회 횟수 제한에 도달했어',
    SNAPSHOT_CHANGED: '조회 중 타임라인 수가 달라졌어. 배지를 눌러 다시 시도해',
    QUERY: '추가 조회 요청이 거절됐어. 긴 이슈에서 Load more를 한 번 누른 뒤 목록을 새로고침해. 계속 실패하면 진단 로그를 저장해줘',
    JSON: '추가 조회 응답을 해석하지 못했어. 진단 로그를 저장해줘',
    TOO_LARGE: '응답이 안전한 처리 크기 제한을 넘었어',
  });
  class LcaError extends Error {
    constructor(code, status = 0) {
      super(ERRORS[code] || ERRORS.PAGE_SHAPE);
      this.name = 'LcaError'; this.code = code; this.status = status;
    }
  }
  const fail = (code, status) => new LcaError(code, status);
  const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const str = (...values) => values.find(v => typeof v === 'string' && v.trim())?.trim() || '';
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const abortCheck = signal => { if (signal?.aborted) throw fail('ABORTED'); };
  const keyOf = info => `${info.owner}/${info.repo}#${info.number}`.toLowerCase();
  const knownQuery = value => typeof value === 'string' && /^[a-f0-9]{32,64}$/i.test(value);
  const startedAt = Date.now();
  const events = [];
  const aliases = new Map();
  const stats = { requests: 0, cacheHits: 0, successes: 0, failures: 0, cancelled: 0, pages: 0,
    fullScans: 0, partialScans: 0, linksExamined: 0, renders: 0, memoryHits: 0,
    cachePrunes: 0, commentFastPaths: 0, avoidedPagination: 0, sharedJobs: 0 };
  let userPaused = false;
  const networkAllowed = () => !userPaused && document.visibilityState !== 'hidden' && navigator.onLine !== false && !!routeKind();

  // 로그에는 정해진 이벤트명·건수·HTTP 상태만 넣는다. URL이나 본문은 전달하지 않는다.
  function log(event, fields = {}) {
    events.push({ atMs: Date.now() - startedAt, event, ...fields });
    if (events.length > 200) events.shift();
  }
  function alias(info) {
    const key = keyOf(info);
    if (!aliases.has(key)) aliases.set(key, `item-${aliases.size + 1}`);
    return aliases.get(key);
  }
  function shapeOf(root) {
    // 로그인명, 본문, 필드의 실제 값 대신 구조의 키와 자료형만 기록한다.
    let remaining = 100;
    function visit(v, depth) {
      if (--remaining < 0 || depth > 5) return '…';
      if (v === null) return 'null';
      if (Array.isArray(v)) return v.length ? [visit(v[0], depth + 1)] : [];
      if (!obj(v)) return typeof v;
      const result = {};
      for (const [key, value] of Object.entries(v).slice(0, 18)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(key)) continue;
        result[key] = /body|title|description|login|name|email|url|token|cursor|path/i.test(key)
          ? typeof value : visit(value, depth + 1);
      }
      return result;
    }
    return visit(root, 0);
  }

  function storageGet(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
  function storageSet(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function storageDelete(key) { try { sessionStorage.removeItem(key); } catch {} }
  function currentLogin() {
    return str(document.querySelector('meta[name="user-login"]')?.content,
      document.querySelector('header img.avatar-user[alt^="@"]')?.alt).replace(/^@/, '');
  }
  // 표시 설정만 localStorage에 보관한다. 댓글 결과는 탭별 sessionStorage에만 둔다.
  const PREFS_KEY = 'gh-last-comment-author:ui:v1';
  const defaults = { compact: true, avatars: true, noComments: true, cacheMinutes: 2 };
  let prefs = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (obj(saved)) {
      for (const name of ['compact', 'avatars', 'noComments']) if (typeof saved[name] === 'boolean') prefs[name] = saved[name];
      if ([2, 5, 10].includes(saved.cacheMinutes)) prefs.cacheMinutes = saved.cacheMinutes;
    }
  } catch {}
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }
  const memoryCache = new Map();
  const staleTTL = CONFIG.staleMinutes * 60_000;
  let pruneTimer = null, lastPrune = 0;
  const cacheKey = (info, me) => `${PREFIX}cache:${encodeURIComponent(me.toLowerCase() || 'anonymous')}:${keyOf(info)}`;
  const ttlFor = result => result.kind === 'none' ? CONFIG.noCommentCacheSeconds * 1000 : prefs.cacheMinutes * 60_000;
  function validResult(v) {
    return obj(v) && (v.kind === 'none' || (v.kind === 'comment' &&
      typeof v.author === 'string' && typeof v.commentUrl === 'string' &&
      Number.isFinite(Date.parse(v.time)) && typeof v.mentionsMe === 'boolean'));
  }
  function remember(key, entry) {
    memoryCache.delete(key); memoryCache.set(key, entry);
    if (memoryCache.size > CONFIG.maxCacheEntries) memoryCache.delete(memoryCache.keys().next().value);
  }
  function getCache(info, signature, me, allowStale = false) {
    const key = cacheKey(info, me);
    let entry = memoryCache.get(key);
    if (entry) stats.memoryHits++;
    else entry = storageGet(key);
    if (!entry || entry.signature !== signature || !validResult(entry.value) || !Number.isFinite(entry.at)) return null;
    const age = Date.now() - entry.at;
    if (age < 0 || age >= (allowStale ? staleTTL : ttlFor(entry.value))) return null;
    if (entry.value.kind === 'comment') {
      const p = parseConversationUrl(entry.value.commentUrl);
      if (!p || !/^#issuecomment-\d+$/.test(new URL(entry.value.commentUrl).hash)) return null;
      entry.value.avatar = safeAvatar(entry.value.avatar);
    }
    remember(key, entry); return entry;
  }
  function deleteCache(info, me) {
    const key = cacheKey(info, me); memoryCache.delete(key); storageDelete(key);
  }
  function setCache(info, signature, me, result) {
    rememberPreview(info, me, result);
    const value = result.kind === 'none' ? { kind: 'none' } : {
      kind: 'comment', author: result.author, avatar: safeAvatar(result.avatar), time: result.time,
      commentUrl: result.commentUrl, isBot: !!result.isBot, mentionsMe: !!result.mentionsMe,
    };
    const entry = { at: Date.now(), signature, value };
    const key = cacheKey(info, me);
    remember(key, entry); storageSet(key, entry);
    schedulePrune(); return entry;
  }
  function schedulePrune() {
    if (pruneTimer !== null) return;
    pruneTimer = setTimeout(() => {
      pruneTimer = null;
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => pruneCache(), { timeout: 5000 });
      else pruneCache();
    }, Math.max(1500, 60_000 - (Date.now() - lastPrune)));
  }
  function pruneCache(clear = false) {
    lastPrune = Date.now(); stats.cachePrunes++;
    if (clear) memoryCache.clear();
    try {
      const entries = [];
      for (const key of Object.keys(sessionStorage)) {
        if (!key.startsWith(`${PREFIX}cache:`)) continue;
        const value = storageGet(key);
        if (clear || !value?.value || !Number.isFinite(value.at) || Date.now() - value.at >= staleTTL) {
          storageDelete(key); memoryCache.delete(key);
        } else entries.push([key, value.at]);
      }
      entries.sort((a, b) => b[1] - a[1]);
      for (const [key] of entries.slice(CONFIG.maxCacheEntries)) { storageDelete(key); memoryCache.delete(key); }
    } catch {}
  }
  function cleanOldCaches() {
    // v1.3의 본문 포함 캐시 및 v1.4 결과만 최초 실행 때 정리한다.
    try { for (const key of Object.keys(localStorage)) if (key.startsWith('gh-last-comment-author:v4:')) localStorage.removeItem(key); } catch {}
    try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('gh-last-comment-author:v5:cache:')) sessionStorage.removeItem(key); } catch {}
  }

  let queryHash = FALLBACK_QUERY;
  const learned = storageGet(QUERY_KEY);
  if (knownQuery(learned?.hash) && Date.now() - learned.at < 7 * 86400_000) queryHash = learned.hash;
  function learnQueryUrl(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || url.pathname !== '/_graphql') return;
      const body = JSON.parse(url.searchParams.get('body') || 'null');
      if (body?.persistedQueryName !== QUERY_NAME || !knownQuery(body.query)) return;
      // 캡처한 variables, 이슈 ID, cursor, 쿠키는 저장하지 않는다.
      if (queryHash !== body.query) log('query_hash_learned');
      queryHash = body.query;
      storageSet(QUERY_KEY, { hash: queryHash, at: Date.now() });
    } catch {}
  }
  // 자체 요청은 학습에서 제외해 오래된 해시로 새 해시를 덮어쓰지 않는다.
  const ownRequestUrls = new Set();
  function observeResource(entry) {
    if (entry?.name && !ownRequestUrls.has(entry.name)) learnQueryUrl(entry.name);
  }
  try {
    performance.getEntriesByType('resource').forEach(observeResource);
    new PerformanceObserver(list => list.getEntries().forEach(observeResource)).observe({ type: 'resource' });
  } catch {}

  const requestQueue = [];
  let activeRequests = 0, nextStart = 0, pausedUntil = 0, pumpTimer;
  function scheduleRequest(url, mode, signal) {
    abortCheck(signal);
    if (Date.now() < pausedUntil) return Promise.reject(fail('RATE_LIMIT'));
    return new Promise((resolve, reject) => {
      const entry = { url, mode, signal, resolve, reject, started: false };
      entry.cancel = () => {
        if (entry.started) return;
        const i = requestQueue.indexOf(entry);
        if (i >= 0) requestQueue.splice(i, 1);
        signal?.removeEventListener('abort', entry.cancel);
        reject(fail('ABORTED'));
      };
      signal?.addEventListener('abort', entry.cancel, { once: true });
      requestQueue.push(entry); pump();
    });
  }
  function pump() {
    clearTimeout(pumpTimer);
    if (!requestQueue.length || activeRequests >= CONFIG.concurrency || !networkAllowed()) return;
    if (Date.now() < pausedUntil) {
      for (const q of requestQueue.splice(0)) {
        q.signal?.removeEventListener('abort', q.cancel); q.reject(fail('RATE_LIMIT'));
      }
      return;
    }
    const delay = nextStart - Date.now();
    if (delay > 0) { pumpTimer = setTimeout(pump, delay); return; }
    const entry = requestQueue.shift();
    entry.signal?.removeEventListener('abort', entry.cancel);
    if (entry.signal?.aborted) { entry.reject(fail('ABORTED')); pump(); return; }
    entry.started = true; activeRequests++; nextStart = Date.now() + CONFIG.requestDelayMs;
    performRequest(entry.url, entry.mode, entry.signal).then(entry.resolve, entry.reject).finally(() => {
      activeRequests--; pump();
    });
    if (requestQueue.length) pumpTimer = setTimeout(pump, CONFIG.requestDelayMs);
  }
  async function performRequest(url, mode, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, CONFIG.requestTimeoutMs);
    stats.requests++;
    try {
      const response = await fetch(url, {
        credentials: 'same-origin', cache: 'no-cache', signal: controller.signal,
        headers: { Accept: mode === 'html' ? 'text/html' : 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > 12_000_000) throw fail('TOO_LARGE');
      const text = await response.text();
      if (text.length > 12_000_000) throw fail('TOO_LARGE');
      if (response.status === 429 || (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit|abuse detection/i.test(text)))) {
        const retry = response.headers.get('retry-after');
        const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry || '') - Date.now();
        pausedUntil = Date.now() + Math.max(60_000, Number.isFinite(delay) ? delay : 60_000);
        throw fail('RATE_LIMIT', response.status);
      }
      if (response.status === 401 || response.status === 403) throw fail('AUTH', response.status);
      if (!response.ok) throw fail(mode === 'json' && response.status === 422 ? 'QUERY' : 'HTTP', response.status);
      const finalUrl = new URL(response.url || url, location.origin);
      if (finalUrl.origin !== location.origin || /^\/(login|session|sessions|sso)(\/|$)/.test(finalUrl.pathname)) throw fail('AUTH');
      if (mode === 'html' && !parseConversationUrl(finalUrl.href)) throw fail('SUBJECT');
      log('http_ok', { mode, status: response.status });
      return { text, url: finalUrl.href };
    } catch (error) {
      if (signal?.aborted) throw fail('ABORTED');
      if (timedOut) throw fail('TIMEOUT');
      if (error instanceof LcaError) throw error;
      throw fail('NETWORK');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    }
  }

  function parseConversationUrl(href) {
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin || url.username || url.password) return null;
      const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/);
      if (!m) return null;
      const info = { owner: m[1], repo: m[2], type: m[3], number: m[4],
        url: `${url.origin}/${m[1]}/${m[2]}/${m[3]}/${m[4]}` };
      info.key = keyOf(info); return info;
    } catch { return null; }
  }
  function walkJson(root, visit) {
    const stack = [root], seen = new WeakSet();
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value); visit(value);
      const children = Array.isArray(value) ? value : Object.values(value);
      for (let i = children.length - 1; i >= 0; i--) if (children[i] && typeof children[i] === 'object') stack.push(children[i]);
    }
  }
  function embeddedRoots(doc) {
    const roots = [];
    for (const s of doc.querySelectorAll('script[type="application/json"]')) {
      try { roots.push(JSON.parse(s.textContent)); } catch {}
    }
    return roots;
  }
  function connections(subject) {
    const result = {};
    if (!obj(subject)) return result;
    for (const [key, value] of Object.entries(subject)) {
      if (/^(?:front|back)?timelineitems$/i.test(key) && obj(value) &&
          (Array.isArray(value.edges) || Array.isArray(value.nodes))) {
        result[/^front/i.test(key) ? 'front' : /^back/i.test(key) ? 'back' : 'timeline'] = value;
      }
    }
    return result;
  }
  function hasSubjectFields(v) {
    return Object.keys(connections(v)).length > 0 || (obj(v?.comments) &&
      (integer(v.comments.totalCount) !== null || Array.isArray(v.comments.edges) || Array.isArray(v.comments.nodes)));
  }
  function subjectMatches(value, info, expectedId = '') {
    if (!obj(value)) return false;
    const id = str(value.id, value.nodeId, value.node_id);
    if (expectedId && id && id !== expectedId) return false;
    if (value.number != null && String(value.number) !== info.number) return false;
    const repo = str(value.repository?.nameWithOwner);
    if (repo && repo.toLowerCase() !== `${info.owner}/${info.repo}`.toLowerCase()) return false;
    const raw = str(value.url, value.resourcePath, value.resource_path);
    if (raw) {
      const p = parseConversationUrl(raw);
      if (!p || keyOf(p) !== keyOf(info)) return false;
    }
    return true;
  }
  function findSubject(roots, info, expectedId = '') {
    const matches = [];
    for (const root of roots) walkJson(root, value => {
      if (!hasSubjectFields(value) || !subjectMatches(value, info, expectedId)) return;
      const id = str(value.id, value.nodeId, value.node_id);
      const url = parseConversationUrl(str(value.url, value.resourcePath, value.resource_path));
      const numberMatches = String(value.number ?? '') === info.number;
      if (!(expectedId && id === expectedId) && !url && !numberMatches) return;
      matches.push({ value, score: (expectedId && id === expectedId ? 100 : 0) + (url ? 20 : 0) +
        (numberMatches ? 8 : 0) + (connections(value).front ? 4 : 0) + (value.repository?.nameWithOwner ? 2 : 0) });
    });
    matches.sort((a, b) => b.score - a.score);
    if (!matches.length) return null;
    if (matches[1]?.score === matches[0].score && str(matches[1].value.id) !== str(matches[0].value.id)) throw fail('SUBJECT');
    return matches[0].value;
  }
  function edgesOf(conn) {
    if (Array.isArray(conn?.edges)) return conn.edges;
    if (Array.isArray(conn?.nodes)) return conn.nodes.map(node => ({ node }));
    return [];
  }
  function pageInfo(conn) {
    const p = conn?.pageInfo || conn?.page_info || {};
    return { next: p.hasNextPage ?? p.has_next_page, previous: p.hasPreviousPage ?? p.has_previous_page,
      end: str(p.endCursor, p.end_cursor, edgesOf(conn).at(-1)?.cursor) };
  }
  function edgeKey(edge) { return str(edge?.node?.id, edge?.node?.url, edge?.node?.resourcePath, edge?.cursor); }
  function commentCount(subject) {
    return integer(subject?.comments?.totalCount) ?? integer(subject?.comments?.total_count);
  }
  function safeAvatar(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    try {
      const u = new URL(raw, location.origin);
      if (u.protocol !== 'https:' || u.username || u.password ||
          !['github.com', 'avatars.githubusercontent.com'].includes(u.hostname)) return '';
      return u.href;
    } catch { return ''; }
  }
  function mentioned(value, me) {
    if (!me) return false;
    let text = str(value.bodyText, value.body_text, value.body, value.rawBody, value.raw_body);
    if (!text) {
      const html = str(value.bodyHTML, value.bodyHtml, value.body_html);
      if (html) {
        const template = document.createElement('template'); template.innerHTML = html;
        template.content.querySelectorAll('pre, code, blockquote').forEach(n => n.remove());
        text = template.content.textContent || '';
      }
    }
    const escaped = me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_-])`, 'i').test(text);
  }
  function commentFromNode(value, info, me) {
    if (!obj(value)) return null;
    const type = str(value.__typename, value.type);
    // 관련 이슈, 참조 이벤트, 리뷰 답글의 하위 객체는 탐색하지 않는다.
    if (type && type !== 'IssueComment' && type !== 'issue_comment') return null;
    const raw = str(value.url, value.permalink, value.htmlUrl, value.html_url, value.resourcePath, value.resource_path);
    let id = '', parsedUrl = null;
    if (raw) {
      try { parsedUrl = new URL(raw, location.origin); } catch { throw fail('COMMENT_SHAPE'); }
      const match = parsedUrl.hash.match(/^#issuecomment-(\d+)$/);
      if (match) {
        const p = parseConversationUrl(parsedUrl.href);
        if (!p || keyOf(p) !== keyOf(info)) {
          if (type === 'IssueComment' || type === 'issue_comment') throw fail('SUBJECT');
          return null;
        }
        id = match[1];
      } else if (parsedUrl.hostname === 'api.github.com') {
        const m = parsedUrl.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/);
        if (m && `${m[1]}/${m[2]}`.toLowerCase() === `${info.owner}/${info.repo}`.toLowerCase()) id = m[3];
      }
    }
    if (!type && !id) return null;
    if (!id && !raw) {
      const databaseId = value.fullDatabaseId ?? value.databaseId ?? value.database_id;
      if (/^\d+$/.test(String(databaseId ?? ''))) id = String(databaseId);
    }
    if (!id) throw fail('COMMENT_SHAPE');
    // updatedAt은 사용하지 않는다. 예전 댓글의 수정을 새 댓글로 오인하지 않는다.
    const time = str(value.createdAt, value.created_at);
    if (!Number.isFinite(Date.parse(time))) throw fail('COMMENT_SHAPE');
    const actor = obj(value.author) || obj(value.user) || {};
    const author = str(actor.login, actor.username, value.authorLogin, value.author_login).replace(/^@/, '');
    const avatar = CONFIG.showAvatar ? safeAvatar(str(actor.avatarUrl, actor.avatar_url,
      author ? `https://github.com/${encodeURIComponent(author)}.png?size=32` : '')) : '';
    return { kind: 'comment', commentId: id, author, avatar, time,
      commentUrl: `${info.url}#issuecomment-${id}`, isBot: str(actor.__typename, actor.type).toLowerCase() === 'bot' || /\[bot\]$/i.test(author),
      mentionsMe: false, _mentionSource: value, _mentionLogin: me };
  }
  function newest(comments) {
    let latest = null, latestTime = -Infinity;
    for (const item of comments.values()) {
      const stamp = Date.parse(item.time);
      if (!latest || stamp > latestTime || (stamp === latestTime && BigInt(item.commentId) > BigInt(latest.commentId))) {
        latest = item; latestTime = stamp;
      }
    }
    if (!latest) return { kind: 'none' };
    const { commentId, _mentionSource, _mentionLogin, ...result } = latest;
    result.mentionsMe = _mentionSource ? mentioned(_mentionSource, _mentionLogin) : !!result.mentionsMe;
    result.preview = previewText(_mentionSource);
    return result;
  }
  // 본문은 페이지 메모리에만 보관한다. sessionStorage/localStorage/진단 로그에는 쓰지 않는다.
  const previewCache = new Map();
  const previewKey = (info, me, url) => `${me.toLowerCase()}|${info.key}|${url}`;
  function previewText(source) {
    if (!obj(source)) return { available: false, text: '', truncated: false };
    let text, available = false;
    for (const key of ['bodyText', 'body_text', 'body', 'rawBody', 'raw_body']) {
      if (typeof source[key] === 'string') { text = source[key]; available = true; break; }
    }
    if (!available) {
      const html = ['bodyHTML', 'bodyHtml', 'body_html'].find(k => typeof source[k] === 'string');
      if (html) {
        const template = document.createElement('template'); template.innerHTML = source[html];
        template.content.querySelectorAll('script,style,iframe,object,embed').forEach(n => n.remove());
        template.content.querySelectorAll('img').forEach(n => n.replaceWith(document.createTextNode(n.alt ? `[${n.alt}]` : '[이미지]')));
        template.content.querySelectorAll('br').forEach(n => n.replaceWith(document.createTextNode('\n')));
        template.content.querySelectorAll('p,div,li,pre,blockquote,h1,h2,h3,h4,h5,h6,tr').forEach(n => n.append(document.createTextNode('\n')));
        text = template.content.textContent || ''; available = true;
      }
    }
    text = (text || '').replace(/\r\n?/g, '\n').trim();
    return { available, text: text.slice(0, CONFIG.previewChars), truncated: text.length > CONFIG.previewChars };
  }
  function rememberPreview(info, me, result) {
    if (result.kind !== 'comment' || !result.preview) return;
    const key = previewKey(info, me, result.commentUrl);
    previewCache.delete(key);
    previewCache.set(key, { ...result.preview, at: Date.now() });
    while (previewCache.size > CONFIG.maxPreviews) previewCache.delete(previewCache.keys().next().value);
  }
  function getPreview(record) {
    if (record.value?.kind !== 'comment') return null;
    const key = previewKey(record.info, context.me, record.value.commentUrl), entry = previewCache.get(key);
    if (!entry || Date.now() - entry.at >= staleTTL) { previewCache.delete(key); return null; }
    previewCache.delete(key); previewCache.set(key, entry); return entry;
  }

  function addComments(edges, info, me, into) {
    for (const edge of edges) {
      const candidate = commentFromNode(edge?.node, info, me);
      if (candidate) into.set(candidate.commentId, candidate);
    }
  }
  function collectLegacyDom(doc, info, me, expected) {
    if (expected === null) throw fail('PAGE_SHAPE');
    const found = new Map();
    for (const node of doc.querySelectorAll('[id^="issuecomment-"]')) {
      if (!/^issuecomment-\d+$/.test(node.id) || node.closest('.markdown-body, .comment-body, blockquote')) continue;
      const container = node.matches('.timeline-comment, .js-comment-container') ? node :
        node.closest('.timeline-comment, .js-comment-container') || node;
      const header = container.querySelector('.timeline-comment-header, [data-testid="comment-header"]');
      if (!header) continue;
      const authorNode = header.querySelector('a.author, a[data-hovercard-type="user"], a[data-hovercard-type="bot"]');
      const author = authorNode?.textContent.trim().replace(/^@/, '') || '';
      const permalink = [...header.querySelectorAll('a[href]')].find(a => a.getAttribute('href')?.endsWith(`#${node.id}`));
      const datetime = (permalink || header).querySelector('relative-time[datetime], time[datetime]')?.getAttribute('datetime');
      const candidate = commentFromNode({ __typename: 'IssueComment', url: `${info.url}#${node.id}`, createdAt: datetime,
        author: { login: author }, bodyText: container.querySelector('.comment-body')?.textContent || '' }, info, me);
      if (candidate) found.set(candidate.commentId, candidate);
    }
    if (found.size !== expected) throw fail('INCOMPLETE');
    return newest(found);
  }
  function findPageConnection(json, info, id) {
    const bound = findSubject([json], info, id);
    if (bound) {
      const c = connections(bound); return c.front || c.timeline || null;
    }
    // ID가 없는 응답은 요청 대상에 직접 대응하는 data.node 등의 위치만 허용한다.
    const direct = [json?.data?.node, json?.data?.issue, json?.data?.repository?.issue,
      json?.data?.repository?.pullRequest, json?.data?.repository?.issueOrPullRequest];
    for (const item of direct) {
      if (!subjectMatches(item, info, id)) continue;
      const c = connections(item); if (c.front || c.timeline) return c.front || c.timeline;
    }
    return null;
  }
  async function fetchTimelinePage(id, cursor, count, signal) {
    const body = { persistedQueryName: QUERY_NAME, query: queryHash, variables: { count, cursor, id, skip: null } };
    const url = `${location.origin}/_graphql?body=${encodeURIComponent(JSON.stringify(body))}`;
    ownRequestUrls.add(url);
    if (ownRequestUrls.size > 500) ownRequestUrls.delete(ownRequestUrls.values().next().value);
    const response = await scheduleRequest(url, 'json', signal);
    let json;
    try { json = JSON.parse(response.text); } catch { throw fail('JSON'); }
    if (Array.isArray(json?.errors) && json.errors.length) {
      // 서버 오류 문자열에는 사용자 정보가 섞일 수 있으므로 저장하지 않는다.
      log('graphql_rejected', { errors: json.errors.length }); throw fail('QUERY');
    }
    if (!obj(json?.data)) { log('unexpected_json', { shape: shapeOf(json) }); throw fail('JSON'); }
    return json;
  }

  async function parseLastComment(html, info, me, signal, fetchPage = fetchTimelinePage) {
    abortCheck(signal);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const roots = embeddedRoots(doc);
    const subject = findSubject(roots, info);
    if (!subject) {
      log('subject_not_found', { jsonScripts: roots.length, shape: shapeOf(roots.slice(0, 2)) });
      throw fail('PAGE_SHAPE');
    }
    const expectedComments = commentCount(subject);
    const conns = connections(subject);
    const front = conns.front || conns.timeline;
    const back = conns.back;
    if (!front) {
      // 댓글 전용 connection을 전부 받았을 때만 이용한다.
      const c = subject.comments, edges = edgesOf(c), pi = pageInfo(c);
      if ((expectedComments !== null && edges.length === expectedComments) ||
          (edges.length > 0 && pi.next === false && pi.previous === false)) {
        const comments = new Map(); addComments(edges, info, me, comments);
        if (comments.size !== edges.length) throw fail('COMMENT_SHAPE');
        return newest(comments);
      }
      return collectLegacyDom(doc, info, me, expectedComments);
    }

    const comments = new Map(), loaded = new Set();
    const frontEdges = edgesOf(front), backEdges = edgesOf(back);
    const backKeys = new Set(backEdges.map(edgeKey).filter(Boolean));
    const frontKeys = new Set(frontEdges.map(edgeKey).filter(Boolean));
    const backIsTail = Boolean(back && pageInfo(back).next === false);
    let joinedTail = backIsTail && [...frontKeys].some(key => backKeys.has(key));
    const totals = [front, back].filter(Boolean).map(c => integer(c.totalCount) ?? integer(c.total_count)).filter(n => n !== null);
    if (new Set(totals).size > 1) throw fail('SNAPSHOT_CHANGED');
    let total = totals[0] ?? null;
    function add(edges) {
      for (const edge of edges) { const key = edgeKey(edge); if (key) loaded.add(key); }
      addComments(edges, info, me, comments);
    }
    add(frontEdges); add(backEdges);
    if (total !== null && loaded.size > total) throw fail('SNAPSHOT_CHANGED');
    if (expectedComments !== null && comments.size > expectedComments) throw fail('INCOMPLETE');
    // 전체 일반 댓글 수와 이미 검증한 고유 댓글 수가 같으면 빠진 것은 이벤트뿐이다.
    // 뒤쪽에 댓글이 보인다는 추측만으로는 이 경로를 사용하지 않는다.
    if (expectedComments !== null && comments.size === expectedComments) {
      stats.commentFastPaths++;
      if (pageInfo(front).next !== false && !(total !== null && loaded.size === total)) stats.avoidedPagination++;
      log('comments_complete', { item: alias(info), comments: comments.size });
      return newest(comments);
    }
    let pi = pageInfo(front);
    if (pi.previous === true && !(total !== null && loaded.size === total)) throw fail('INCOMPLETE');
    let cursor = pi.end, pages = 0;
    const cursors = new Set(cursor ? [cursor] : []);
    const id = str(subject.id, subject.nodeId, subject.node_id);
    const isComplete = () => pi.next === false || joinedTail || (total !== null && loaded.size === total);
    while (!isComplete()) {
      abortCheck(signal);
      if (total !== null && loaded.size > total) throw fail('SNAPSHOT_CHANGED');
      if (!id || !cursor) throw fail('INCOMPLETE');
      if (pages >= CONFIG.maxTimelinePages) throw fail('PAGE_LIMIT');
      const missing = total === null ? CONFIG.pageSize : Math.max(1, total - loaded.size);
      const count = Math.min(CONFIG.pageSize, missing);
      const json = await fetchPage(id, cursor, count, signal);
      abortCheck(signal);
      // 주입된 테스트 fetchPage도 실제 함수와 같은 부분 오류 금지 규칙을 적용한다.
      if (Array.isArray(json?.errors) && json.errors.length) throw fail('QUERY');
      const next = findPageConnection(json, info, id);
      if (!next) { log('pagination_shape', { shape: shapeOf(json) }); throw fail('INCOMPLETE'); }
      const newTotal = integer(next.totalCount) ?? integer(next.total_count);
      if (newTotal !== null && total !== null && newTotal !== total) throw fail('SNAPSHOT_CHANGED');
      if (total === null && newTotal !== null) total = newTotal;
      const edges = edgesOf(next), previousSize = loaded.size;
      if (backIsTail && edges.some(e => backKeys.has(edgeKey(e)))) joinedTail = true;
      add(edges); pages++; stats.pages++;
      if (total !== null && loaded.size > total) throw fail('SNAPSHOT_CHANGED');
      if (expectedComments !== null && comments.size > expectedComments) throw fail('INCOMPLETE');
      if (expectedComments !== null && comments.size === expectedComments) {
        stats.commentFastPaths++;
        log('comments_complete', { item: alias(info), pages, comments: comments.size });
        return newest(comments);
      }
      const nextPi = pageInfo(next);
      if (total !== null && loaded.size > total) throw fail('SNAPSHOT_CHANGED');
      const complete = nextPi.next === false || joinedTail || (total !== null && loaded.size === total);
      if (!complete && (!nextPi.end || cursors.has(nextPi.end) || loaded.size === previousSize || !edges.length)) throw fail('NO_PROGRESS');
      if (nextPi.next === false && total !== null && loaded.size !== total) throw fail('INCOMPLETE');
      pi = nextPi; cursor = nextPi.end;
      if (cursor) cursors.add(cursor);
    }
    if (total !== null && loaded.size !== total) throw fail('INCOMPLETE');
    if (expectedComments !== null && comments.size !== expectedComments) throw fail('INCOMPLETE');
    log('timeline_complete', { item: alias(info), pages, items: loaded.size, comments: comments.size });
    return newest(comments);
  }
  async function fetchLastComment(info, me, parentSignal) {
    const controller = new AbortController(); let timedOut = false;
    const onAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, CONFIG.issueTimeoutMs);
    try {
      const response = await scheduleRequest(info.url, 'html', controller.signal);
      const canonical = parseConversationUrl(response.url);
      if (!canonical) throw fail('SUBJECT');
      return await parseLastComment(response.text, canonical, me, controller.signal);
    } catch (error) {
      if (timedOut && !parentSignal?.aborted) throw fail('ISSUE_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer); parentSignal?.removeEventListener('abort', onAbort);
    }
  }

  function routeKind() {
    const path = location.pathname.replace(/\/$/, '') || '/';
    if (/^\/[^/]+\/[^/]+\/issues$/.test(path) || /^\/issues(?:\/(assigned|mentioned|created|recent))?$/.test(path)) return 'issues';
    if (/^\/[^/]+\/[^/]+\/pulls$/.test(path) || /^\/pulls(?:\/(assigned|mentioned|review-requested))?$/.test(path)) return 'pulls';
    if (path === '/search' && !['code', 'commits', 'repositories', 'users', 'discussions'].includes(new URLSearchParams(location.search).get('type'))) return 'search';
    return '';
  }
  const ROW_SELECTOR = '[data-testid="issue-row"], [data-testid="pull-request-row"], [data-testid="list-row"], [data-testid="list-view-item"], [data-listview-item-id], .js-issue-row, .Box-row, [role="row"], [role="listitem"], li';
  const LINK_SELECTOR = 'a[href*="/issues/"], a[href*="/pull/"]';
  const EXCLUDED = `[${OWN}], .markdown-body, .comment-body, header, nav, [role="dialog"], [role="tooltip"]`;
  function mainRoot() { return document.querySelector('main, [role="main"], #repo-content-pjax-container') || document.body; }
  function findTitleLinks(root = mainRoot()) {
    if (!routeKind() || !root?.querySelectorAll) return [];
    const rows = new Map(), links = [...root.querySelectorAll(LINK_SELECTOR)];
    if (root.matches?.(LINK_SELECTOR)) links.unshift(root);
    stats.linksExamined += links.length;
    for (const link of links) {
      if (link.closest(EXCLUDED)) continue;
      const info = parseConversationUrl(link.href), text = link.textContent.trim();
      if (!info || !text || /^#?\d+$/.test(text) || new URL(link.href).hash) continue;
      const row = link.closest(ROW_SELECTOR) || link.parentElement;
      if (!row) continue;
      if (!rows.has(row)) rows.set(row, new Map());
      const candidates = rows.get(row);
      const score = Math.min(text.length, 120) + (link.matches('[data-testid*="title"], .js-navigation-open, .Link--primary') ? 1000 : 0);
      if (!candidates.has(info.key) || score > candidates.get(info.key).score) candidates.set(info.key, { link, row, info, score });
    }
    return [...rows.values()].flatMap(map => [...map.values()]);
  }
  function rowSignature(row) {
    const times = [...row.querySelectorAll('relative-time[datetime], time[datetime]')]
      .filter(n => !n.closest(`[${OWN}]`)).map(n => n.getAttribute('datetime'));
    const counts = [...row.querySelectorAll('[data-testid="comments-count"], a:has(.octicon-comment), span:has(> .octicon-comment)')]
      .filter(n => !n.closest(`[${OWN}]`)).map(n => n.textContent.trim().slice(0, 32));
    return JSON.stringify([times, counts]);
  }
  const icons = {
    comment: '<path d="M3 2.75h10a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 11.25H6l-3.25 2.5v-2.56A1.25 1.25 0 0 1 1.75 10V4A1.25 1.25 0 0 1 3 2.75Z"/>',
    refresh: '<path d="M13 5.5A5.25 5.25 0 1 0 13.2 10M13 2.5v3.4H9.6"/>',
    pause: '<path d="M5.5 3v10M10.5 3v10"/>',
    play: '<path d="m5.5 3 7 5-7 5Z"/>',
    settings: '<path d="M2 4h12M2 8h12M2 12h12"/><path d="M5 2.5v3M11 6.5v3M6.5 10.5v3"/>',
  };
  function icon(name) {
    const template = document.createElement('template');
    // icons에는 코드에 고정한 SVG만 들어가며 서버/사용자 문자열은 넣지 않는다.
    template.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.comment}</svg>`;
    return template.content.firstElementChild;
  }
  function textNode(tag, className, text = '') {
    const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
  }
  function addStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) { style = document.createElement('style'); style.id = STYLE_ID; document.head.append(style); }
    style.setAttribute(OWN, '');
    style.textContent = `
      .gh-lca-line,.${MARKER},.gh-lca-preview,.gh-lca-bar{--lca-bg:var(--bgColor-default,var(--color-canvas-default,#fff));--lca-muted-bg:var(--bgColor-muted,var(--color-canvas-subtle,#f6f8fa));--lca-border:var(--borderColor-default,var(--color-border-default,#d1d9e0));--lca-fg:var(--fgColor-default,var(--color-fg-default,#1f2328));--lca-muted:var(--fgColor-muted,var(--color-fg-muted,#59636e));--lca-accent:var(--fgColor-accent,var(--color-accent-fg,#0969da));box-sizing:border-box;font:400 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--lca-fg)}
      .gh-lca-line *,.gh-lca-preview *,.gh-lca-bar *{box-sizing:border-box}
      .gh-lca-line{display:flex;align-items:center;gap:5px;flex:0 0 calc(100% - 2em);grid-column:1/-1;clear:both;min-width:0;max-width:calc(100% - 2em);margin:2px 0 2px 2em;line-height:24px;white-space:nowrap;text-align:left}
      .gh-lca-wrap-title{flex-wrap:wrap!important}
      .gh-lca-line-label{flex:none;color:var(--lca-muted);font-weight:400}
      .${MARKER}{display:inline-flex;vertical-align:middle;align-items:center;gap:4px;flex:0 1 auto;width:max-content;max-width:100%;min-width:0;min-height:26px;margin:0;padding:1px 2px 1px 6px;border:1px solid var(--lca-border);border-radius:5px;background:var(--lca-bg);white-space:nowrap;text-align:left}
      .gh-lca-line[hidden],.${MARKER}[hidden],.gh-lca-preview[hidden],.gh-lca-line [hidden],.gh-lca-bar [hidden]{display:none!important}
      .${MARKER} .gh-lca-main{display:inline-flex;align-items:center;flex:0 1 auto;gap:4px;min-width:0;color:inherit;text-decoration:none!important;font:inherit;outline-offset:2px}
      .${MARKER} .gh-lca-author{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:600}
      .${MARKER} .gh-lca-time{margin-left:0;color:var(--lca-muted);font-size:11px;flex:none;font-variant-numeric:tabular-nums}
      .${MARKER} .gh-lca-prefix{color:var(--lca-muted);flex:none;font-size:11px}
      .${MARKER} img,.${MARKER} .gh-lca-avatar{width:16px;height:16px;flex:none;border-radius:50%;object-fit:cover}
      .${MARKER} .gh-lca-avatar{display:grid;place-items:center;background:var(--lca-muted-bg);color:var(--lca-muted);font-size:10px;font-weight:600}
      .${MARKER} .gh-lca-flag{font-size:10px;line-height:17px;padding:0 4px;border-radius:3px;background:var(--lca-muted-bg);color:var(--lca-muted);flex:none}
      .${MARKER} .gh-lca-flag:empty{display:none}
      .${MARKER}[data-kind="other"]{color:var(--lca-accent)}
      .${MARKER}[data-kind="mine"],.${MARKER}[data-kind="bot"],.${MARKER}[data-kind="none"],.${MARKER}[data-kind="loading"]{color:var(--lca-muted)}
      .${MARKER}[data-kind="mention"]{border-color:var(--borderColor-attention-emphasis,var(--color-attention-emphasis,#9a6700));background:var(--bgColor-attention-muted,var(--color-attention-subtle,#fff8c5));color:var(--fgColor-attention,var(--color-attention-fg,#7d4e00))}
      .${MARKER}[data-kind="mention"] .gh-lca-flag{background:var(--lca-bg);color:inherit}
      .${MARKER}[data-kind="error"]{color:var(--fgColor-danger,var(--color-danger-fg,#d1242f))}
      .${MARKER}[data-stale="true"]{border-style:dashed}
      .${MARKER}[data-stale="true"] .gh-lca-flag{color:var(--fgColor-attention,var(--color-attention-fg,#7d4e00))}
      .${MARKER} .gh-lca-action,.gh-lca-bar button,.gh-lca-bar summary{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;border:1px solid transparent;border-radius:5px;padding:3px 7px;background:transparent;color:var(--lca-muted);font:inherit;cursor:pointer;text-decoration:none;white-space:nowrap}
      .${MARKER} .gh-lca-action{flex:none;width:22px;min-height:22px;padding:2px;color:var(--lca-muted)}
      .${MARKER} .gh-lca-action:hover,.gh-lca-bar button:hover,.gh-lca-bar summary:hover{background:var(--lca-muted-bg);color:var(--lca-fg)}
      .${MARKER} a:focus-visible,.${MARKER} button:focus-visible,.gh-lca-bar :is(button,summary,select,input):focus-visible{outline:2px solid var(--lca-accent);outline-offset:2px}
      .${MARKER} button:disabled,.gh-lca-bar button:disabled{cursor:default;opacity:.55}
      .${MARKER}[data-busy="true"] .gh-lca-reload svg{animation:gh-lca-turn 1.3s linear infinite}
      @keyframes gh-lca-turn{to{transform:rotate(360deg)}}
      .gh-lca-bar{display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:6px 12px;width:max-content;max-width:100%;position:relative;margin:0 0 12px;padding:8px 12px;border:1px solid var(--lca-border);border-radius:6px;background:var(--lca-bg);isolation:isolate}
      .gh-lca-bar .gh-lca-left,.gh-lca-bar .gh-lca-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
      .gh-lca-bar .gh-lca-heading{display:flex;align-items:center;gap:6px;font-weight:600;color:var(--lca-fg);white-space:nowrap}
      .gh-lca-bar .gh-lca-status{color:var(--lca-muted);font-size:11px}
      .gh-lca-bar button[aria-pressed="true"]{border-color:var(--lca-border);background:var(--lca-muted-bg);color:var(--lca-fg)}
      .gh-lca-bar details{position:relative}
      .gh-lca-bar summary{list-style:none}
      .gh-lca-bar summary::-webkit-details-marker{display:none}
      .gh-lca-bar .gh-lca-settings{position:absolute;right:0;top:calc(100% + 8px);z-index:30;width:260px;max-width:calc(100vw - 32px);padding:14px;border:1px solid var(--lca-border);border-radius:8px;background:var(--lca-bg);box-shadow:0 8px 24px #0002;color:var(--lca-fg);white-space:normal}
      .gh-lca-bar .gh-lca-settings label{display:flex;align-items:center;gap:8px;margin:0 0 12px;cursor:pointer}
      .gh-lca-bar .gh-lca-settings input{accent-color:var(--lca-accent);margin:0}
      .gh-lca-bar .gh-lca-settings select{margin-left:auto;background:var(--lca-bg);color:var(--lca-fg);border:1px solid var(--lca-border);border-radius:4px;padding:3px 5px;font:inherit}
      .gh-lca-bar .gh-lca-help{color:var(--lca-muted);font-size:11px;line-height:1.7;border-top:1px solid var(--lca-border);padding-top:10px;margin-top:3px}
      @media(max-width:700px){.gh-lca-line{gap:4px}.${MARKER} .gh-lca-action{width:24px;min-height:26px}.${MARKER} .gh-lca-flag{max-width:48px;overflow:hidden;text-overflow:ellipsis}.gh-lca-bar{padding:8px;gap:7px}.gh-lca-bar .gh-lca-tools{margin-left:auto;gap:3px}.gh-lca-bar .gh-lca-left{flex-basis:100%}.gh-lca-bar button,.gh-lca-bar summary{min-height:32px}.gh-lca-bar .gh-lca-settings{position:fixed;top:auto;right:16px;max-height:65vh;overflow:auto}}
      .gh-lca-preview{position:fixed;z-index:10000;display:flex;flex-direction:column;width:520px;max-width:calc(100vw - 24px);max-height:min(440px,calc(100dvh - 24px));padding:0;border:1px solid var(--lca-border);border-radius:8px;background:var(--lca-bg);color:var(--lca-fg);box-shadow:0 8px 28px #0003;overflow:hidden;line-height:1.6}
      .gh-lca-preview-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--lca-border);flex:none}
      .gh-lca-preview-heading{font-weight:600;min-width:0;overflow-wrap:anywhere}
      .gh-lca-preview-close{margin-left:auto;flex:none;background:transparent;border:0;color:var(--lca-muted);cursor:pointer;font:inherit;font-size:20px;width:28px;height:28px;padding:0;border-radius:4px}
      .gh-lca-preview-body{margin:0;padding:12px;overflow:auto;overscroll-behavior:contain;min-height:0;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;font:400 13px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .gh-lca-preview-foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:8px 12px;border-top:1px solid var(--lca-border);flex:none;font-size:11px;color:var(--lca-muted)}
      .gh-lca-preview a{color:var(--lca-accent);white-space:nowrap}
      .gh-lca-preview :is(button,a,[tabindex]):focus-visible{outline:2px solid var(--lca-accent);outline-offset:-2px}
      .gh-lca-preview-close:hover{background:var(--lca-muted-bg)}
      @media(prefers-reduced-motion:reduce){.${MARKER} *{animation:none!important;transition:none!important}}
      @media(forced-colors:active){.gh-lca-line,.${MARKER},.gh-lca-preview,.gh-lca-bar{border:1px solid CanvasText}.${MARKER} .gh-lca-flag{outline:1px solid CanvasText}}
    `;
  }
  const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  function calendarDate(value, exact = false) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const p = Object.fromEntries(dateFormatter.formatToParts(date).map(v => [v.type, v.value]));
    return `${exact ? p.year + '.' : ''}${p.month}.${p.day} (${p.weekday})${exact ? ' ' + p.hour + ':' + p.minute + ' KST' : ''}`;
  }
  function markerKind(result, me) {
    if (result.kind === 'none') return 'none';
    if (me && result.author.toLowerCase() === me.toLowerCase()) return 'mine';
    if (result.mentionsMe) return 'mention';
    return result.isBot ? 'bot' : 'other';
  }
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function paint(record) {
    const m = record.marker, result = record.value;
    const busy = record.state === 'loading', waiting = record.state === 'queued';
    const stale = !!result && (Date.now() >= record.freshUntil || !!record.error || record.forced);
    const kind = result ? markerKind(result, context.me) : record.error ? 'error' : 'loading';
    m.dataset.kind = kind; m.dataset.stale = String(stale); m.dataset.busy = String(busy);
    m.dataset.detail = String(!prefs.compact);
    record.line.hidden = m.hidden = result?.kind === 'none' && !prefs.noComments && !stale;
    m.setAttribute('aria-busy', String(busy));
    const contentKey = JSON.stringify([result, kind, prefs.avatars, prefs.compact]);
    if (record.contentKey !== contentKey) {
      record.contentKey = contentKey; stats.renders++;
      const primary = document.createElement(result?.kind === 'comment' ? 'a' : 'span');
      primary.className = 'gh-lca-main';
      if (result?.kind === 'comment') {
        primary.href = result.commentUrl;
        primary.addEventListener('click', e => e.stopPropagation());
        if (prefs.avatars) {
          const fallback = textNode('span', 'gh-lca-avatar', (result.author[0] || '?').toUpperCase()); fallback.setAttribute('aria-hidden', 'true');
          const avatar = safeAvatar(result.avatar);
          if (avatar) {
            const image = document.createElement('img'); image.src = avatar; image.alt = ''; image.width = 16; image.height = 16;
            image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', () => image.replaceWith(fallback), { once: true }); primary.append(image);
          } else primary.append(fallback);
        }
        primary.append(textNode('span', 'gh-lca-author', result.author ? `@${result.author}` : '작성자 정보 없음'));
        record.timeEl = textNode('span', 'gh-lca-time', calendarDate(result.time)); primary.append(record.timeEl);
      } else {
        record.timeEl = null; primary.append(icon('comment'));
        primary.append(textNode('span', 'gh-lca-label', ''));
      }
      record.primary.replaceWith(primary); record.primary = primary;
    }
    if (result?.kind === 'comment') {
      if (record.timeEl) setText(record.timeEl, calendarDate(result.time));
      const meaning = kind === 'mine' ? '내가 쓴 댓글' : kind === 'mention' ? '본문에 내 아이디가 있어. 실제 알림 전송 여부는 확인하지 않아' : kind === 'bot' ? '봇이 쓴 댓글' : '다른 사람이 쓴 댓글';
      const title = `${stale ? '이전 조회 결과야. 최신 댓글은 아직 확인하지 못했어.\n' : ''}${meaning}\n작성자: ${result.author ? '@' + result.author : '작성자 정보 없음'}\n작성: ${calendarDate(result.time, true)}\n확인: ${calendarDate(record.at, true)}\n클릭하면 이 일반 댓글로 이동해${record.error ? `\n${record.error.message}` : ''}`;
      record.primary.removeAttribute('title'); record.primary.setAttribute('aria-label', title.replace(/\n/g, '. ') + '. 마우스 또는 키보드 포커스로 본문 미리보기');
    } else {
      const label = result?.kind === 'none' ? '댓글 없음' : record.error ? (record.error.code === 'RATE_LIMIT' ? '잠시 조회 제한' : '조회 실패') : busy ? '댓글 확인 중…' : userPaused ? '조회 일시정지' : navigator.onLine === false ? '오프라인' : '댓글 확인 대기';
      setText(record.primary.querySelector('.gh-lca-label'), label);
      record.primary.title = record.error ? `${record.error.message}\n오른쪽 재시도 버튼을 눌러줘` : result?.kind === 'none' ? `${stale ? '이전 확인 결과야.\n' : ''}일반 댓글이 0개인 것을 확인했어. 본문·이벤트·코드줄 리뷰 댓글은 제외해` : '화면에 보이는 이슈부터 확인해';
    }
    setText(record.flag, stale ? '이전 결과' : kind === 'mine' ? '내 댓글' : kind === 'mention' ? '언급' : kind === 'bot' ? '봇' : '');
    const limited = Date.now() < pausedUntil;
    record.action.disabled = busy || waiting || userPaused || limited || navigator.onLine === false;
    const actionLabel = busy ? '댓글 확인 중' : waiting ? '조회 순서를 기다리는 중' : limited ? 'GitHub 조회 제한이 끝나면 다시 시도해' : record.error ? '마지막 댓글 다시 조회' : '이 이슈의 마지막 댓글 새로 조회';
    record.action.title = actionLabel; record.action.setAttribute('aria-label', actionLabel);
    record.previewButton.hidden = result?.kind !== 'comment';
    if (record.timeEl) record.timeEl.title = calendarDate(result.time, true);
    if (record.primary.tagName === 'A') {
      record.primary.setAttribute('aria-controls', PREVIEW_ID);
      record.primary.setAttribute('aria-expanded', String(preview.record === record));
    }
    if (preview.record === record) updatePreview(record);
    updateToolbarSoon();
  }

  const layoutHosts = new WeakMap();
  function releaseLayout(record) {
    const host = record.layoutHost, users = host && layoutHosts.get(host);
    if (users) { users.delete(record); if (!users.size) { host.classList.remove('gh-lca-wrap-title'); layoutHosts.delete(host); } }
    record.layoutHost = null;
  }
  function mountLine(record) {
    releaseLayout(record);
    const link = record.link;
    let anchor = link.closest('h1,h2,h3,h4,h5,h6,[role="heading"],[data-testid="list-view-item-title-container"],[data-testid="issue-title-container"]') || link;
    if (!record.row.contains(anchor)) anchor = link;
    // Inline title wrappers cannot force a line break in an outer flex row. Place after that wrapper instead.
    while (anchor.parentElement && anchor.parentElement !== record.row && getComputedStyle(anchor.parentElement).display === 'inline') anchor = anchor.parentElement;
    // Keep label chips beside the title; never move GitHub/React's own nodes.
    while (anchor.nextElementSibling?.matches('.Label,[data-testid="issue-label"],[data-testid="label"]')) anchor = anchor.nextElementSibling;
    const host = anchor.parentElement;
    if (host && ['flex', 'inline-flex'].includes(getComputedStyle(host).display) && !getComputedStyle(host).flexDirection.startsWith('column')) {
      let users = layoutHosts.get(host); if (!users) layoutHosts.set(host, users = new Set());
      users.add(record); host.classList.add('gh-lca-wrap-title'); record.layoutHost = host;
    }
    record.titleAnchor = anchor;
    anchor.insertAdjacentElement('afterend', record.line);
    if (record.marker.parentElement !== record.line) record.line.append(record.marker);
  }

  const PREVIEW_ID = 'gh-lca-comment-preview';
  const preview = { panel: null, record: null, openTimer: null, closeTimer: null, positionFrame: null, requested: false, dismissed: null, suppressHover: false, pointer: null, hovered: null };
  function ensurePreview() {
    if (preview.panel?.isConnected) return preview.panel;
    const panel = textNode('section', 'gh-lca-preview'); panel.id = PREVIEW_ID; panel.hidden = true; panel.setAttribute(OWN, '');
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '마지막 댓글 본문 미리보기');
    const head = textNode('div', 'gh-lca-preview-head'), heading = textNode('span', 'gh-lca-preview-heading');
    const close = textNode('button', 'gh-lca-preview-close', '×'); close.type = 'button'; close.setAttribute('aria-label', '댓글 미리보기 닫기');
    close.addEventListener('click', () => closePreview(true)); head.append(heading, close);
    const body = textNode('div', 'gh-lca-preview-body'); body.tabIndex = 0; body.setAttribute('aria-label', '댓글 본문, 긴 댓글은 스크롤');
    const foot = textNode('div', 'gh-lca-preview-foot'), note = textNode('span', 'gh-lca-preview-note');
    const open = textNode('a', 'gh-lca-preview-open', '댓글 열기 ↗'); open.target = '_blank'; open.rel = 'noopener noreferrer';
    foot.append(note, open); panel.append(head, body, foot);
    panel.addEventListener('pointerenter', () => clearTimeout(preview.closeTimer));
    panel.addEventListener('pointerleave', () => schedulePreviewClose());
    panel.addEventListener('focusin', () => clearTimeout(preview.closeTimer));
    panel.addEventListener('focusout', () => schedulePreviewClose());
    // Do not leak popup clicks to GitHub's row navigation.
    panel.addEventListener('click', event => event.stopPropagation());
    document.body.append(panel); preview.panel = panel; return panel;
  }
  function schedulePreviewClose() {
    clearTimeout(preview.openTimer); clearTimeout(preview.closeTimer);
    preview.closeTimer = setTimeout(() => {
      const record = preview.record, panel = preview.panel;
      if (panel?.matches(':hover') || panel?.contains(document.activeElement) || record?.marker.matches(':hover') || record?.marker.contains(document.activeElement)) return;
      closePreview();
    }, 230);
  }
  function closePreview(dismiss = false) {
    clearTimeout(preview.openTimer); clearTimeout(preview.closeTimer);
    if (preview.positionFrame !== null) cancelAnimationFrame(preview.positionFrame);
    preview.positionFrame = null;
    const record = preview.record, hadFocus = preview.panel?.contains(document.activeElement);
    preview.record = null; preview.requested = false;
    if (dismiss) { preview.dismissed = record; preview.suppressHover = true; }
    if (preview.panel) { preview.panel.hidden = true; preview.panel.querySelector('.gh-lca-preview-body').textContent = ''; }
    if (record) {
      record.primary.setAttribute('aria-expanded', 'false'); record.previewButton.setAttribute('aria-expanded', 'false');
      if (dismiss && hadFocus && record.previewButton.isConnected) record.previewButton.focus({ preventScroll: true });
    }
  }
  function openPreview(record, explicit = false) {
    clearTimeout(preview.openTimer); clearTimeout(preview.closeTimer);
    if (record.value?.kind !== 'comment' || !record.line.isConnected || context.identity !== identity()) return;
    if (explicit) { preview.dismissed = null; preview.suppressHover = false; }
    if (preview.dismissed === record) return;
    if (preview.record !== record) { closePreview(); preview.record = record; preview.requested = false; }
    const panel = ensurePreview(); panel.hidden = false;
    record.primary.setAttribute('aria-expanded', 'true'); record.previewButton.setAttribute('aria-expanded', 'true');
    updatePreview(record);
    // A sessionStorage cache hit has author/date but no body. Reuse the normal bounded issue queue once.
    if (!getPreview(record) && !preview.requested && !record.error && networkAllowed()) {
      preview.requested = true; enqueue(record, true);
    }
  }
  function positionPreview() {
    preview.positionFrame = null;
    const panel = preview.panel, record = preview.record;
    if (!panel || panel.hidden || !record?.line.isConnected) return;
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    panel.style.width = `${Math.min(520, width - 24)}px`;
    panel.style.maxHeight = `${Math.min(440, height - 24)}px`;
    const anchor = record.marker.getBoundingClientRect(), rect = panel.getBoundingClientRect();
    const left = Math.max(leftEdge + 12, Math.min(anchor.left, leftEdge + width - rect.width - 12));
    const below = anchor.bottom + 6, above = anchor.top - rect.height - 6;
    const top = below + rect.height <= topEdge + height - 12 ? below : above >= topEdge + 12 ? above : Math.max(topEdge + 12, topEdge + height - rect.height - 12);
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
  }
  function positionPreviewSoon() {
    if (preview.positionFrame === null) preview.positionFrame = requestAnimationFrame(positionPreview);
  }
  function updatePreview(record) {
    const panel = preview.panel;
    if (preview.record !== record || !panel || panel.hidden) return;
    if (record.value?.kind !== 'comment') { closePreview(); return; }
    const entry = getPreview(record), value = record.value;
    setText(panel.querySelector('.gh-lca-preview-heading'), `${value.author ? '@' + value.author : '작성자 정보 없음'} · ${calendarDate(value.time, true)}`);
    const busy = record.state === 'loading' || record.state === 'queued';
    const stale = Date.now() >= record.freshUntil || !!record.error || record.forced;
    let body, note;
    if (entry) {
      body = entry.available ? entry.text || '텍스트 본문이 비어 있어.' : '이 응답에는 댓글 본문이 없어서 미리 볼 수 없어. 아래에서 댓글을 열어줘.';
      note = `${stale ? '이전 조회 결과 · ' : ''}${entry.truncated ? '앞 16,000자만 표시 · ' : ''}텍스트 미리보기`;
      if (record.error) note += ' · 새 조회 실패';
    } else {
      body = record.error ? `${record.error.message}\n배지의 새로고침 버튼으로 다시 시도해.` : !networkAllowed() ? '조회가 멈춰 있어. 조회를 재개하거나 네트워크 연결을 확인해.' : '댓글 본문을 불러오는 중…';
      note = '본문은 이 페이지의 메모리에만 보관해';
    }
    const bodyNode = panel.querySelector('.gh-lca-preview-body');
    setText(bodyNode, body); bodyNode.setAttribute('aria-busy', String(busy && !entry));
    setText(panel.querySelector('.gh-lca-preview-note'), note);
    panel.querySelector('.gh-lca-preview-open').href = value.commentUrl;
    positionPreviewSoon();
  }
  function bindPreview(record) {
    record.marker.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch') return;
      preview.hovered = record;
      if (preview.suppressHover) return;
      clearTimeout(preview.closeTimer); clearTimeout(preview.openTimer);
      if (preview.dismissed === record) return;
      preview.openTimer = setTimeout(() => openPreview(record), 180);
    });
    record.marker.addEventListener('pointerleave', () => { if (preview.hovered === record) preview.hovered = null; if (preview.dismissed === record) preview.dismissed = null; schedulePreviewClose(); });
    record.marker.addEventListener('focusin', event => { if (event.target !== record.action) openPreview(record); });
    record.marker.addEventListener('focusout', () => { if (preview.dismissed === record) preview.dismissed = null; schedulePreviewClose(); });
    record.marker.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' && record.value?.kind === 'comment') {
        event.preventDefault(); event.stopPropagation(); openPreview(record, true); preview.panel?.querySelector('.gh-lca-preview-body').focus();
      }
    });
    record.previewButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openPreview(record, true); });
  }
  document.addEventListener('pointermove', event => {
    const old = preview.pointer; preview.pointer = { x: event.clientX, y: event.clientY };
    if (preview.suppressHover && old && (old.x !== event.clientX || old.y !== event.clientY)) {
      preview.suppressHover = false;
      const hovered = preview.hovered;
      if (hovered?.marker.matches(':hover')) {
        clearTimeout(preview.openTimer); preview.openTimer = setTimeout(() => openPreview(hovered), 180);
      }
    }
  }, { passive: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && preview.record) { closePreview(true); event.stopPropagation(); } }, true);
  document.addEventListener('pointerdown', event => {
    if (preview.record && !preview.panel?.contains(event.target) && !preview.record.marker.contains(event.target)) closePreview(true);
  }, true);
  document.addEventListener('scroll', event => {
    if (preview.record && !preview.panel?.contains(event.target)) {
      const rect = preview.record.marker.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) closePreview();
      else positionPreviewSoon();
    }
  }, true);
  window.addEventListener('resize', () => { if (preview.record) positionPreviewSoon(); });
  window.visualViewport?.addEventListener('resize', () => { if (preview.record) positionPreviewSoon(); });

  let context = { identity: '', me: '', controller: new AbortController() };
  const records = new Map(), recordQueue = new Set(), jobs = new Map();
  let rowRecords = new WeakMap();
  let toolbar = null, toolbarTimer = null, scanTimer = null, maintenanceTimer = null;
  let dirtyRoots = new Set(), fullScanWanted = false, cleanupWanted = false, firstScheduled = 0;
  const identity = () => `${location.pathname}${location.search}|${currentLogin().toLowerCase()}`;
  function activeRecords() { return [...records.values()].filter(r => r.link.isConnected); }
  function makeRecord(item, signature) {
    const line = textNode('span', 'gh-lca-line'); line.setAttribute(OWN, '');
    const marker = textNode('span', MARKER); marker.setAttribute(OWN, '');
    line.append(textNode('span', 'gh-lca-line-label', '마지막 댓글 :'), marker);
    const primary = textNode('span', 'gh-lca-main'), flag = textNode('span', 'gh-lca-flag');
    const action = document.createElement('button'); action.type = 'button'; action.className = 'gh-lca-action gh-lca-reload'; action.append(icon('refresh'));
    const previewButton = document.createElement('button'); previewButton.type = 'button'; previewButton.className = 'gh-lca-action gh-lca-peek';
    previewButton.append(icon('comment')); previewButton.setAttribute('aria-label', '마지막 댓글 본문 미리보기');
    previewButton.setAttribute('aria-controls', PREVIEW_ID); previewButton.setAttribute('aria-expanded', 'false');
    marker.append(primary, flag, previewButton, action);
    const record = { ...item, line, marker, primary, flag, action, previewButton, signature, version: 1, state: 'new',
      freshUntil: 0, lastAttempt: 0, near: !nearObserver, inView: !viewObserver, value: null, at: 0, error: null, forced: false, job: null };
    action.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); enqueue(record, true); });
    records.set(item.link, record);
    let set = rowRecords.get(item.row); if (!set) rowRecords.set(item.row, set = new Set()); set.add(record);
    mountLine(record); bindPreview(record);
    // DOM에 추가한 직후 동기 레이아웃 계산을 하지 않는다. 가시성 판정은 Observer에 맡긴다.
    nearObserver?.observe(item.link); viewObserver?.observe(item.link);
    const cached = getCache(item.info, signature, context.me, true);
    if (cached) { stats.cacheHits++; applyEntry(record, cached); } else paint(record);
    return record;
  }
  function removeRecord(record) {
    record.version++; recordQueue.delete(record);
    record.job?.subscribers.delete(record);
    if (record.job && !record.job.subscribers.size) record.job.controller.abort();
    nearObserver?.unobserve(record.link); viewObserver?.unobserve(record.link);
    if (preview.record === record) closePreview();
    releaseLayout(record); record.line.remove(); records.delete(record.link); rowRecords.get(record.row)?.delete(record);
  }
  function applyEntry(record, entry) {
    record.value = entry.value; record.at = entry.at; record.freshUntil = entry.at + ttlFor(entry.value);
    record.state = 'done'; record.error = null; record.forced = false; paint(record);
  }
  function cancelJobs() {
    recordQueue.clear();
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
    for (const r of records.values()) {
      r.job = null;
      if (r.state === 'loading' || r.state === 'queued') { r.state = r.value ? 'done' : 'new'; r.forced = false; paint(r); }
    }
    clearTimeout(pumpTimer);
  }
  function resetContext(clearCache = false) {
    closePreview(); previewCache.clear();
    context.controller.abort(); cancelJobs();
    for (const record of [...records.values()]) removeRecord(record);
    rowRecords = new WeakMap(); dirtyRoots.clear();
    toolbar?.remove(); toolbar = null;
    context = { identity: identity(), me: currentLogin(), controller: new AbortController() };
    if (clearCache) pruneCache(true);
    clearTimeout(maintenanceTimer);
    log('context_reset', { route: routeKind() || 'other', manual: clearCache });
  }
  function stillCurrent(record, ctx, version) {
    return ctx === context && ctx.identity === identity() && !ctx.controller.signal.aborted && record.version === version &&
      record.link.isConnected && parseConversationUrl(record.link.href)?.key === record.info.key &&
      rowSignature(record.row) === record.signature;
  }
  function enqueue(record, force = false) {
    if (!record.link.isConnected || (!record.near && !force)) return;
    if (record.job || record.state === 'loading') return;
    if (!force && record.state === 'done' && !record.forced && Date.now() < record.freshUntil) return;
    if (!force && !record.forced) {
      const cached = getCache(record.info, record.signature, context.me);
      if (cached) { stats.cacheHits++; applyEntry(record, cached); return; }
    }
    if (!networkAllowed()) { paint(record); return; }
    if (Date.now() < pausedUntil) { record.error = fail('RATE_LIMIT'); record.state = 'error'; paint(record); return; }
    if (!force && record.state === 'error' && Date.now() - record.lastAttempt < 30_000) return;
    record.forced ||= force; record.error = null; record.state = 'queued'; recordQueue.add(record); paint(record);
    // 한 이벤트에서 나온 여러 행을 먼저 모아서 실제 뷰포트 우선순위를 매긴다.
    queueMicrotask(pumpJobs);
  }
  function pumpJobs() {
    if (!networkAllowed() || Date.now() < pausedUntil || context.identity !== identity()) return;
    for (const record of [...recordQueue]) {
      if (!record.link.isConnected || (!record.near && !record.forced)) {
        recordQueue.delete(record); record.state = record.value ? 'done' : 'new'; paint(record); continue;
      }
      const key = `${record.info.key}|${record.signature}`, existing = jobs.get(key);
      if (existing) attach(existing, record);
    }
    while (jobs.size < CONFIG.maxIssueJobs && recordQueue.size) {
      const sorted = [...recordQueue].sort((a, b) => Number(b.forced) - Number(a.forced) || Number(b.inView) - Number(a.inView));
      const record = sorted[0];
      if (!record) break;
      const key = `${record.info.key}|${record.signature}`;
      const controller = new AbortController(), ctx = context;
      const job = { key, controller, ctx, subscribers: new Map(), info: record.info, signature: record.signature };
      const onAbort = () => controller.abort(); ctx.controller.signal.addEventListener('abort', onAbort, { once: true });
      jobs.set(key, job); attach(job, record);
      for (const other of [...recordQueue]) if (`${other.info.key}|${other.signature}` === key) attach(job, other);
      void runJob(job).finally(() => {
        ctx.controller.signal.removeEventListener('abort', onAbort);
        if (jobs.get(key) === job) jobs.delete(key);
        pumpJobs(); updateToolbarSoon();
      });
    }
  }
  function attach(job, record) {
    if (job.subscribers.size) stats.sharedJobs++;
    recordQueue.delete(record); job.subscribers.set(record, record.version);
    record.job = job; record.state = 'loading'; record.lastAttempt = Date.now(); paint(record);
  }
  async function runJob(job) {
    try {
      // 대기 중인 행에는 아직 fetchLastComment와 120초 타이머를 만들지 않는다.
      const result = await fetchLastComment(job.info, job.ctx.me, job.controller.signal);
      if (job.controller.signal.aborted) return;
      const current = [...job.subscribers].filter(([r, v]) => r.job === job && stillCurrent(r, job.ctx, v));
      if (!current.length) return;
      const entry = setCache(job.info, job.signature, job.ctx.me, result);
      for (const [record] of current) { record.job = null; applyEntry(record, entry); stats.successes++; }
    } catch (error) {
      if (error?.code === 'ABORTED' || job.controller.signal.aborted) { stats.cancelled++; return; }
      const safe = error instanceof LcaError ? error : fail('PAGE_SHAPE');
      for (const [record, version] of job.subscribers) {
        if (record.job !== job || !stillCurrent(record, job.ctx, version)) continue;
        record.job = null; record.state = 'error'; record.error = safe; record.forced = false;
        stats.failures++; paint(record);
      }
      log('item_error', { item: alias(job.info), code: safe.code, status: safe.status });
    } finally {
      // 외부 확장이나 React가 행을 바꿨다면 다음 증분 스캔이 새 정보를 처리한다.
      for (const [record] of job.subscribers) if (record.job === job) {
        record.job = null; record.state = record.value ? 'done' : 'new';
        if (record.link.isConnected && job.ctx === context) scheduleScan(record.row);
      }
    }
  }
  const nearObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target); if (!record) continue;
      record.near = entry.isIntersecting;
      record.inView = entry.isIntersecting && entry.boundingClientRect.top < innerHeight && entry.boundingClientRect.bottom > 0;
      if (record.near) enqueue(record);
      else if (recordQueue.delete(record)) { record.state = record.value ? 'done' : 'new'; record.forced = false; paint(record); }
    }
    updateToolbarSoon();
  }, { rootMargin: `${CONFIG.prefetchMargin}px 0px` }) : null;
  const viewObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target); if (!record) continue;
      record.inView = entry.isIntersecting;
      if (record.inView) { record.near = true; enqueue(record); }
    }
    queueMicrotask(pumpJobs);
  }) : null;

  function ensureToolbar() {
    const first = records.values().next().value;
    if (!first) { toolbar?.remove(); toolbar = null; return; }
    if (toolbar?.isConnected) return;
    toolbar = textNode('div', 'gh-lca-bar'); toolbar.setAttribute(OWN, ''); toolbar.setAttribute('role', 'region'); toolbar.setAttribute('aria-label', '마지막 댓글 표시 도구');
    const left = textNode('div', 'gh-lca-left'), heading = textNode('span', 'gh-lca-heading');
    heading.append(icon('comment'), document.createTextNode('마지막 댓글'));
    const status = textNode('span', 'gh-lca-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    left.append(heading, status);
    const tools = textNode('div', 'gh-lca-tools');
    const refreshButton = document.createElement('button'); refreshButton.type = 'button'; refreshButton.dataset.action = 'refresh';
    refreshButton.append(icon('refresh'), document.createTextNode('보이는 항목 갱신'));
    refreshButton.title = '지금 화면에 보이는 이슈만 새로 확인해. 페이지 전체를 다시 읽지 않아';
    refreshButton.addEventListener('click', () => refreshVisible());
    const pauseButton = document.createElement('button'); pauseButton.type = 'button'; pauseButton.dataset.action = 'pause';
    pauseButton.addEventListener('click', () => setPaused(!userPaused));
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.append(icon('settings'), document.createTextNode('표시')); summary.setAttribute('aria-label', '마지막 댓글 표시 설정');
    const panel = textNode('div', 'gh-lca-settings');
    for (const [key, text] of [['avatars', '작성자 아바타 표시'], ['noComments', '댓글 없음도 표시']]) {
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = prefs[key]; input.dataset.pref = key;
      input.addEventListener('change', () => { prefs[key] = input.checked; savePrefs(); for (const r of records.values()) paint(r); });
      label.append(input, document.createTextNode(text)); panel.append(label);
    }
    const ttlLabel = textNode('label', '', '결과 재사용 시간'), select = document.createElement('select'); select.setAttribute('aria-label', '결과 재사용 시간');
    for (const minutes of [2, 5, 10]) { const option = document.createElement('option'); option.value = String(minutes); option.textContent = `${minutes}분`; select.append(option); }
    select.value = String(prefs.cacheMinutes);
    select.addEventListener('change', () => {
      const value = Number(select.value); if (![2, 5, 10].includes(value)) return;
      prefs.cacheMinutes = value; savePrefs();
      for (const r of records.values()) { if (r.value) r.freshUntil = r.at + ttlFor(r.value); paint(r); if (r.near) enqueue(r); }
    });
    ttlLabel.append(select); panel.append(ttlLabel);
    const help = textNode('div', 'gh-lca-help', '파랑: 다른 사람 · 회색: 내 댓글/봇\n노랑: 본문에 내 아이디 언급\n점선 + 이전 결과: 최신 여부 확인 중\n일반 댓글만 표시해. 답변 필요 여부를 판단하는 표시는 아니야.'); help.style.whiteSpace = 'pre-line'; panel.append(help);
    const diagnostic = document.createElement('button'); diagnostic.type = 'button'; diagnostic.textContent = '진단 로그 저장'; diagnostic.addEventListener('click', downloadDiagnostics); panel.append(diagnostic);
    details.append(summary, panel); tools.append(refreshButton, pauseButton, details); toolbar.append(left, tools);
    const list = first.row.closest('ul, ol, table, [role="list"], [role="grid"], .js-navigation-container, [data-testid="list-view-items"]') || first.row.parentElement;
    const main = mainRoot();
    if (list && list !== main && main.contains(list)) list.insertAdjacentElement('beforebegin', toolbar);
    else main.prepend(toolbar);
    updateToolbar();
  }
  function updateToolbarSoon() {
    if (toolbarTimer !== null) return;
    toolbarTimer = setTimeout(() => { toolbarTimer = null; updateToolbar(); }, 160);
  }
  function updateToolbar() {
    if (!toolbar?.isConnected) return;
    const all = activeRecords(), done = all.filter(r => !!r.value).length;
    const previous = all.filter(r => !!r.value && (Date.now() >= r.freshUntil || r.error || r.forced)).length;
    const errors = all.filter(r => r.error).length, busy = jobs.size + recordQueue.size;
    const rateSeconds = Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000));
    const status = navigator.onLine === false ? '오프라인 · 결과 유지' : userPaused ? '조회 일시정지' : rateSeconds ? `조회 제한 · 약 ${Math.ceil(rateSeconds / 60)}분 후` :
      `${done}/${all.length} 확인${previous ? ` · 이전 결과 ${previous}` : ''}${errors ? ` · 실패 ${errors}` : busy ? ' · 확인 중' : all.some(r => !r.value && !r.near) ? ' · 화면 밖 대기' : ''}`;
    setText(toolbar.querySelector('.gh-lca-status'), status);
    const pause = toolbar.querySelector('[data-action="pause"]');
    const pressed = String(userPaused);
    if (pause.getAttribute('aria-pressed') !== pressed) {
      pause.setAttribute('aria-pressed', pressed); pause.replaceChildren(icon(userPaused ? 'play' : 'pause'), document.createTextNode(userPaused ? '조회 재개' : '일시정지'));
    }
    toolbar.querySelector('[data-action="refresh"]').disabled = !networkAllowed() || rateSeconds > 0;
  }
  function refreshVisible() {
    if (!networkAllowed()) return;
    for (const record of records.values()) if (record.inView && !record.job) enqueue(record, true);
  }
  function setPaused(value) {
    userPaused = !!value;
    if (userPaused) cancelJobs();
    else { for (const r of records.values()) if (r.near) enqueue(r); pump(); }
    for (const r of records.values()) paint(r);
    updateToolbar(); startMaintenance();
  }

  function scheduleScan(root = null) {
    if (!root || !root.querySelectorAll) fullScanWanted = true;
    else dirtyRoots.add(root);
    if (document.visibilityState === 'hidden') return;
    const now = Date.now(); if (!firstScheduled) firstScheduled = now;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, now - firstScheduled >= 350 ? 0 : 60);
  }
  function scan() {
    clearTimeout(scanTimer); scanTimer = null; firstScheduled = 0;
    if (context.identity !== identity()) { resetContext(); fullScanWanted = true; }
    if (!routeKind() || document.visibilityState === 'hidden') return;
    const full = fullScanWanted; fullScanWanted = false;
    let roots = full ? [mainRoot()] : [...dirtyRoots].filter(r => r.isConnected); dirtyRoots.clear();
    roots = roots.filter((r, i) => !roots.some((other, j) => i !== j && other.contains(r)));
    const items = roots.flatMap(findTitleLinks);
    stats[full ? 'fullScans' : 'partialScans']++;
    const found = new Set(items.map(i => i.link));
    if (full || cleanupWanted) {
      cleanupWanted = false;
      for (const r of [...records.values()]) if (!r.link.isConnected || (full && !found.has(r.link))) removeRecord(r);
    }
    for (const root of roots) {
      const set = rowRecords.get(root);
      if (set) for (const r of [...set]) if (!found.has(r.link) && root.contains(r.link)) removeRecord(r);
    }
    for (const item of items) {
      let record = records.get(item.link); const signature = rowSignature(item.row);
      if (record && (record.info.key !== item.info.key || record.signature !== signature || record.row !== item.row)) {
        removeRecord(record); record = null;
      }
      if (!record) record = makeRecord(item, signature);
      else if (!record.line.isConnected || !record.marker.isConnected || record.line.previousElementSibling !== record.titleAnchor) mountLine(record);
      if (record.near) enqueue(record);
    }
    ensureToolbar(); startMaintenance();
  }
  function mutationsChanged(mutations) {
    if (context.identity !== identity()) { fullScanWanted = true; scheduleScan(); return; }
    if (!routeKind()) return;
    let changed = false;
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (!target) continue;
      if (target.closest?.(`[${OWN}]`)) {
        if (target.classList.contains('gh-lca-line') && [...(mutation.removedNodes || [])].some(n => n.nodeType === 1 && n.classList.contains(MARKER))) {
          const row = target.closest(ROW_SELECTOR); if (row) scheduleScan(row);
        }
        continue;
      }
      if (mutation.type === 'attributes' && target.matches('meta[name="user-login"]')) { scheduleScan(); return; }
      const candidates = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
      // 자기 UI 추가·변경은 무시하되 외부에서 지운 배지는 복구한다.
      if (mutation.type === 'childList' && !mutation.removedNodes.length && candidates.length && candidates.every(n => n.nodeType === 1 && n.hasAttribute(OWN))) continue;
      const row = target.closest?.(ROW_SELECTOR) || (rowRecords.has(target) ? target : null);
      if (row && (rowRecords.has(row) || row.querySelector?.(LINK_SELECTOR))) { dirtyRoots.add(row); changed = true; }
      for (const node of candidates) {
        if (node.nodeType !== 1) continue;
        if (node.hasAttribute(OWN)) {
          if (!node.isConnected && (node === toolbar || node.classList.contains(MARKER) || node.classList.contains('gh-lca-line'))) {
            if (row) dirtyRoots.add(row); else ensureToolbar(); changed = true;
          }
          continue;
        }
        if (node.matches(LINK_SELECTOR) || node.querySelector(LINK_SELECTOR)) {
          if (node.isConnected) dirtyRoots.add(node.closest(ROW_SELECTOR) || node);
          else cleanupWanted = true;
          changed = true;
        }
      }
      if (mutation.type === 'attributes' && target.matches(LINK_SELECTOR)) { dirtyRoots.add(row || target.parentElement); changed = true; }
    }
    if (changed) {
      // 이 경로는 이미 변경된 하위 트리를 알고 있으므로 전체 탐색 플래그를 세우지 않는다.
      const now = Date.now(); if (!firstScheduled) firstScheduled = now;
      clearTimeout(scanTimer); if (document.visibilityState !== 'hidden') scanTimer = setTimeout(scan, now - firstScheduled >= 350 ? 0 : 60);
    }
  }
  function startMaintenance() {
    clearTimeout(maintenanceTimer);
    if (!routeKind() || document.visibilityState === 'hidden' || !records.size) return;
    maintenanceTimer = setTimeout(maintain, CONFIG.maintenanceMs);
  }
  function maintain() {
    maintenanceTimer = null;
    if (document.visibilityState === 'hidden' || !routeKind()) return;
    for (const record of records.values()) {
      if (!record.near || !record.link.isConnected) continue;
      if (record.value) paint(record); // 시간 문자열과 상태만 갱신. 작성자 링크는 재생성하지 않는다.
      enqueue(record);
    }
    updateToolbar(); startMaintenance();
  }
  function navigationChanged() {
    if (context.identity !== identity()) resetContext();
    scheduleScan();
  }
  function visibilityChanged() {
    if (document.visibilityState === 'hidden') {
      closePreview(); clearTimeout(maintenanceTimer); clearTimeout(scanTimer); cancelJobs();
    } else {
      if (context.identity !== identity()) navigationChanged();
      else { if (fullScanWanted || dirtyRoots.size || cleanupWanted) scheduleScan(); else maintain(); }
      pump();
    }
  }
  function downloadDiagnostics() {
    const report = { version: VERSION, capturedAt: new Date().toISOString(), route: routeKind() || 'other',
      note: '댓글 본문·작성자·저장소명·이슈 주소·쿠키·토큰·GraphQL 변수는 포함하지 않음. 자동 전송하지 않음.',
      config: CONFIG, preferences: prefs, stats: { ...stats, activeRequests, queuedRequests: requestQueue.length,
        activeIssueJobs: jobs.size, queuedIssues: recordQueue.size, memoryEntries: memoryCache.size },
      learnedQueryDiffersFromFallback: queryHash !== FALLBACK_QUERY, events: [...events] };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `github-last-comment-author-diagnostics-${Date.now()}.json`; a.setAttribute(OWN, '');
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function refresh() { resetContext(true); scheduleScan(); }
  // Boot. 테스트 빌드에서만 이 지점 앞에 검사용 함수를 노출한다.
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('마지막 댓글: 보이는 항목 새로 조회', refreshVisible);
    GM_registerMenuCommand('마지막 댓글: 일시정지 / 재개', () => setPaused(!userPaused));
    GM_registerMenuCommand('마지막 댓글: 캐시 비우고 현재 목록 새로 조회', refresh);
    GM_registerMenuCommand('마지막 댓글: 진단 로그 저장 (본문 제외)', downloadDiagnostics);
  }
  addStyles(); cleanOldCaches(); pruneCache();
  for (const event of ['turbo:load', 'pjax:end', 'soft-nav:end']) document.addEventListener(event, navigationChanged);
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('focus', () => { if (context.identity !== identity()) navigationChanged(); else maintain(); });
  window.addEventListener('popstate', navigationChanged);
  window.addEventListener('online', () => { maintain(); pump(); });
  window.addEventListener('offline', () => { cancelJobs(); for (const r of records.values()) paint(r); updateToolbar(); });
  window.addEventListener('pagehide', () => { closePreview(); previewCache.clear(); cancelJobs(); clearTimeout(maintenanceTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted) navigationChanged(); });
  // Chromium의 pushState/replaceState도 잡는다. 지원하지 않는 환경은 GitHub 내비게이션 이벤트와 DOM 관찰을 사용한다.
  if (window.navigation?.addEventListener) window.navigation.addEventListener('currententrychange', navigationChanged);
  document.addEventListener('click', event => {
    const details = toolbar?.querySelector('details');
    if (details?.open && !details.contains(event.target)) details.open = false;
  });
  document.addEventListener('keydown', event => {
    const details = toolbar?.querySelector('details');
    if (event.key === 'Escape' && details?.open) { details.open = false; details.querySelector('summary').focus(); event.stopPropagation(); }
  });
  new MutationObserver(mutationsChanged).observe(document.documentElement,
    { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'datetime', 'content'] });
  fullScanWanted = true; scan();
})();
