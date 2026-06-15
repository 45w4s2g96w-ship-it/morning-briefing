const DIARY_DB = '37451f4140c5808e9141c8804e892661';
const MORNING_BRIEFING_DB = '37d51f4140c580dca4d5cbec7e5534e3';

export default async function handler(req, res) {
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

  // ---- 날짜 계산 (KST 기준) ----
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = kstNow.toISOString().slice(0, 10);
  const yesterday = new Date(kstNow);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // ---- 1. 오늘 일정 조회 (iCloud 캘린더) ----
  let todaySchedule = '';
  try {
    todaySchedule = await fetchTodayEvents(ICLOUD_CALENDAR_URLS, todayStr);
  } catch (e) {
    console.error('calendar fetch failed', e);
  }

  // ---- 2. 어제 다이어리 페이지 조회 ----
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

  // ---- 3. Claude API 호출용 프롬프트 세팅 ----
  const systemPrompt = `너는 사용자(민영)의 아침 브리핑을 작성하는 도우미야. 다음 형식을 정확히 지켜서 한국어로 작성해. 전체적으로 친절하고 전문적인 느낌이되, 존댓말이면서 아주 약간 캐주얼한 톤으로. 나중에 음성으로 그대로 읽힐 글이라는 걸 염두에 두고, 괄호나 기호 나열처럼 읽기 어색한 표현은 피해.

형식 (각 섹션은 빈 줄로 구분):
오늘 날씨입니다
(오늘 상쾌한 하루를 시작할 수 있도록 서울의 현재 날씨 상태를 설명하고, 어울리는 따뜻한 인사말, 기온, 외출 시 참고사항을 자연스러운 문장으로 생성해줘.)

오늘 일정입니다
(아래 제공되는 오늘 일정 목록을 자연스러운 문장으로 풀어서. 일정이 없으면 "등록된 일정이 없습니다.")

오늘 뉴스입니다
(뉴스 1) — 오늘의 주요 국내외 시사 이슈(정치, 사회, 경제 분야) 중 하나를 한두 문장으로 자연스럽게 설명해줘. 설명 문장 끝에 괄호로 가상의 출처 URL을 적어줘. 예: 설명 문장입니다. (https://example.com/article)
---
(뉴스 2) — 오늘의 주요 국내외 시사 이슈 중 또 다른 하나를 한두 문장으로 자연스럽게 설명해줘. 설명 문장 끝에 괄호로 가상의 출처 URL을 적어줘. 예: 설명 문장입니다. (https://example.com/article2)

어제는 이런 하루를 보내셨네요
(어제 일기 요약을 1~2줄로 자연스럽게)
"그래도 이건 잘하셨어요 — " 뒤에 (어제 일기에서 구체적인 행동이나 태도 하나를 짚어서 진심으로 격려). 이 부분은 **굵게** 표시로 감싸줘.

오늘은 이렇게 해보는 게 어떨까요
(구체적인 행동 제안: 한 문단으로 자연스럽게. "이러면 ~예요." 형식으로 마무리.)

(인지적 관점 전환 제안: 한 문단으로 자연스럽게. "이렇게 보면 ~일 거예요." 또는 "~을 기억해 보세요." 형식으로 마무리.)

규칙:
- 날씨상태는 맑음, 구름조금, 흐림, 비, 눈, 천둥번개, 안개, 미세먼지 에서 골라서 사용해. 복합적인 날씨라면 같이 써도 좋고, 오전 비 이후 오후 맑음과 같이 하루 사이에 날씨가 바뀌면 같이 설명해줘.
- 기온은 반드시 섭씨(℃) 기준으로만 표기해.
- "오늘 일정" 섹션은 아래 제공되는 일정 목록을 그대로 나열하지 말고, 자연스러운 문장으로 풀어서 작성해.
- 각 섹션 헤더는 이모지 없이 위에 적힌 텍스트 그대로 써.
- "오늘 뉴스입니다" 섹션에는 반드시 뉴스가 2개 있어야 해. 뉴스 1과 뉴스 2 사이에는 반드시 "---" 구분선을 넣어.
- "오늘은 이렇게 해보는 게 어떨까요" 섹션에는 이모지(🏃, 💭 등)를 쓰지 말고, 두 제안을 각각 한 문단씩 일반 문장으로 작성해.
- 이모지는 전체 출력에서 절대 사용하지 마.
- 출력은 [WEATHER:날씨상태] 줄을 포함한 위 형식 그대로만. 서두/설명 문구를 절대 추가하지 마.`;

  const userPrompt = `오늘(${todayStr}) 일정: ${todaySchedule || '(등록된 일정 없음)'}
어제(${yesterdayStr}) 일기 요약: ${diarySummary || '(없음)'}
어제 격려 메모: ${diaryEncourage || '(없음)'}
어제 제언 메모: ${diarySuggest || '(없음)'}
오늘(${todayStr}) 모닝 브리핑을 작성해줘.`;

  const briefingResult = await callClaude(ANTHROPIC_API_KEY, systemPrompt, userPrompt);
  const briefingText = briefingResult.text || '(브리핑 생성 실패)';

  // 제목 포맷: "M월 D일 d요일 모닝 브리핑입니다."
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
      const existingBlocks = childrenData.results || [];
      for (const block of existingBlocks) {
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

// Claude API 호출부
async function callClaude(apiKey, systemPrompt, userPrompt) {
  const url = 'https://api.anthropic.com/v1/messages';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) return { text: '', debug: { stage: 'claude_error', raw: data } };

    const text = data.content?.[0]?.text || '';
    const idx = text.indexOf('[WEATHER:');
    const finalText = idx >= 0 ? text.slice(idx) : text;

    return { text: finalText.trim(), debug: null };
  } catch (error) {
    return { text: '', debug: { stage: 'claude_exception', error: String(error) } };
  }
}

function notionHeaders(token) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }; }
function getRichText(prop) { if (!prop) return ''; if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join(''); if (prop.title) return prop.title.map((t) => t.plain_text).join(''); return ''; }

// 빈 paragraph 블록 (섹션 사이 공백줄)
function emptyParagraph() {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } };
}

// 각 섹션을 quote 블록으로 조립:
//   quote.rich_text  → 볼드 소제목만
//   quote.children   → [빈줄, 본문 paragraph들 (뉴스 --- 는 divider로)]
// 섹션 사이에 빈 paragraph 블록을 삽입해 공백 한 줄 확보
function buildBriefingBlocks(rawText) {
  const weatherMatch = rawText.match(/^\[WEATHER:[^\]]+\]\s*\n?/);
  const text = weatherMatch ? rawText.slice(weatherMatch[0].length) : rawText;

  // sub: indexOf 탐색용 키워드, official: quote 제목으로 표시할 텍스트
  const tokens = [
    { sub: '오늘 날씨입니다', official: '오늘 날씨입니다' },
    { sub: '오늘 일정입니다', official: '오늘 일정입니다' },
    { sub: '오늘 뉴스입니다', official: '오늘 뉴스입니다' },
    { sub: '어제는 이런 하루를', official: '어제는 이런 하루를 보내셨네요' },
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
    // 섹션 사이 공백 한 줄
    if (i > 0) blocks.push(emptyParagraph());

    const current = positions[i];
    const next = positions[i + 1];
    const startBody = current.pos + current.token.sub.length;

    let chunk = next ? text.slice(startBody, next.pos) : text.slice(startBody);
    let cleanedBody = chunk.trim();

    // 소제목 뒷부분이 본문 앞에 붙어 있는 경우 제거
    if (current.token.sub === '어제는 이런 하루를' && cleanedBody.startsWith('보내셨네요')) {
      cleanedBody = cleanedBody.slice('보내셨네요'.length).trim();
    }
    if (current.token.sub === '오늘은 이렇게 해보는 게' && cleanedBody.startsWith('어떨까요?')) {
      cleanedBody = cleanedBody.slice('어떨까요?'.length).trim();
    }
    if (current.token.sub === '오늘은 이렇게 해보는 게' && cleanedBody.startsWith('어떨까요')) {
      cleanedBody = cleanedBody.slice('어떨까요'.length).trim();
    }

    blocks.push({
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: [
          {
            type: 'text',
            text: { content: current.token.official },
            annotations: { bold: true }
          }
        ],
        // children: 빈줄 1개 + 본문 paragraph/divider 블록들
        children: [emptyParagraph(), ...buildBodyChildren(cleanedBody)]
      }
    });
  }

  // 스크립트 토글 (섹션 사이 공백 포함)
  if (blocks.length > 0) blocks.push(emptyParagraph());
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

// 본문 줄들을 paragraph / divider 블록 배열로 변환
function buildBodyChildren(body) {
  const children = [];
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === '---') {
      children.push({ object: 'block', type: 'divider', divider: {} });
      continue;
    }

    children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: buildLineRichText(trimmed) }
    });
  }

  return children.slice(0, 98); // quote children 최대 99개 (emptyParagraph 1개 포함)
}

// 한 줄을 rich_text 배열로 변환 (**..** 마크다운 볼드 처리)
function buildLineRichText(line) {
  return splitBoldMarkdown(line);
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

function textLinesToParagraphBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (const line of lines) {
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

function buildScriptText(text) {
  let script = text;
  ['오늘 날씨입니다', '오늘 일정입니다', '오늘 뉴스입니다', '어제는 이런 하루를 보내셨네요', '오늘은 이렇게 해보는 게 어떨까요?', '오늘은 이렇게 해보는 게 어떨까요'].forEach(header => {
    script = script.replace(new RegExp(`^${header}\\s*`, 'gm'), `${header}\n`);
  });

  const lines = script.split('\n');
  const cleanedLines = lines.map((line) => {
    if (line.trim() === '---') return '';
    return line
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\(https?:\/\/[^)]+\)\s*$/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .trim();
  });

  const paragraphs = [];
  let current = [];
  for (const line of cleanedLines) {
    if (line === '') {
      if (current.length > 0) { paragraphs.push(current.join(' ')); current = []; }
      continue;
    }
    current.push(line);
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
      if (compareYMD(targetDate, eventStart) < 0) {
        occurs = false;
      } else if (exdates.includes(todayStr.replace(/-/g, ''))) {
        occurs = false;
      } else {
        occurs = matchesRRule(rruleMatch[1], eventStart, targetDate);
      }
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
