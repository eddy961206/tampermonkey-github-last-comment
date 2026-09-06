// ==UserScript==
// @name         GitHub 이슈 목록 - 마지막 댓글 작성자
// @namespace    https://github.com/
// @version      1.4.0
// @description  일반 댓글의 마지막 작성자를 표시한다. 생략 구간 검증, 요청 제한, 갱신, 본문 없는 진단 로그를 지원한다.
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

  const VERSION = '1.4.0';
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
    showAvatar: true,
    showNoComments: true,
  });
  const QUERY_NAME = 'NewTimelinePaginationFrontQuery';
  // 사용자가 2026-07-30에 캡처한 값. 현재 서버에서 유효하다고 가정하지 않는다.
  // GitHub의 실제 Load more GET 요청을 관찰하면 새 해시만 학습한다.
  const FALLBACK_QUERY = 'c652a4589fe3db2aa2c32d0577666ec3';
  const PREFIX = 'gh-last-comment-author:v5:';
  const QUERY_KEY = `${PREFIX}pagination-query`;
  const MARKER = 'gh-last-comment-author';
  const OWN = 'data-gh-lca-owned';
  const STYLE_ID = 'gh-last-comment-author-style';
  const SINGLETON = '__ghLca14Running';
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
  const stats = { requests: 0, cacheHits: 0, successes: 0, failures: 0, cancelled: 0, pages: 0 };

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
  const cacheKey = (info, me) => `${PREFIX}cache:${encodeURIComponent(me.toLowerCase() || 'anonymous')}:${keyOf(info)}`;
  const ttlFor = result => result.kind === 'none' ? CONFIG.noCommentCacheSeconds * 1000 : CONFIG.cacheMinutes * 60_000;
  function getCache(info, signature, me) {
    const entry = storageGet(cacheKey(info, me));
    if (!entry || entry.signature !== signature || !validResult(entry.value) ||
        !Number.isFinite(entry.at) || Date.now() < entry.at || Date.now() - entry.at >= ttlFor(entry.value)) return null;
    // 저장소 데이터도 신뢰하지 않는다. 외부 링크나 외부 아바타는 재사용하지 않는다.
    if (entry.value.kind === 'comment') {
      const p = parseConversationUrl(entry.value.commentUrl);
      if (!p || new URL(entry.value.commentUrl).hash.match(/^#issuecomment-\d+$/) === null) return null;
      entry.value.avatar = safeAvatar(entry.value.avatar);
    }
    return entry;
  }
  function validResult(v) {
    return obj(v) && (v.kind === 'none' || (v.kind === 'comment' &&
      typeof v.author === 'string' && typeof v.commentUrl === 'string' &&
      Number.isFinite(Date.parse(v.time)) && typeof v.mentionsMe === 'boolean'));
  }
  function setCache(info, signature, me, result) {
    // 본문과 HTML은 저장하지 않는다. 계정별로 분리한 탭 내부 단기 캐시다.
    const value = result.kind === 'none' ? { kind: 'none' } : {
      kind: 'comment', author: result.author, avatar: result.avatar, time: result.time,
      commentUrl: result.commentUrl, isBot: result.isBot, mentionsMe: result.mentionsMe,
    };
    const entry = { at: Date.now(), signature, value };
    storageSet(cacheKey(info, me), entry);
    pruneCache(); return entry;
  }
  function pruneCache(clear = false) {
    try {
      const entries = [];
      for (const key of Object.keys(sessionStorage)) {
        if (!key.startsWith(`${PREFIX}cache:`)) continue;
        const value = storageGet(key);
        if (clear || !value?.value || !Number.isFinite(value.at) || Date.now() - value.at >= ttlFor(value.value)) storageDelete(key);
        else entries.push([key, value.at]);
      }
      entries.sort((a, b) => b[1] - a[1]);
      for (const [key] of entries.slice(CONFIG.maxCacheEntries)) storageDelete(key);
      // v1.3에서 남긴 댓글 본문 포함 캐시만 정리한다. 다른 저장소 값은 건드리지 않는다.
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('gh-last-comment-author:v4:')) localStorage.removeItem(key);
      }
    } catch {}
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
    if (!requestQueue.length || activeRequests >= CONFIG.concurrency) return;
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
        pausedUntil = Date.now() + Math.min(300_000, Math.max(60_000, Number.isFinite(delay) ? delay : 60_000));
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
      mentionsMe: mentioned(value, me) };
  }
  function newest(comments) {
    if (!comments.size) return { kind: 'none' };
    const ordered = [...comments.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) ||
      (BigInt(a.commentId) < BigInt(b.commentId) ? -1 : BigInt(a.commentId) > BigInt(b.commentId) ? 1 : 0));
    const { commentId, ...result } = ordered.at(-1); return result;
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
  function findTitleLinks() {
    if (!routeKind()) return [];
    const root = document.querySelector('main, [role="main"], #repo-content-pjax-container') || document.body;
    const rows = new Map();
    for (const link of root.querySelectorAll('a[href*="/issues/"], a[href*="/pull/"]')) {
      if (link.closest(`[${OWN}], .markdown-body, .comment-body, header, nav, [role="dialog"], [role="tooltip"]`)) continue;
      const info = parseConversationUrl(link.href), text = link.textContent.trim();
      if (!info || !text || /^#?\d+$/.test(text) || new URL(link.href).hash) continue;
      const row = link.closest('[data-testid="issue-row"], [data-testid="pull-request-row"], [data-testid="list-row"], [data-testid="list-view-item"], [data-listview-item-id], .js-issue-row, .Box-row, [role="row"], [role="listitem"], li') || link.parentElement;
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
  function addStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) { style = document.createElement('style'); style.id = STYLE_ID; document.head.append(style); }
    style.setAttribute(OWN, '');
    style.textContent = `
      .${MARKER}{display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:1px 6px;border:1px solid var(--borderColor-muted,#d1d9e0);border-radius:999px;font:500 12px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;vertical-align:middle;white-space:nowrap;background:var(--bgColor-muted,#f6f8fa);color:var(--fgColor-accent,#0969da)}
      .${MARKER}[hidden]{display:none!important}
      .${MARKER} a,.${MARKER} button{display:inline-flex;align-items:center;gap:4px;color:inherit!important;text-decoration:none!important;background:transparent;border:0;padding:0;font:inherit;cursor:pointer}
      .${MARKER} a:focus-visible,.${MARKER} button:focus-visible{outline:2px solid currentColor;outline-offset:3px}
      .${MARKER}[data-kind="mine"],.${MARKER}[data-kind="none"],.${MARKER}[data-kind="loading"]{color:var(--fgColor-muted,#59636e)}
      .${MARKER}[data-kind="mention"]{color:var(--fgColor-attention,#9a6700);border-color:var(--borderColor-attention-emphasis,#bf8700);background:var(--bgColor-attention-muted,#fff8c5)}
      .${MARKER}[data-kind="bot"]{opacity:.7}
      .${MARKER}[data-kind="error"]{color:var(--fgColor-danger,#d1242f)}
      .${MARKER} img{width:16px;height:16px;border-radius:50%}
      .${MARKER} .gh-lca-time{color:var(--fgColor-muted,#59636e);font-weight:400}
      @media(max-width:700px){.${MARKER} .gh-lca-prefix,.${MARKER} .gh-lca-time{display:none}}
    `;
  }
  const relativeFormatter = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });
  function relativeTime(value) {
    const seconds = (Date.parse(value) - Date.now()) / 1000;
    if (!Number.isFinite(seconds)) return '';
    for (const [scale, unit, limit] of [[1, 'second', 60], [60, 'minute', 60], [3600, 'hour', 24],
      [86400, 'day', 30], [2592000, 'month', 12], [31536000, 'year', Infinity]]) {
      if (Math.abs(seconds / scale) < limit) return relativeFormatter.format(Math.round(seconds / scale), unit);
    }
    return '';
  }
  function markerKind(result, me) {
    if (result.kind === 'none') return 'none';
    if (me && result.author.toLowerCase() === me.toLowerCase()) return 'mine';
    if (result.mentionsMe) return 'mention';
    return result.isBot ? 'bot' : 'other';
  }
  function render(record, result, me, at) {
    const marker = record.marker; marker.hidden = false; marker.replaceChildren();
    marker.dataset.kind = markerKind(result, me);
    if (result.kind === 'none') {
      marker.textContent = '댓글 없음'; marker.hidden = !CONFIG.showNoComments;
      marker.title = '일반 댓글이 0개인 것을 확인했어. 이슈 본문, 이벤트, 코드줄 리뷰 댓글은 제외해'; return;
    }
    const link = document.createElement('a'); link.href = result.commentUrl;
    link.title = `작성자: ${result.author ? '@' + result.author : '삭제된 계정 또는 작성자 미제공'}\n작성: ${new Date(result.time).toLocaleString('ko-KR')}\n확인: ${new Date(at).toLocaleString('ko-KR')}\n클릭하면 일반 댓글로 이동해${result.mentionsMe ? '\n본문에 내 아이디가 있어. 실제 알림 전송 여부는 확인하지 않아' : ''}`;
    if (result.avatar && CONFIG.showAvatar) {
      const image = document.createElement('img'); image.src = safeAvatar(result.avatar); image.alt = '';
      image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.onerror = () => image.remove(); link.append(image);
    }
    const prefix = document.createElement('span'); prefix.className = 'gh-lca-prefix';
    prefix.textContent = result.mentionsMe && marker.dataset.kind !== 'mine' ? '내 아이디 언급 · ' : '마지막 댓글 ';
    const author = document.createElement('span'); author.textContent = result.author ? `@${result.author}` : '작성자 정보 없음';
    const time = document.createElement('span'); time.className = 'gh-lca-time'; time.dataset.datetime = result.time;
    time.textContent = `· ${relativeTime(result.time)}`; link.append(prefix, author, time); marker.append(link);
  }
  function renderError(record, error) {
    record.marker.hidden = false; record.marker.dataset.kind = 'error';
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = error.code === 'RATE_LIMIT' ? '조회 제한 · 재시도' : '마지막 댓글 조회 실패';
    button.title = `${error.message}\n오류 코드: ${error.code || 'PAGE_SHAPE'}${error.status ? ` / HTTP ${error.status}` : ''}\n클릭하면 다시 시도해`;
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (record.state === 'loading') return;
      storageDelete(cacheKey(record.info, context.me)); record.lastAttempt = 0;
      void loadRecord(record, true);
    });
    record.marker.replaceChildren(button);
  }

  let context = { identity: '', me: '', controller: new AbortController(), inflight: new Map() };
  const records = new Map();
  let scanTimer, firstScheduled = 0;
  const identity = () => `${location.pathname}${location.search}|${currentLogin().toLowerCase()}`;
  function resetContext(clearCache = false) {
    context.controller.abort();
    for (const record of records.values()) { visibilityObserver?.unobserve(record.link); record.marker.remove(); }
    records.clear();
    context = { identity: identity(), me: currentLogin(), controller: new AbortController(), inflight: new Map() };
    if (clearCache) pruneCache(true);
    log('context_reset', { route: routeKind() || 'other', manual: clearCache });
  }
  function stillCurrent(record, ctx, version) {
    return ctx === context && ctx.identity === identity() && !ctx.controller.signal.aborted && record.version === version &&
      record.link.isConnected && record.marker.isConnected && parseConversationUrl(record.link.href)?.key === record.info.key &&
      rowSignature(record.row) === record.signature;
  }
  async function loadRecord(record, force = false) {
    if (!record.visible || record.state === 'loading' || !record.link.isConnected) return;
    const ctx = context, version = record.version;
    const cached = !force && getCache(record.info, record.signature, ctx.me);
    if (cached) {
      stats.cacheHits++; record.state = 'done'; record.freshUntil = cached.at + ttlFor(cached.value);
      render(record, cached.value, ctx.me, cached.at); return;
    }
    if (!force && record.state === 'error' && Date.now() - record.lastAttempt < 30_000) return;
    record.state = 'loading'; record.lastAttempt = Date.now(); record.marker.hidden = false;
    record.marker.dataset.kind = 'loading'; record.marker.textContent = '마지막 댓글 불러오는 중…';
    try {
      const pendingKey = `${record.info.key}|${record.signature}`;
      let pending = ctx.inflight.get(pendingKey);
      if (!pending) {
        pending = fetchLastComment(record.info, ctx.me, ctx.controller.signal);
        ctx.inflight.set(pendingKey, pending);
        // finally로 새 미처리 rejection을 만들지 않는다.
        pending.then(() => { if (ctx.inflight.get(pendingKey) === pending) ctx.inflight.delete(pendingKey); },
          () => { if (ctx.inflight.get(pendingKey) === pending) ctx.inflight.delete(pendingKey); });
      }
      const result = await pending;
      if (!stillCurrent(record, ctx, version)) return;
      const entry = setCache(record.info, record.signature, ctx.me, result);
      record.state = 'done'; record.freshUntil = entry.at + ttlFor(result); stats.successes++;
      render(record, result, ctx.me, entry.at);
    } catch (error) {
      if (error.code === 'ABORTED' || !stillCurrent(record, ctx, version)) { stats.cancelled++; return; }
      record.state = 'error'; stats.failures++;
      const safe = error instanceof LcaError ? error : fail('PAGE_SHAPE');
      log('item_error', { item: alias(record.info), code: safe.code, status: safe.status });
      renderError(record, safe);
    }
  }
  const visibilityObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target); if (!record) continue;
      record.visible = entry.isIntersecting;
      if (record.visible && (record.state !== 'done' || Date.now() >= record.freshUntil)) void loadRecord(record);
    }
  }, { rootMargin: '400px 0px' }) : null;
  function scan() {
    clearTimeout(scanTimer); scanTimer = null; firstScheduled = 0;
    if (context.identity !== identity()) resetContext();
    if (!routeKind() || document.visibilityState === 'hidden') return;
    const items = findTitleLinks(), present = new Set(items.map(item => item.link));
    for (const [link, record] of records) {
      if (!present.has(link) || !link.isConnected) {
        visibilityObserver?.unobserve(link); record.marker.remove(); records.delete(link); record.version++;
      }
    }
    for (const item of items) {
      let record = records.get(item.link);
      const signature = rowSignature(item.row);
      if (record && (record.info.key !== item.info.key || record.signature !== signature)) {
        record.version++; record.marker.remove(); visibilityObserver?.unobserve(item.link); records.delete(item.link); record = null;
      }
      if (!record) {
        const marker = document.createElement('span'); marker.className = MARKER; marker.setAttribute(OWN, '');
        marker.dataset.kind = 'loading'; marker.textContent = '마지막 댓글 대기 중…';
        item.link.insertAdjacentElement('afterend', marker);
        const rect = item.link.getBoundingClientRect();
        record = { ...item, marker, signature, version: 1, state: 'new', freshUntil: 0, lastAttempt: 0,
          visible: !visibilityObserver || (item.link.getClientRects().length > 0 && rect.top < innerHeight + 400 && rect.bottom > -400) };
        records.set(item.link, record); visibilityObserver?.observe(item.link);
      } else {
        record.row = item.row;
        if (!record.marker.isConnected || record.marker.parentElement !== item.link.parentElement) {
          item.link.insertAdjacentElement('afterend', record.marker);
        }
      }
      if (record.visible && (record.state !== 'done' || Date.now() >= record.freshUntil)) void loadRecord(record);
    }
  }
  function scheduleScan() {
    const now = Date.now(); if (!firstScheduled) firstScheduled = now;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, now - firstScheduled > 1200 ? 0 : 200);
  }
  function mutationsMatter(mutations) {
    return mutations.some(mutation => {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (target?.closest?.(`[${OWN}]`)) return false;
      if (mutation.type === 'attributes') return true;
      // 자체 배지 추가로 화면 전체를 재탐색하지 않는다. 외부에서 삭제된 배지는 복구한다.
      if (!mutation.removedNodes.length && mutation.addedNodes.length &&
          [...mutation.addedNodes].every(n => n.nodeType === 1 && n.hasAttribute(OWN))) return false;
      return true;
    });
  }
  function downloadDiagnostics() {
    const report = { version: VERSION, capturedAt: new Date().toISOString(), route: routeKind() || 'other',
      note: '댓글 본문·작성자·저장소명·이슈 주소·쿠키·토큰·GraphQL 변수는 포함하지 않음. 자동 전송하지 않음.',
      config: CONFIG, stats: { ...stats, activeRequests, queuedRequests: requestQueue.length },
      learnedQueryDiffersFromFallback: queryHash !== FALLBACK_QUERY, events: [...events] };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `github-last-comment-author-diagnostics-${Date.now()}.json`; a.setAttribute(OWN, '');
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function refresh() { resetContext(true); scheduleScan(); }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('마지막 댓글: 캐시 비우고 현재 목록 새로 조회', refresh);
    GM_registerMenuCommand('마지막 댓글: 진단 로그 저장 (본문 제외)', downloadDiagnostics);
  }
  addStyles(); pruneCache();
  for (const event of ['turbo:load', 'pjax:end', 'soft-nav:end']) document.addEventListener(event, scheduleScan);
  document.addEventListener('visibilitychange', scheduleScan);
  window.addEventListener('focus', scheduleScan); window.addEventListener('popstate', scheduleScan);
  new MutationObserver(mutations => { if (mutationsMatter(mutations)) scheduleScan(); }).observe(document.documentElement,
    { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'datetime', 'content'] });
  setInterval(() => {
    if (context.identity !== identity()) { resetContext(); scheduleScan(); }
  }, 1000);
  setInterval(() => {
    if (document.visibilityState === 'hidden' || !routeKind()) return;
    for (const n of document.querySelectorAll(`.${MARKER} .gh-lca-time[data-datetime]`)) n.textContent = `· ${relativeTime(n.dataset.datetime)}`;
    scheduleScan();
  }, 30_000);
  scan();
})();
