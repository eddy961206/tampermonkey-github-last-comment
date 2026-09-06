// ==UserScript==
// @name         GitHub 이슈 목록 - 마지막 댓글 작성자
// @namespace    https://github.com/
// @version      1.3.0
// @description  GitHub 이슈 목록에서 마지막 댓글 작성자와 시간을 바로 보여준다.
// @match        https://github.com/*/*/issues*
// @match        https://github.com/issues*
// @match        https://github.com/pulls*
// @match        https://github.com/search*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/eddy961206/tampermonkey-github-last-comment/main/github-last-comment.user.js
// @downloadURL  https://raw.githubusercontent.com/eddy961206/tampermonkey-github-last-comment/main/github-last-comment.user.js
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    cacheMinutes: 10,
    concurrency: 4,
    requestDelayMs: 120,
    showAvatar: true,
    showNoComments: true,
  };

  const MARKER_CLASS = 'gh-last-comment-author';
  const CACHE_PREFIX = 'gh-last-comment-author:v4:';
  const processed = new WeakSet();
  let running = false;
  let rerunRequested = false;

  addStyles();

  function addStyles() {
    if (document.getElementById('gh-last-comment-author-style')) return;
    const style = document.createElement('style');
    style.id = 'gh-last-comment-author-style';
    style.textContent = `
      .${MARKER_CLASS} {
        display: inline-flex; align-items: center; gap: 4px; margin-left: 8px;
        padding: 1px 6px; border: 1px solid var(--borderColor-muted, var(--color-border-muted));
        border-radius: 999px; font-size: 12px; line-height: 20px; font-weight: 500;
        vertical-align: middle; white-space: nowrap; text-decoration: none !important;
        background: var(--bgColor-muted, var(--color-canvas-subtle));
        color: var(--fgColor-accent, var(--color-accent-fg));
      }
      .${MARKER_CLASS}[data-kind="mine"] { color: var(--fgColor-muted, var(--color-fg-muted)); }
      .${MARKER_CLASS}[data-kind="mention"] {
        color: var(--fgColor-attention, var(--color-attention-fg));
        border-color: var(--borderColor-attention-muted, var(--color-attention-muted));
        background: var(--bgColor-attention-muted, var(--color-attention-subtle));
      }
      .${MARKER_CLASS}[data-kind="bot"] { opacity: .65; }
      .${MARKER_CLASS}[data-kind="none"] { color: var(--fgColor-muted, var(--color-fg-muted)); font-weight: 400; }
      .${MARKER_CLASS}[data-kind="error"] { color: var(--fgColor-danger, var(--color-danger-fg)); cursor: pointer; }
      .${MARKER_CLASS} img { width: 16px; height: 16px; border-radius: 50%; }
      .${MARKER_CLASS} .gh-lca-time { color: var(--fgColor-muted, var(--color-fg-muted)); font-weight: 400; }
      @media (max-width: 700px) {
        .${MARKER_CLASS} .gh-lca-prefix, .${MARKER_CLASS} .gh-lca-time { display: none; }
      }
    `;
    document.head.append(style);
  }

  function currentLogin() {
    const meta = document.querySelector('meta[name="user-login"]');
    if (meta?.content) return meta.content;
    const avatar = document.querySelector('header img.avatar-user[alt^="@"]');
    return avatar?.alt?.replace(/^@/, '') || '';
  }

  function parseConversationUrl(href) {
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/);
      if (!match) return null;
      return {
        owner: match[1], repo: match[2], type: match[3], number: match[4],
        url: `${url.origin}/${match[1]}/${match[2]}/${match[3]}/${match[4]}`,
        key: `${match[1]}/${match[2]}#${match[4]}`,
      };
    } catch { return null; }
  }

  function findLikelyRow(link) {
    return link.closest('[data-testid="issue-row"]') || link.closest('.js-issue-row') ||
      link.closest('[role="row"]') || link.closest('li') || link.closest('div.Box-row') || link.parentElement;
  }

  function findTitleLinks() {
    const links = [...document.querySelectorAll('a[href*="/issues/"], a[href*="/pull/"]')];
    const seen = new Set();
    const results = [];
    for (const link of links) {
      const info = parseConversationUrl(link.href);
      if (!info || seen.has(info.key)) continue;
      const text = link.textContent.trim();
      if (!text || text === `#${info.number}` || /^\d+$/.test(text)) continue;
      if (link.closest(`.${MARKER_CLASS}`)) continue;
      const row = findLikelyRow(link);
      if (!row) continue;
      seen.add(info.key);
      results.push({ link, row, info });
    }
    return results;
  }

  const cacheKey = info => `${CACHE_PREFIX}${info.key}`;

  function getCache(info) {
    try {
      const raw = localStorage.getItem(cacheKey(info));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.cachedAt > CONFIG.cacheMinutes * 60_000) return null;
      return parsed.value;
    } catch { return null; }
  }

  function setCache(info, value) {
    try { localStorage.setItem(cacheKey(info), JSON.stringify({ cachedAt: Date.now(), value })); } catch {}
  }

  async function fetchLastComment(info) {
    const response = await fetch(info.url, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html', 'X-Requested-With': 'XMLHttpRequest' },
    });

    if (!response.ok) throw new Error(`이슈 페이지 HTTP ${response.status}`);

    return parseLastComment(await response.text(), info);
  }

  async function parseLastComment(html, info) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const roots = extractEmbeddedJsonRoots(doc);
    const commentsById = new Map();
    const orderState = { value: 0 };

    collectCommentsFromJsonRoots(roots, info, commentsById, orderState);

    const pagination = findFrontTimelinePagination(roots, info);

    if (pagination?.remainingCount > 0) {
      const pageJson = await fetchFrontTimelinePage(pagination);
      collectCommentsFromJsonRoots(
        [pageJson],
        info,
        commentsById,
        orderState
      );
    } else if (pagination?.omissionDetected && !pagination.canFetch) {
      // 생략된 구간이 있다는 건 알지만 변수 추출에 실패했다면,
      // 보이는 일부 댓글만으로 잘못된 작성자를 표시하지 않는다.
      throw new Error('생략된 타임라인 구간의 조회 정보를 찾지 못했어');
    }

    const comments = [...commentsById.values()];

    if (comments.length) {
      comments.sort(comparePayloadComments);
      const last = comments.at(-1);
      const {
        commentId: _commentId,
        discoveryOrder: _discoveryOrder,
        ...result
      } = last;
      return result;
    }

    // 구형 UI나 일부 GitHub Enterprise 화면을 위한 DOM fallback.
    return parseLastCommentFromRenderedHtml(doc, info) || { kind: 'none' };
  }

  function extractEmbeddedJsonRoots(doc) {
    const roots = [];

    for (const script of doc.querySelectorAll('script[type="application/json"]')) {
      try {
        roots.push(JSON.parse(script.textContent || ''));
      } catch {
        // GitHub가 JSON이 아닌 보조 스크립트를 넣은 경우는 건너뛴다.
      }
    }

    return roots;
  }

  function collectCommentsFromJsonRoots(
    roots,
    info,
    commentsById,
    orderState
  ) {
    for (const root of roots) {
      walkJson(root, value => {
        const candidate = commentCandidateFromPayload(
          value,
          info,
          orderState.value++
        );

        if (!candidate) return;

        const previous = commentsById.get(candidate.commentId);

        if (
          !previous ||
          payloadCommentQuality(candidate) >=
            payloadCommentQuality(previous)
        ) {
          candidate.discoveryOrder = Math.max(
            candidate.discoveryOrder,
            previous?.discoveryOrder ?? -1
          );
          commentsById.set(candidate.commentId, candidate);
        }
      });
    }
  }

  function commentCandidateFromPayload(value, info, discoveryOrder) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const rawUrl = firstNonEmptyString(
      value.url,
      value.permalink,
      value.htmlUrl,
      value.html_url,
      value.resourcePath,
      value.resource_path
    );

    const idMatch = rawUrl.match(/issuecomment-(\d+)/);
    if (!idMatch) return null;

    const commentId = idMatch[1];
    const authorObject =
      asObject(value.author) ||
      asObject(value.user) ||
      asObject(value.actor) ||
      {};

    const author = firstNonEmptyString(
      authorObject.login,
      authorObject.username,
      authorObject.name,
      value.authorLogin,
      value.author_login
    ).replace(/^@/, '');

    const avatar = CONFIG.showAvatar
      ? firstNonEmptyString(
          authorObject.avatarUrl,
          authorObject.avatar_url,
          authorObject.avatar,
          value.authorAvatarUrl,
          value.author_avatar_url,
          author
            ? `${location.origin}/${encodeURIComponent(author)}.png?size=32`
            : ''
        )
      : '';

    const time = firstNonEmptyString(
      value.createdAt,
      value.created_at,
      value.submittedAt,
      value.submitted_at,
      value.publishedAt,
      value.published_at,
      value.updatedAt,
      value.updated_at
    );

    const bodyText = extractPayloadBodyText(value);
    const authorType = firstNonEmptyString(
      authorObject.__typename,
      authorObject.type,
      value.authorType,
      value.author_type
    );

    return {
      kind: 'comment',
      author: author || '알 수 없음',
      avatar,
      time,
      commentUrl: normalizeCommentUrl(rawUrl, info.url, commentId),
      isBot:
        authorType.toLowerCase() === 'bot' ||
        /(\[bot\]|-bot)$/i.test(author),
      bodyText,
      commentId,
      discoveryOrder,
    };
  }

  function findFrontTimelinePagination(roots, info) {
    const issue = findIssuePayload(roots, info);

    if (!issue) {
      return {
        omissionDetected: false,
        canFetch: false,
        remainingCount: 0,
      };
    }

    const connections = Object.entries(issue)
      .filter(([key, value]) =>
        /timelineitems/i.test(key) &&
        value &&
        typeof value === 'object' &&
        Array.isArray(value.edges)
      )
      .map(([key, value]) => ({ key, value }));

    const front =
      connections.find(connection =>
        /^fronttimelineitems$/i.test(connection.key)
      )?.value ||
      connections.find(connection =>
        /front/i.test(connection.key)
      )?.value ||
      null;

    if (!front) {
      return {
        omissionDetected: false,
        canFetch: false,
        remainingCount: 0,
      };
    }

    const cursor = firstNonEmptyString(
      front.pageInfo?.endCursor,
      front.pageInfo?.end_cursor,
      front.edges.at(-1)?.cursor
    );

    const loadedKeys = new Set();

    for (const { value: connection } of connections) {
      for (const edge of connection.edges || []) {
        const node = asObject(edge?.node) || {};
        const key = firstNonEmptyString(
          node.id,
          node.url,
          node.resourcePath,
          edge.cursor
        );

        if (key) loadedKeys.add(key);
      }
    }

    const totalCounts = [];

    for (const { value: connection } of connections) {
      for (const candidate of [
        connection.totalCount,
        connection.total_count,
        connection.itemCount,
        connection.item_count,
      ]) {
        if (Number.isInteger(candidate) && candidate >= 0) {
          totalCounts.push(candidate);
        }
      }
    }

    const explicitRemaining = findExplicitRemainingCount(issue);
    const totalCount = totalCounts.length
      ? Math.max(...totalCounts)
      : null;

    let remainingCount = explicitRemaining;

    if (
      !Number.isInteger(remainingCount) &&
      Number.isInteger(totalCount)
    ) {
      remainingCount = Math.max(0, totalCount - loadedKeys.size);
    }

    if (!Number.isInteger(remainingCount)) {
      remainingCount = 0;
    }

    const omissionDetected =
      remainingCount > 0 ||
      Boolean(front.pageInfo?.hasNextPage) ||
      Boolean(front.pageInfo?.has_next_page);

    const id = firstNonEmptyString(issue.id, issue.nodeId, issue.node_id);

    return {
      omissionDetected,
      canFetch: Boolean(
        omissionDetected &&
        remainingCount > 0 &&
        cursor &&
        id
      ),
      remainingCount,
      cursor,
      id,
    };
  }

  function findIssuePayload(roots, info) {
    let best = null;
    let bestScore = -1;

    for (const root of roots) {
      walkJson(root, value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return;
        }

        const front = value.frontTimelineItems;

        if (
          !front ||
          typeof front !== 'object' ||
          !Array.isArray(front.edges)
        ) {
          return;
        }

        let score = 1;

        if (
          String(value.number ?? '') ===
          String(info.number)
        ) {
          score += 8;
        }

        const url = firstNonEmptyString(
          value.url,
          value.resourcePath,
          value.resource_path
        );

        if (url && url.includes(`/${info.type}/${info.number}`)) {
          score += 8;
        }

        if (
          typeof value.id === 'string' &&
          /^I[_-]/.test(value.id)
        ) {
          score += 4;
        }

        if (value.backTimelineItems) score += 2;

        if (score > bestScore) {
          best = value;
          bestScore = score;
        }
      });
    }

    return best;
  }

  function findExplicitRemainingCount(issue) {
    let found = null;

    walkJson(issue, value => {
      if (
        found !== null ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      ) {
        return;
      }

      for (const [key, candidate] of Object.entries(value)) {
        if (
          /remaining.*(?:count|items)|(?:count|items).*remaining/i.test(key) &&
          Number.isInteger(candidate) &&
          candidate >= 0
        ) {
          found = candidate;
          return;
        }
      }
    });

    return found;
  }

  async function fetchFrontTimelinePage({
    remainingCount,
    cursor,
    id,
  }) {
    const body = {
      persistedQueryName: 'NewTimelinePaginationFrontQuery',
      query: 'c652a4589fe3db2aa2c32d0577666ec3',
      variables: {
        count: remainingCount,
        cursor,
        id,
        skip: null,
      },
    };

    const url =
      `/_graphql?body=${encodeURIComponent(JSON.stringify(body))}`;

    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!response.ok) {
      throw new Error(`생략 구간 HTTP ${response.status}`);
    }

    const result = await response.json();

    if (Array.isArray(result?.errors) && result.errors.length) {
      const message = result.errors
        .map(error => error?.message)
        .filter(Boolean)
        .join(', ');

      throw new Error(
        message
          ? `생략 구간 GraphQL 오류: ${message}`
          : '생략 구간 GraphQL 오류'
      );
    }

    return result;
  }

  function walkJson(root, visit) {
    const stack = [root];
    const seen = new WeakSet();

    while (stack.length) {
      const value = stack.pop();

      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);

      visit(value);

      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push(value[index]);
        }
      } else {
        const children = Object.values(value);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }
    }
  }

  function firstNonEmptyString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return '';
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  }

  function extractPayloadBodyText(value) {
    const plainText = firstNonEmptyString(
      value.body,
      value.bodyText,
      value.body_text,
      value.rawBody,
      value.raw_body
    );

    if (plainText) return plainText;

    const html = firstNonEmptyString(
      value.bodyHTML,
      value.bodyHtml,
      value.body_html
    );

    if (!html) return '';

    const bodyDoc = new DOMParser().parseFromString(html, 'text/html');
    return bodyDoc.body?.textContent?.trim() || '';
  }

  function normalizeCommentUrl(
    rawUrl,
    fallbackIssueUrl,
    commentId
  ) {
    try {
      const url = new URL(rawUrl, location.origin);

      if (url.hostname === 'api.github.com') {
        return `${fallbackIssueUrl}#issuecomment-${commentId}`;
      }

      return url.href;
    } catch {
      return `${fallbackIssueUrl}#issuecomment-${commentId}`;
    }
  }

  function payloadCommentQuality(comment) {
    return [
      comment.author && comment.author !== '알 수 없음',
      Boolean(comment.time),
      Boolean(comment.avatar),
      Boolean(comment.bodyText),
      Boolean(comment.commentUrl),
    ].filter(Boolean).length;
  }

  function comparePayloadComments(left, right) {
    const leftTime = Date.parse(left.time || '');
    const rightTime = Date.parse(right.time || '');
    const leftHasTime = Number.isFinite(leftTime);
    const rightHasTime = Number.isFinite(rightTime);

    if (
      leftHasTime &&
      rightHasTime &&
      leftTime !== rightTime
    ) {
      return leftTime - rightTime;
    }

    if (leftHasTime !== rightHasTime) {
      return leftHasTime ? 1 : -1;
    }

    return left.discoveryOrder - right.discoveryOrder;
  }

  function parseLastCommentFromRenderedHtml(doc, info) {
    const rawContainers = [
      ...doc.querySelectorAll(
        '[id^="issuecomment-"], .timeline-comment, .js-comment, [data-testid*="comment"]'
      ),
    ];

    const commentsById = new Map();

    for (const container of rawContainers) {
      const commentId = findIssueCommentId(container);
      if (!commentId) continue;

      const previous = commentsById.get(commentId);

      if (!previous || previous.contains(container)) {
        commentsById.set(commentId, container);
      }
    }

    const comments = [...commentsById.entries()].map(
      ([commentId, container]) => ({ commentId, container })
    );

    if (!comments.length) return null;

    const { commentId, container } = comments.at(-1);
    const author = findCommentAuthor(container);
    const time = findCommentTime(container);
    const img = container.querySelector(
      'img.avatar, img.avatar-user, ' +
      'img[src*="avatars.githubusercontent.com"], ' +
      'img[src*="/avatars/"]'
    );

    const avatar = CONFIG.showAvatar
      ? (
          img?.src ||
          (
            author
              ? `${location.origin}/${encodeURIComponent(author)}.png?size=32`
              : ''
          )
        )
      : '';

    const body = container.querySelector(
      '.comment-body, [data-testid="comment-body"], ' +
      '.markdown-body, [data-testid*="markdown-body"]'
    );

    const bodyText = body?.textContent?.trim() || '';
    const isBot =
      /(\[bot\]|-bot)$/i.test(author) ||
      Boolean(
        container.querySelector(
          '[data-hovercard-type="bot"], [data-bot="true"]'
        )
      );

    return {
      kind: 'comment',
      author: author || '알 수 없음',
      avatar,
      time,
      commentUrl: `${info.url}#issuecomment-${commentId}`,
      isBot,
      bodyText,
    };
  }

  function findIssueCommentId(container) {
    const directValues = [
      container.id,
      container.getAttribute('data-comment-id'),
      container.getAttribute('data-url'),
      container.getAttribute('data-permalink'),
      container.getAttribute('data-href'),
    ].filter(Boolean);

    for (const value of directValues) {
      const match = String(value).match(/issuecomment-(\d+)/);
      if (match) return match[1];

      if (
        container.hasAttribute('data-comment-id') &&
        /^\d+$/.test(String(value))
      ) {
        return String(value);
      }
    }

    const descendant = container.querySelector(
      '[id*="issuecomment-"], [href*="issuecomment-"], ' +
      '[data-url*="issuecomment-"], ' +
      '[data-permalink*="issuecomment-"], ' +
      '[data-href*="issuecomment-"]'
    );

    if (descendant) {
      for (const value of [
        descendant.id,
        descendant.getAttribute('href'),
        descendant.getAttribute('data-url'),
        descendant.getAttribute('data-permalink'),
        descendant.getAttribute('data-href'),
      ]) {
        const match = String(value || '').match(
          /issuecomment-(\d+)/
        );

        if (match) return match[1];
      }
    }

    const htmlMatch = container.outerHTML.match(
      /issuecomment-(\d+)/
    );

    return htmlMatch?.[1] || '';
  }

  function findCommentAuthor(container) {
    const selectors = [
      'a[data-hovercard-type="user"]',
      'a[data-hovercard-url*="/users/"]',
      'a.author',
      'a.Link--primary[href^="/"]',
      'strong a[href^="/"]',
    ];

    for (const selector of selectors) {
      for (
        const candidate of
        container.querySelectorAll(selector)
      ) {
        const login = candidate.textContent
          .trim()
          .replace(/^@/, '');

        if (
          login &&
          /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(login)
        ) {
          return login;
        }
      }
    }

    const authorAttribute = container.querySelector(
      '[data-author], [data-login], [data-user-login]'
    );

    return (
      authorAttribute?.getAttribute('data-author') ||
      authorAttribute?.getAttribute('data-login') ||
      authorAttribute?.getAttribute('data-user-login') ||
      ''
    ).replace(/^@/, '');
  }

  function findCommentTime(container) {
    const relative = container.querySelector(
      'relative-time[datetime]'
    );

    if (relative) {
      return relative.getAttribute('datetime') || '';
    }

    const time = container.querySelector('time[datetime]');

    if (time) {
      return time.getAttribute('datetime') || '';
    }

    const datetimeNode = container.querySelector('[datetime]');
    return datetimeNode?.getAttribute('datetime') || '';
  }

  function formatRelativeTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    let duration = Math.round((date.getTime() - Date.now()) / 1000);
    for (const d of [
      [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year']
    ]) {
      if (Math.abs(duration) < d[0]) return new Intl.RelativeTimeFormat('ko', { numeric: 'auto' }).format(Math.round(duration), d[1]);
      duration /= d[0];
    }
    return '';
  }

  function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function markerKind(result, me) {
    if (result.kind === 'none') return 'none';
    if (result.isBot) return 'bot';
    if (me && result.author.toLowerCase() === me.toLowerCase()) return 'mine';
    if (me && new RegExp(`(^|\\s)@${escapeRegExp(me)}\\b`, 'i').test(result.bodyText || '')) return 'mention';
    return 'other';
  }

  function createLoadingMarker() {
    const marker = document.createElement('span');
    marker.className = MARKER_CLASS;
    marker.dataset.kind = 'loading';
    marker.textContent = '마지막 댓글 불러오는 중…';
    return marker;
  }

  function renderMarker(marker, result, me, info) {
    if (result.kind === 'none') {
      marker.dataset.kind = 'none';
      marker.textContent = '댓글 없음';
      marker.title = '이슈 본문은 댓글로 계산하지 않아';
      if (!CONFIG.showNoComments) marker.hidden = true;
      return;
    }

    const kind = markerKind(result, me);
    const target = document.createElement('a');
    target.className = MARKER_CLASS;
    target.dataset.kind = kind;
    target.href = result.commentUrl || info.url;
    const exact = result.time ? new Date(result.time).toLocaleString('ko-KR') : '';
    target.title = `${kind === 'mention' ? '마지막 댓글에서 나를 멘션했어' : '클릭하면 마지막 댓글로 이동해'}\n작성자: @${result.author}${exact ? `\n작성 시각: ${exact}` : ''}`;

    if (result.avatar) {
      const img = document.createElement('img');
      img.src = result.avatar; img.alt = ''; img.loading = 'lazy';
      target.append(img);
    }
    const prefix = document.createElement('span');
    prefix.className = 'gh-lca-prefix';
    prefix.textContent = kind === 'mention' ? '나를 멘션 · ' : '마지막 댓글 ';
    target.append(prefix);
    const author = document.createElement('span');
    author.textContent = `@${result.author}`;
    target.append(author);
    const relative = formatRelativeTime(result.time);
    if (relative) {
      const time = document.createElement('span');
      time.className = 'gh-lca-time'; time.textContent = `· ${relative}`;
      target.append(time);
    }
    marker.replaceWith(target);
  }

  function renderError(marker, error, item) {
    marker.dataset.kind = 'error';
    marker.textContent = '마지막 댓글 조회 실패';
    marker.title = `${error.message || error}\n클릭하면 다시 시도해`;
    marker.onclick = async event => {
      event.preventDefault();
      marker.dataset.kind = 'loading'; marker.textContent = '다시 불러오는 중…';
      try {
        localStorage.removeItem(cacheKey(item.info));
        const result = await fetchLastComment(item.info);
        setCache(item.info, result);
        renderMarker(marker, result, currentLogin(), item.info);
      } catch (retryError) { renderError(marker, retryError, item); }
    };
  }

  async function processItem(item) {
    if (processed.has(item.link)) return;
    processed.add(item.link);
    const marker = createLoadingMarker();
    item.link.insertAdjacentElement('afterend', marker);
    const cached = getCache(item.info);
    if (cached) return renderMarker(marker, cached, currentLogin(), item.info);
    try {
      const result = await fetchLastComment(item.info);
      setCache(item.info, result);
      renderMarker(marker, result, currentLogin(), item.info);
    } catch (error) { renderError(marker, error, item); }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function runPool(items) {
    let index = 0;
    async function worker() {
      while (index < items.length) {
        await processItem(items[index++]);
        await sleep(CONFIG.requestDelayMs);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONFIG.concurrency, items.length) }, worker));
  }

  async function scan() {
    if (running) { rerunRequested = true; return; }
    running = true;
    try {
      const items = findTitleLinks().filter(item => !processed.has(item.link));
      if (items.length) await runPool(items);
    } finally {
      running = false;
      if (rerunRequested) { rerunRequested = false; scan(); }
    }
  }

  let scanTimer;
  const scheduleScan = () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 250); };
  document.addEventListener('turbo:load', scheduleScan);
  document.addEventListener('pjax:end', scheduleScan);
  document.addEventListener('soft-nav:end', scheduleScan);
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
