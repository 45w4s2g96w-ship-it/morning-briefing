const DIARY_DB = '37451f4140c5808e9141c8804e892661';
const MORNING_BRIEFING_DB = '37d51f4140c580dca4d5cbec7e5534e3';

export default async function handler(req, res) {
  // Vercel Cron 보호: 외부에서 함부로 호출 못하게 막음
  const authHeader = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const result = await runBriefing();
    return res.status(200).json(result);
  } catch (error) {
    console.error('에러 발생:', error);
    return res.status(500).json({ error: String(error) });
  }
}

async function runBriefing() {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const ICLOUD_CALENDAR_URLS = process.env.ICLOUD_CALENDAR_URLS;

  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = kstNow.toISOString().slice(0, 10);
  const yesterday = new Date(kstNow);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  let todaySchedule = '';
  try {
    todaySchedule = await fetchTodayEvents(ICLOUD_CALENDAR_URLS, todayStr);
  } catch (e) {
    console.error('calendar fetch failed', e);
  }

  let diarySummary = '';
  let diaryEncourage = '';
  let diarySuggest = '';
  try {
    const diaryRes = await fetch(`https://api.notion.com/v1/databases/${DIARY_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: yesterdayStr } }, page_size: 1 }),
    });
    const diaryData = await diaryRes.json();
    const page = diaryData.results?.[0];
    if (page) {
      const props = page.properties;
      diarySummary = getRichText(props['일기 요약']);
      diaryEncourage = getRichText(props['격려']);
      diarySuggest = getRichText(props['제언']);
    }
  } catch (e) {
    console.error('diary fetch failed', e);
  }

  const systemPrompt = `너는 사용자(민영)의 아침 브리핑을 작성하는 도우미야. 아래 형식을 정확히 지켜서 한국어로 작성해. 존댓말이면서 친근하고 따뜻한 톤으로. 나중에 음성으로 읽힐 글이라 괄호, 기호 나열처럼 읽기 어색한 표현은 피해.

형식 (섹션 헤더는 반드시 아래 텍스트 그대로 써):
오늘 날씨입니다
(서울의 아침 날씨, 기온(섭씨), 외출 참고사항과 함께 따뜻하고 밝은 인사를 자연스러운 문장으로.)

오늘 일정입니다
(오늘 일정을 자연스러운 문장으로 풀어서. 일정 없으면 "등록된 일정이 없습니다.")

오늘 뉴스입니다
(뉴스 1 본문. 국내외 정치·사회·경제 시사 이슈 중 오늘의 주요 뉴스 하나를 한두 문장으로. 문장 끝에 기사 URL을 괄호로, 하이퍼링크로 연결.)
(뉴스 2 본문. 위와 다른 주제의 주요 시사 뉴스 하나를 한두 문장으로. 반드시 작성해야 해. 문장 끝에 기사 URL을 괄호로, 하이퍼링크로 연결.)

어제는 이런 하루를 보내셨네요
(어제 일기 요약 1~2줄.)

오늘은 이렇게 해보는 게 어떨까요
(행동 제안 한 문단. "이러면 ~예요." 형식으로 마무리.)
(인지 관점 전환 한 문단. "이렇게 보면 ~일 거예요." 또는 "~을 기억해 보세요." 형식으로 마무리.)

규칙:
- 일기 요약은 격려 내용을 무조건 1줄 이상 포함
- 기온은 섭씨(℃)만.
- 뉴스는 반드시 web_search로 오늘 또는 최근 실제 기사를 찾아서 작성. 조중동(조선일보/중앙일보/동아일보) 제외.
- 이모지 전체 출력에서 절대 사용 금지.
- 섹션 헤더 외 설명 문구 추가 금지. 출력은 위 형식 그대로만.`;

  const userPrompt = `오늘(${todayStr}) 일정: ${todaySchedule || '(등록된 일정 없음)'}
어제(${yesterdayStr}) 일기 요약: ${diarySummary || '(없음)'}
어제 격려 메모: ${diaryEncourage || '(없음)'}
어제 제언 메모: ${diarySuggest || '(없음)'}
오늘(${todayStr}) 모닝 브리핑을 작성해줘.`;

  const briefingResult = await callClaude(ANTHROPIC_API_KEY, systemPrompt, userPrompt);
  const briefingText = briefingResult.text || '(브리핑 생성 실패)';

  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const titleLabel = `${kstNow.getUTCMonth() + 1}월 ${kstNow.getUTCDate()}일 ${days[kstNow.getUTCDay()]}요일 모닝 브리핑입니다.`;

  const newBlocks = buildBriefingBlocks(briefingText);

  let existingPageId = null;
  try {
    const searchRes = await fetch(`https://api.notion.com/v1/databases/${MORNING_BRIEFING_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: todayStr } }, page_size: 5 }),
    });
    const searchData = await searchRes.json();
    existingPageId = searchData.results?.[0]?.id || null;
  } catch (e) {
    console.error('existing page search failed', e);
  }

  let pageResult;
  if (existingPageId) {
    try {
      await fetch(`https://api.notion.com/v1/pages/${existingPageId}`, {
        method: 'PATCH',
        headers: notionHeaders(NOTION_TOKEN),
        body: JSON.stringify({
          properties: { '제목': { title: [{ text: { content: titleLabel } }] } }
        })
      });
      const childrenRes = await fetch(`https://api.notion.com/v1/blocks/${existingPageId}/children?page_size=100`, {
        method: 'GET',
        headers: notionHeaders(NOTION_TOKEN),
      });
      const childrenData = await childrenRes.json();
      for (const block of (childrenData.results || [])) {
        await fetch(`https://api.notion.com/v1/blocks/${block.id}`, { method: 'DELETE', headers: notionHeaders(NOTION_TOKEN) });
      }
    } catch (e) {
      console.error('existing page update or blocks delete failed', e);
    }
    const appendRes = await fetch(`https://api.notion.com/v1/blocks/${existingPageId}/children`, {
      method: 'PATCH',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({ children: newBlocks }),
    });
    const appendData = await appendRes.json();
    pageResult = { ok: appendRes.ok, mode: 'updated', pageId: existingPageId, result: appendData };
  } else {
    const createRes = await fetch(`https://api.notion.com/v1/pages`, {
      method: 'POST',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({
        parent: { database_id: MORNING_BRIEFING_DB },
        properties: {
          '제목': { title: [{ text: { content: titleLabel } }] },
          '날짜': { date: { start: todayStr } }
        },
        children: newBlocks,
      }),
    });
    const createData = await createRes.json();
    pageResult = { ok: createRes.ok, mode: 'created', pageId: createData.id, result: createData };
  }

  return { ok: pageResult.ok, todayStr, yesterdayStr, todaySchedule, briefingText, debug: briefingResult.debug, notion: pageResult };
}

// Claude API 호출 (web_search 도구 사용, 멀티턴으로 최종 텍스트 추출)
async function callClaude(apiKey, systemPrompt, userPrompt) {
  try {
    const messages = [{ role: 'user', content: userPrompt }];
    let finalText = '';

    for (let turn = 0; turn < 5; turn++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          system: systemPrompt,
          messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }]
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) return { text: '', debug: { stage: 'claude_error', raw: data } };

      const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);
      finalText = textBlocks.join('\n').trim();

      if (data.stop_reason !== 'tool_use') break;

      // 서버사이드 web_search는 도구 실행/결과가 API 내부에서 처리되어 content에 함께 반환됨.
      // 다음 턴 진행을 위해 assistant 메시지를 그대로 누적.
      messages.push({ role: 'assistant', content: data.content });
    }

    return { text: finalText.trim(), debug: null };
  } catch (error) {
    return { text: '', debug: { stage: 'claude_exception', error: String(error) } };
  }
}

function notionHeaders(token) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }; }
function getRichText(prop) { if (!prop) return ''; if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join(''); if (prop.title) return prop.title.map((t) => t.plain_text).join(''); return ''; }

function dividerBlock() {
  return { object: 'block', type: 'divider', divider: {} };
}

function emptyParagraph() {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } };
}

// 제목 paragraph: 볼드 + 밑줄
function titleParagraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: text }, annotations: { bold: true, underline: true } }]
    }
  };
}

// 본문 paragraph: **..** 마크다운 볼드 + (URL) 하이퍼링크 처리
function bodyParagraph(line) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: splitRichText(line) }
  };
}

// 1) 줄 끝의 (https://...) 패턴을 찾아 직전 텍스트에 링크 적용
// 2) **bold** 마크다운 처리
function splitRichText(line) {
  const urlMatch = line.match(/^(.*)\((https?:\/\/[^\s)]+)\)\s*$/);
  let mainText = line;
  let linkUrl = null;
  if (urlMatch) {
    mainText = urlMatch[1].trim();
    linkUrl = urlMatch[2];
  }

  const parts = splitBoldMarkdown(mainText);

  if (linkUrl && parts.length > 0) {
    const last = parts[parts.length - 1];
    last.text.link = { url: linkUrl };
  }

  return parts;
}

function splitBoldMarkdown(line) {
  const parts = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > lastIndex) parts.push({ content: line.slice(lastIndex, m.index), bold: false });
    parts.push({ content: m[1], bold: true });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) parts.push({ content: line.slice(lastIndex), bold: false });
  if (parts.length === 0) parts.push({ content: line, bold: false });
  return parts.map((p) => {
    const obj = { type: 'text', text: { content: p.content } };
    if (p.bold) obj.annotations = { bold: true };
    return obj;
  });
}

// 섹션 파싱 후 flat 블록 배열로 조립:
//   [제목 paragraph] [본문 paragraph...] [divider] [제목 paragraph] ...
function buildBriefingBlocks(rawText) {
  const text = rawText;

  const tokens = [
    { sub: '오늘 날씨입니다', official: '오늘 날씨입니다.' },
    { sub: '오늘 일정입니다', official: '오늘 일정입니다.' },
    { sub: '오늘 뉴스입니다', official: '오늘 뉴스입니다.' },
    { sub: '어제는 이런 하루를', official: '어제는 이런 하루를 보내셨네요.' },
    { sub: '오늘은 이렇게 해보는 게', official: '오늘은 이렇게 해보는 게 어떨까요?' }
  ];

  const positions = [];
  tokens.forEach((t) => {
    const pos = text.indexOf(t.sub);
    if (pos !== -1) positions.push({ pos, token: t });
  });
  positions.sort((a, b) => a.pos - b.pos);

  const blocks = [];

  for (let i = 0; i < positions.length; i++) {
    if (i > 0) blocks.push(dividerBlock());

    const current = positions[i];
    const next = positions[i + 1];
    const startBody = current.pos + current.token.sub.length;

    let chunk = next ? text.slice(startBody, next.pos) : text.slice(startBody);
    let cleanedBody = chunk.trim();

    if (current.token.sub === '어제는 이런 하루를' && cleanedBody.startsWith('보내셨네요')) {
      cleanedBody = cleanedBody.slice('보내셨네요'.length).trim();
    }
    if (current.token.sub === '오늘은 이렇게 해보는 게') {
      if (cleanedBody.startsWith('어떨까요?')) cleanedBody = cleanedBody.slice('어떨까요?'.length).trim();
      else if (cleanedBody.startsWith('어떨까요')) cleanedBody = cleanedBody.slice('어떨까요'.length).trim();
    }

    blocks.push(titleParagraph(current.token.official));

    const lines = cleanedBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '[SUGGEST2]' || trimmed === '---') {
        blocks.push(emptyParagraph());
        continue;
      }
      blocks.push(bodyParagraph(trimmed));
    }
  }

  // 스크립트 토글
  blocks.push(dividerBlock());
  const scriptText = buildScriptText(text);
  blocks.push({
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [{ type: 'text', text: { content: '스크립트' } }],
      children: textLinesToParagraphBlocks(scriptText)
    }
  });

  return blocks.slice(0, 100);
}

function textLinesToParagraphBlocks(text) {
  const blocks = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: trimmed.slice(0, 2000) } }] }
    });
  }
  return blocks.slice(0, 100);
}

// 음성용 스크립트: 링크/마크다운/이모지 제거하고 문단으로 합치기
function buildScriptText(text) {
  let script = text;
  ['오늘 날씨입니다', '오늘 일정입니다', '오늘 뉴스입니다', '어제는 이런 하루를 보내셨네요', '오늘은 이렇게 해보는 게 어떨까요?', '오늘은 이렇게 해보는 게 어떨까요'].forEach(h => {
    script = script.replace(new RegExp(`^${h}\\s*`, 'gm'), `${h}\n`);
  });

  const paragraphs = [];
  let current = [];
  for (const line of script.split('\n')) {
    const trimmed = line
      .replace(/\[SUGGEST2\]/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\(https?:\/\/[^)]+\)\s*$/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .trim();
    if (!trimmed || trimmed === '---') {
      if (current.length > 0) { paragraphs.push(current.join(' ')); current = []; }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs.join('\n\n').trim();
}

async function fetchTodayEvents(icsUrls, todayStr) {
  if (!icsUrls) return '';
  const urls = icsUrls.split(',').map((u) => u.trim()).filter(Boolean);
  const events = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      const icsText = await res.text();
      events.push(...parseIcsForDate(icsText, todayStr));
    } catch (e) {
      console.error('calendar fetch failed:', url, e);
    }
  }
  events.sort();
  return events.map((e) => e.replace(/^\S+\|/, '')).join(', ');
}

function parseIcsForDate(icsText, todayStr) {
  const results = [];
  const veventBlocks = icsText.split('BEGIN:VEVENT').slice(1);
  const targetDate = parseYMD(todayStr);
  for (const rawBlock of veventBlocks) {
    const block = rawBlock.split('END:VEVENT')[0];
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const dtStartMatch = block.match(/DTSTART(?:;[^:\r\n]*)?:(\d{8})(T(\d{6}))?(Z)?/);
    if (!summaryMatch || !dtStartMatch) continue;
    const summary = summaryMatch[1].trim();
    const dateStr = dtStartMatch[1];
    const timeStr = dtStartMatch[3];
    const isUTC = !!dtStartMatch[4];
    const eventStart = parseYMD(dateStr);
    const rruleMatch = block.match(/RRULE:(.+)/);
    const exdates = [...block.matchAll(/EXDATE(?:;[^:\r\n]*)?:(\d{8})/g)].map((m) => m[1]);
    let occurs = false;
    if (!rruleMatch) {
      occurs = dateStr === todayStr.replace(/-/g, '');
    } else {
      if (compareYMD(targetDate, eventStart) < 0) occurs = false;
      else if (exdates.includes(todayStr.replace(/-/g, ''))) occurs = false;
      else occurs = matchesRRule(rruleMatch[1], eventStart, targetDate);
    }
    if (!occurs) continue;
    let timeLabel = '하루 종일';
    let sortKey = '99:99';
    if (timeStr) {
      let hour = parseInt(timeStr.slice(0, 2), 10);
      const min = timeStr.slice(2, 4);
      if (isUTC) hour = (hour + 9) % 24;
      timeLabel = `${String(hour).padStart(2, '0')}:${min}`;
      sortKey = timeLabel;
    }
    results.push(`${sortKey}|${timeLabel} ${summary}`);
  }
  return results;
}

function parseYMD(str) { const s = str.replace(/-/g, ''); return { y: parseInt(s.slice(0, 4), 10), m: parseInt(s.slice(4, 6), 10), d: parseInt(s.slice(6, 8), 10) }; }
function compareYMD(a, b) { if (a.y !== b.y) return a.y - b.y; if (a.m !== b.m) return a.m - b.m; return a.d - b.d; }
function toDate(ymd) { return new Date(ymd.y, ymd.m - 1, ymd.d); }
function matchesRRule(rrule, start, target) {
  const parts = {};
  for (const kv of rrule.split(';')) { const [k, v] = kv.split('='); parts[k] = v; }
  const freq = parts.FREQ;
  const interval = parseInt(parts.INTERVAL || '1', 10);
  if (parts.UNTIL) { const until = parseYMD(parts.UNTIL.slice(0, 8)); if (compareYMD(target, until) > 0) return false; }
  const startDate = toDate(start);
  const targetDate = toDate(target);
  const dayDiff = Math.round((targetDate - startDate) / 86400000);
  if (dayDiff < 0) return false;
  switch (freq) {
    case 'DAILY': return dayDiff % interval === 0;
    case 'WEEKLY': {
      const weekDiff = Math.floor(dayDiff / 7);
      if (weekDiff % interval !== 0) return false;
      if (parts.BYDAY) { const dayMap = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; return parts.BYDAY.split(',').includes(dayMap[targetDate.getDay()]); }
      return targetDate.getDay() === startDate.getDay();
    }
    case 'MONTHLY': {
      if (target.d !== start.d) return false;
      const monthDiff = (target.y - start.y) * 12 + (target.m - start.m);
      return monthDiff >= 0 && monthDiff % interval === 0;
    }
    case 'YEARLY': {
      if (target.m !== start.m || target.d !== start.d) return false;
      const yearDiff = target.y - start.y;
      return yearDiff >= 0 && yearDiff % interval === 0;
    }
    default: return false;
  }
}
