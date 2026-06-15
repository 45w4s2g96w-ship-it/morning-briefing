const DIARY_DB = '37451f4140c5808e9141c8804e892661';
const MORNING_BRIEFING_DB = '37d51f4140c580dca4d5cbec7e5534e3';
const NEWS_DB = '38051f4140c580ac9e15000b67739202';

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const queryKey = req.query?.key;
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = queryKey === process.env.CRON_SECRET;
  if (process.env.CRON_SECRET && !isCron && !isManual) {
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

  let recentNewsUrls = [];
  try {
    const threeDaysAgo = new Date(kstNow);
    threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
    const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);
    const newsRes = await fetch(`https://api.notion.com/v1/databases/${NEWS_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({
        filter: { property: '날짜', date: { on_or_after: threeDaysAgoStr } },
        page_size: 50,
      }),
    });
    const newsData = await newsRes.json();
    recentNewsUrls = (newsData.results || [])
      .map((p) => p.properties?.['URL']?.url)
      .filter(Boolean);
  } catch (e) {
    console.error('news history fetch failed', e);
  }

  const systemPrompt = `너는 사용자(민영)의 아침 브리핑을 작성하는 도우미야. 아래 형식을 정확히 지켜서 한국어로 작성해. 정중한 존댓말로 작성하되, 문장 종결을 "~습니다"/"~입니다" 위주로 하고 "~요"체는 가끔만 섞어서 단조롭지 않게. 모든 문장을 "~요"로 끝내거나 "~요"가 연속으로 반복되는 것은 피할 것. 친근한 구어체 어미("~네요~", "~거예요~" 등)나 물결(~), 이모티콘성 표현은 사용하지 말 것. 전체적으로 차분하고 정돈된 어조 유지. "~하셨어요", "~하시는", "~해주시면", "향하시는"처럼 '시'가 들어가는 주체 높임 표현은 쓰지 말 것. 예를 들어 "산책하셨네요"가 아니라 "산책했습니다", "챙기시면"이 아니라 "챙기면"으로. 나중에 음성으로 읽힐 글이라 괄호, 기호 나열처럼 읽기 어색한 표현은 피해.

형식 (섹션 헤더는 반드시 아래 텍스트 그대로 써):
오늘 날씨입니다
(서울의 아침 날씨·기온(섭씨)·외출 참고사항까지 전부 하나의 문단으로 줄바꿈 없이 이어서 작성.)

오늘 일정입니다
(하루 종일/종일 일정이 있다면 가장 먼저 언급. 여러 날에 걸친 일정(출장, 여행, 워크숍 등)이면 오늘이 며칠째인지 "n일차"로 함께 언급. 이후 시간 순서대로 나머지 일정을 자연스러운 문장으로 이어서. 일정 없으면 "등록된 일정이 없습니다.")

오늘 뉴스입니다
(뉴스 1 본문. 국내외 정치·사회·경제 시사 이슈 중 오늘의 주요 뉴스 하나를 한두 문장으로 쓰고, 문장 바로 뒤에 줄바꿈 없이 이어서 (실제 기사 URL) 형식으로 출처 표기.)
(여기서 한 번 줄바꿈.)
(뉴스 2 본문. 위와 다른 주제의 주요 시사 뉴스 하나를 한두 문장으로. 반드시 작성해야 해. 동일하게 문장 바로 뒤에 줄바꿈 없이 (실제 기사 URL) 형식으로 출처 표기.)

어제는 이런 하루를 보내셨네요
(어제 일기 요약 1~2줄.)

오늘은 이렇게 해보는 게 어떨까요
(행동 제안 한 문단. "이러면 ~예요." 형식으로 마무리.)
(여기서 한 번 줄바꿈.)
(인지 관점 전환 한 문단. "이렇게 보면 ~일 거예요." 또는 "~을 기억해 보세요." 형식으로 마무리.)

규칙:
- 일기 요약은 격려 내용을 무조건 1줄 이상 포함
- 기온은 섭씨(℃)만.
- "오늘 날씨입니다" 섹션은 절대 줄바꿈하지 말 것. 인사, 날씨, 기온, 외출 참고사항을 모두 띄어쓰기로만 연결해 한 줄(한 문단)로 작성. 줄바꿈이 하나라도 있으면 잘못된 출력임.
- "오늘 뉴스입니다"의 뉴스1, 뉴스2는 각각 반드시 하나의 단락(한 줄)으로만 작성. 문장이 길어지더라도 중간에 빈 줄을 넣어 두 단락으로 나누는 것 절대 금지. 본문과 (URL)까지 전부 줄바꿈 없이 하나의 줄로 이어서 작성. 뉴스1 전체가 한 줄, 뉴스2 전체가 한 줄, 이 둘 사이에만 줄바꿈 한 번 사용. 위반 시 잘못된 출력임.
- 뉴스는 반드시 web_search로 "어제 오후부터 오늘까지" 발행된 실제 기사 중에서 찾아서 작성. 조중동(조선일보/중앙일보/동아일보) 제외.
- 아래 "제외할 뉴스 URL 목록"에 있는 URL과 동일하거나 같은 사안을 다룬 기사는 절대 선택하지 말 것. 반드시 새로운 주제의 기사를 찾을 것.
- 뉴스 출처는 (실제 기사 URL) 형식으로, 이모티콘과 하이퍼링크를 쓰더라도 절대 단독 줄에 쓰지 말 것. 반드시 기사 본문 문장 맨 끝, 같은 줄, 같은 문단에 붙여 쓸 것.
  올바른 예: "정부가 새 정책을 발표했습니다. (https://example.com/news1)"
  잘못된 예: "정부가 새 정책을 발표했습니다.\n(https://example.com/news1)" (줄바꿈 금지)
- URL은 반드시 해당 기사 개별 페이지의 직접 링크(article permalink)여야 함. 언론사 홈페이지(예: https://www.hani.co.kr), 섹션 목록 페이지(예: /politics, /national), 검색 결과 페이지 URL은 절대 사용 금지. 기사 제목과 본문 내용이 그 URL에 그대로 존재해야 함.
- [언론사명](URL) 같은 마크다운 링크 형식 금지. 반드시 (URL)만 사용.
- 줄바꿈(엔터)은 "오늘 뉴스입니다"의 뉴스1↔뉴스2 사이, "오늘은 이렇게 해보는 게 어떨까요"의 행동제안↔인지전환 사이에서만 사용. 그 외 모든 섹션은 한 문단으로 줄바꿈 없이 작성.
- 검색 과정이나 출처를 본문에서 직접 언급하지 말 것. "AccuWeather 기준으로", "~에 따르면", "~를 보면", "추가로 확인해보니", "검색 결과" 같은 표현 절대 금지. 정보 자체만 자연스럽게 서술.
- 이모지 전체 출력에서 절대 사용 금지.
- 섹션 헤더 외 설명 문구 추가 금지. 출력은 위 형식 그대로만.

마지막으로, 위 전체 브리핑 작성이 끝난 뒤, 아무 설명 없이 새 줄에 정확히 아래 형식으로 메타데이터 2줄을 추가해:
[NEWS_META]
뉴스1제목|뉴스1URL
뉴스2제목|뉴스2URL

(제목은 기사의 실제 제목을 간결하게, URL은 본문에 쓴 것과 동일한 URL. 이 메타데이터 부분은 Notion 페이지에 들어가지 않으니 형식을 정확히 지킬 것.)`;

  const newsExcludeText = recentNewsUrls.length > 0
    ? recentNewsUrls.map((u) => `- ${u}`).join('\n')
    : '(없음)';

  const userPrompt = `오늘(${todayStr}) 일정: ${todaySchedule || '(등록된 일정 없음)'}
어제(${yesterdayStr}) 일기 요약: ${diarySummary || '(없음)'}
어제 격려 메모: ${diaryEncourage || '(없음)'}
어제 제언 메모: ${diarySuggest || '(없음)'}

제외할 뉴스 URL 목록 (최근 3일 이내 이미 다룬 기사, 이것들과 같은 사안은 다루지 말 것):
${newsExcludeText}

오늘(${todayStr}) 모닝 브리핑을 작성해줘.`;

  const briefingResult = await callClaude(ANTHROPIC_API_KEY, systemPrompt, userPrompt);
  const rawBriefingText = briefingResult.text || '(브리핑 생성 실패)';

  const { briefingText, newsMeta } = extractNewsMeta(rawBriefingText);

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

  let newsSaveResult = null;
  if (newsMeta.length > 0) {
    try {
      const newsPages = newsMeta.map((item) => ({
        properties: {
          '제목': { title: [{ text: { content: item.title } }] },
          'URL': { url: item.url },
          '날짜': { date: { start: todayStr } },
        },
      }));
      const results = [];
      for (const page of newsPages) {
        const r = await fetch(`https://api.notion.com/v1/pages`, {
          method: 'POST',
          headers: notionHeaders(NOTION_TOKEN),
          body: JSON.stringify({ parent: { database_id: NEWS_DB }, ...page }),
        });
        results.push(await r.json());
      }
      newsSaveResult = results;
    } catch (e) {
      console.error('news history save failed', e);
    }
  }

  return { ok: pageResult.ok, todayStr, yesterdayStr, todaySchedule, briefingText, newsMeta, newsSave: newsSaveResult, debug: briefingResult.debug, notion: pageResult };
}

// ============================================
// Claude API 호출 — 개선된 버전
// 변경 1: 최대 5턴 → 3턴
// 변경 2: max_tokens 4000 → 2000
// 변경 3: 다음 턴으로 넘길 때 tool_result 블록(검색 결과 전문) 제거
//          → 입력 토큰 누적 폭주 방지
// ============================================
async function callClaude(apiKey, systemPrompt, userPrompt) {
  try {
    const messages = [{ role: 'user', content: userPrompt }];
    let finalText = '';

    for (let turn = 0; turn < 3; turn++) {  // 5 → 3턴
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,  // 4000 → 2000
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

      // tool_result(검색 결과 전문) 블록을 제거하고 검색 쿼리 정보만 남겨서
      // 다음 턴 입력 토큰 누적을 최소화
      const trimmedContent = (data.content || []).map((block) => {
        if (block.type === 'tool_result') {
          // 검색 결과 전문 대신 "(검색 완료)"로 대체
          return { ...block, content: '(검색 완료)' };
        }
        return block;
      });

      messages.push({ role: 'assistant', content: trimmedContent });
    }

    return { text: finalText.trim(), debug: null };
  } catch (error) {
    return { text: '', debug: { stage: 'claude_exception', error: String(error) } };
  }
}

function extractNewsMeta(rawText) {
  const markerIndex = rawText.indexOf('[NEWS_META]');
  if (markerIndex === -1) return { briefingText: rawText.trim(), newsMeta: [] };
  const briefingPart = rawText.slice(0, markerIndex).trim();
  const metaPart = rawText.slice(markerIndex + '[NEWS_META]'.length).trim();
  const newsMeta = metaPart
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.lastIndexOf('|');
      if (idx === -1) return null;
      const title = line.slice(0, idx).trim();
      const url = line.slice(idx + 1).trim();
      if (!title || !/^https?:\/\//.test(url)) return null;
      return { title, url };
    })
    .filter(Boolean);
  return { briefingText: briefingPart, newsMeta };
}

function notionHeaders(token) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }; }
function getRichText(prop) { if (!prop) return ''; if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join(''); if (prop.title) return prop.title.map((t) => t.plain_text).join(''); return ''; }
function dividerBlock() { return { object: 'block', type: 'divider', divider: {} }; }
function emptyParagraph() { return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '\u200b' } }] } }; }
function titleParagraph(text) { return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text }, annotations: { bold: true, underline: true } }] } }; }
function bodyParagraph(line) { return { object: 'block', type: 'paragraph', paragraph: { rich_text: splitRichText(line) } }; }

function splitRichText(line) {
  const trailingUrlMatch = line.match(/^(.*)\((https?:\/\/[^\s)]+)\)\s*$/);
  if (trailingUrlMatch && !line.includes('](')) {
    const mainText = trailingUrlMatch[1].trim();
    const linkUrl = trailingUrlMatch[2];
    const parts = splitBoldMarkdown(mainText);
    parts.push({ type: 'text', text: { content: ' ' } });
    parts.push({ type: 'text', text: { content: '🔗', link: { url: linkUrl } } });
    return parts;
  }
  const parts = [];
  const regex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > lastIndex) parts.push({ content: line.slice(lastIndex, m.index), bold: false, link: null });
    if (m[1] !== undefined) parts.push({ content: m[1], bold: false, link: m[2] });
    else parts.push({ content: m[3], bold: true, link: null });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) parts.push({ content: line.slice(lastIndex), bold: false, link: null });
  if (parts.length === 0) parts.push({ content: line, bold: false, link: null });
  return parts.map(toRichTextObj);
}
function toRichTextObj(p) { const obj = { type: 'text', text: { content: p.content } }; if (p.bold) obj.annotations = { bold: true }; if (p.link) obj.text.link = { url: p.link }; return obj; }
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
  return parts.map((p) => { const obj = { type: 'text', text: { content: p.content } }; if (p.bold) obj.annotations = { bold: true }; return obj; });
}
function normalizeNewsBody(cleanedBody) {
  const flat = cleanedBody.split('\n').map((l) => l.trim()).filter((l) => l && l !== '---').join(' ');
  const urlEndRegex = /\(https?:\/\/[^\s)]+\)/g;
  const items = [];
  let lastIndex = 0;
  let m;
  while ((m = urlEndRegex.exec(flat)) !== null) {
    const end = m.index + m[0].length;
    items.push(flat.slice(lastIndex, end).trim());
    lastIndex = end;
  }
  const remainder = flat.slice(lastIndex).trim();
  if (remainder) { if (items.length > 0) items[items.length - 1] += ' ' + remainder; else items.push(remainder); }
  return items.filter(Boolean).join('\n---\n');
}
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
  tokens.forEach((t) => { const pos = text.indexOf(t.sub); if (pos !== -1) positions.push({ pos, token: t }); });
  positions.sort((a, b) => a.pos - b.pos);
  const blocks = [];
  for (let i = 0; i < positions.length; i++) {
    if (i > 0) blocks.push(dividerBlock());
    const current = positions[i];
    const next = positions[i + 1];
    const startBody = current.pos + current.token.sub.length;
    let chunk = next ? text.slice(startBody, next.pos) : text.slice(startBody);
    let cleanedBody = chunk.trim();
    if (current.token.sub === '어제는 이런 하루를' && cleanedBody.startsWith('보내셨네요')) cleanedBody = cleanedBody.slice('보내셨네요'.length).trim();
    if (current.token.sub === '오늘은 이렇게 해보는 게') {
      if (cleanedBody.startsWith('어떨까요?')) cleanedBody = cleanedBody.slice('어떨까요?'.length).trim();
      else if (cleanedBody.startsWith('어떨까요')) cleanedBody = cleanedBody.slice('어떨까요'.length).trim();
    }
    if (current.token.sub === '오늘 날씨입니다') cleanedBody = cleanedBody.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    if (current.token.sub === '오늘 뉴스입니다') cleanedBody = normalizeNewsBody(cleanedBody);
    blocks.push(titleParagraph(current.token.official));
    const lines = cleanedBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '[SUGGEST2]' || trimmed === '---') { blocks.push(emptyParagraph()); continue; }
      blocks.push(bodyParagraph(trimmed));
    }
    while (blocks.length > 0) {
      const lastBlock = blocks[blocks.length - 1];
      const rt = lastBlock.type === 'paragraph' ? lastBlock.paragraph.rich_text : null;
      const isEmpty = rt && (rt.length === 0 || (rt.length === 1 && ['', '\u200b'].includes(rt[0]?.text?.content?.trim())));
      if (isEmpty) blocks.pop();
      else break;
    }
  }
  return blocks.slice(0, 100);
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
    } catch (e) { console.error('calendar fetch failed:', url, e); }
  }
  events.sort((a, b) => { const [aKey, aTimed] = a.split('|'); const [bKey, bTimed] = b.split('|'); if (aTimed !== bTimed) return aTimed.localeCompare(bTimed); return aKey.localeCompare(bKey); });
  return events.map((e) => e.split('|').slice(2).join('|')).join(', ');
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
    if (!rruleMatch) occurs = dateStr === todayStr.replace(/-/g, '');
    else {
      if (compareYMD(targetDate, eventStart) < 0) occurs = false;
      else if (exdates.includes(todayStr.replace(/-/g, ''))) occurs = false;
      else occurs = matchesRRule(rruleMatch[1], eventStart, targetDate);
    }
    if (!occurs) continue;
    let timeLabel = '하루 종일';
    let sortKey = '00:00';
    let dayInfo = '';
    if (timeStr) {
      let hour = parseInt(timeStr.slice(0, 2), 10);
      const min = timeStr.slice(2, 4);
      if (isUTC) hour = (hour + 9) % 24;
      timeLabel = `${String(hour).padStart(2, '0')}:${min}`;
      sortKey = timeLabel;
    } else {
      const startDate = toDate(eventStart);
      const targetDateObj = toDate(targetDate);
      const dayNum = Math.round((targetDateObj - startDate) / 86400000) + 1;
      if (dayNum >= 2) dayInfo = ` (${dayNum}일차)`;
      sortKey = '00:00';
    }
    const label = timeStr ? `${timeLabel} ${summary}` : `${timeLabel} ${summary}${dayInfo}`;
    results.push(`${sortKey}|${timeStr ? '1' : '0'}|${label}`);
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
    case 'WEEKLY': { const weekDiff = Math.floor(dayDiff / 7); if (weekDiff % interval !== 0) return false; if (parts.BYDAY) { const dayMap = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; return parts.BYDAY.split(',').includes(dayMap[targetDate.getDay()]); } return targetDate.getDay() === startDate.getDay(); }
    case 'MONTHLY': { if (target.d !== start.d) return false; const monthDiff = (target.y - start.y) * 12 + (target.m - start.m); return monthDiff >= 0 && monthDiff % interval === 0; }
    case 'YEARLY': { if (target.m !== start.m || target.d !== start.d) return false; const yearDiff = target.y - start.y; return yearDiff >= 0 && yearDiff % interval === 0; }
    default: return false;
  }
}
