const DIARY_DB = '37451f4140c5808e9141c8804e892661';
const MORNING_BRIEFING_DB = '37d51f4140c580dca4d5cbec7e5534e3';

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const queryKey = req.query?.key;
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = queryKey === process.env.CRON_SECRET;
  if (process.env.CRON_SECRET && !isCron && !isManual) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const overrideDate = req.query?.date || null;
    const result = await runBriefing(overrideDate);
    return res.status(200).json(result);
  } catch (error) {
    console.error('에러 발생:', error);
    return res.status(500).json({ error: String(error) });
  }
}

async function runBriefing(overrideDate = null) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const ICLOUD_CALENDAR_URLS = process.env.ICLOUD_CALENDAR_URLS;

  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = overrideDate || kstNow.toISOString().slice(0, 10);
  const yesterday = new Date(todayStr);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  let todaySchedule = '';
  try {
    todaySchedule = await fetchTodayEvents(ICLOUD_CALENDAR_URLS, todayStr);
  } catch (e) {
    console.error('calendar fetch failed', e);
  }

  let diarySummary = '';
  try {
    const diaryRes = await fetch(`https://api.notion.com/v1/databases/${DIARY_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: yesterdayStr } }, page_size: 1 }),
    });
    const diaryData = await diaryRes.json();
    const page = diaryData.results?.[0];
    if (page) diarySummary = getRichText(page.properties['일기 요약']);
  } catch (e) {
    console.error('diary fetch failed', e);
  }

  const systemPrompt = `너는 민영의 아침 브리핑 작성 도우미야. 한국어, 존댓말, "~습니다/입니다" 위주, "~요" 남발 금지, 이모지 금지, 주체높임("~하시는") 금지, 물결/구어체 금지. 음성으로 읽힐 글이므로 기호 나열 금지.

아래 헤더를 정확히 사용해 5개 섹션 작성:

오늘 날씨입니다
(한 문단, 줄바꿈 없이. 서울 날씨·기온℃·외출팁)

오늘 일정입니다
(시간순. 종일일정 먼저, n일차 표기. 없으면 "등록된 일정이 없습니다.")

오늘 뉴스입니다
(뉴스1 본문 (URL)
뉴스2 본문 (URL) — 뉴스1↔2 사이만 줄바꿈 1회)

어제는 이런 하루를 보내셨네요
(요약 1~2줄, 격려 1줄 이상 포함)

오늘은 이렇게 해보는 게 어떨까요
(행동제안 1문단
인지전환 1문단 — 둘 사이만 줄바꿈 1회)

규칙:
- 날씨/일정/어제/오늘제안 섹션은 줄바꿈 절대 금지
- 뉴스는 web_search로 최신 기사 찾기, 조중동 제외, 개별 기사 URL만 사용, (URL) 형식 인라인
- "~에 따르면", "검색 결과" 등 출처 언급 금지`;

  const userPrompt = `오늘(${todayStr}) 일정: ${todaySchedule || '(없음)'}
어제(${yesterdayStr}) 일기 요약: ${diarySummary || '(없음)'}
오늘 브리핑 작성해줘.`;

  const briefingResult = await callClaude(ANTHROPIC_API_KEY, systemPrompt, userPrompt);
  const rawBriefingText = briefingResult.text || '(브리핑 생성 실패)';
  const briefingText = rawBriefingText.trim();

  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dateObj = new Date(todayStr + 'T00:00:00+09:00');
  const titleLabel = `${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일 ${days[dateObj.getDay()]}요일 모닝 브리핑입니다.`;

  const newBlocks = buildBriefingBlocks(briefingText);

  let existingPageId = null;
  try {
    const searchRes = await fetch(`https://api.notion.com/v1/databases/${MORNING_BRIEFING_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: todayStr } }, page_size: 1 }),
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
        body: JSON.stringify({ properties: { '제목': { title: [{ text: { content: titleLabel } }] } } })
      });
      const childrenRes = await fetch(`https://api.notion.com/v1/blocks/${existingPageId}/children?page_size=100`, {
        headers: notionHeaders(NOTION_TOKEN),
      });
      const childrenData = await childrenRes.json();
      for (const block of (childrenData.results || [])) {
        await fetch(`https://api.notion.com/v1/blocks/${block.id}`, { method: 'DELETE', headers: notionHeaders(NOTION_TOKEN) });
      }
    } catch (e) {
      console.error('existing page update failed', e);
    }
    const appendRes = await fetch(`https://api.notion.com/v1/blocks/${existingPageId}/children`, {
      method: 'PATCH',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({ children: newBlocks }),
    });
    pageResult = { ok: appendRes.ok, mode: 'updated', pageId: existingPageId };
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
    pageResult = { ok: createRes.ok, mode: 'created', pageId: createData.id };
  }

  return { ok: pageResult.ok, todayStr, yesterdayStr, todaySchedule, briefingText, debug: briefingResult.debug, notion: pageResult };
}

async function callClaude(apiKey, systemPrompt, userPrompt) {
  try {
    const messages = [{ role: 'user', content: userPrompt }];
    let finalText = '';

    for (let turn = 0; turn < 2; turn++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          system: systemPrompt,
          messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }]
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) return { text: '', debug: { stage: 'claude_error', raw: data } };

      const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);

      if (data.stop_reason !== 'tool_use') {
        finalText = textBlocks.join('\n').trim();
        break;
      }

      const trimmedContent = (data.content || []).map((block) =>
        block.type === 'tool_result' ? { ...block, content: '(검색 완료)' } : block
      );
      messages.push({ role: 'assistant', content: trimmedContent });
    }

    return { text: finalText.trim(), debug: null };
  } catch (error) {
    return { text: '', debug: { stage: 'claude_exception', error: String(error) } };
  }
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
  let lastIndex = 0, m;
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
  let lastIndex = 0, m;
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
  let lastIndex = 0, m;
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
  const tokens = [
    { sub: '오늘 날씨입니다', official: '오늘 날씨입니다.' },
    { sub: '오늘 일정입니다', official: '오늘 일정입니다.' },
    { sub: '오늘 뉴스입니다', official: '오늘 뉴스입니다.' },
    { sub: '어제는 이런 하루를', official: '어제는 이런 하루를 보내셨네요.' },
    { sub: '오늘은 이렇게 해보는 게', official: '오늘은 이렇게 해보는 게 어떨까요?' }
  ];
  const positions = [];
  tokens.forEach((t) => { const pos = rawText.indexOf(t.sub); if (pos !== -1) positions.push({ pos, token: t }); });
  positions.sort((a, b) => a.pos - b.pos);
  const blocks = [];
  for (let i = 0; i < positions.length; i++) {
    if (i > 0) blocks.push(dividerBlock());
    const current = positions[i];
    const next = positions[i + 1];
    const startBody = current.pos + current.token.sub.length;
    let cleanedBody = (next ? rawText.slice(startBody, next.pos) : rawText.slice(startBody)).trim();
    if (current.token.sub === '어제는 이런 하루를' && cleanedBody.startsWith('보내셨네요')) cleanedBody = cleanedBody.slice('보내셨네요'.length).trim();
    if (current.token.sub === '오늘은 이렇게 해보는 게') {
      if (cleanedBody.startsWith('어떨까요?')) cleanedBody = cleanedBody.slice('어떨까요?'.length).trim();
      else if (cleanedBody.startsWith('어떨까요')) cleanedBody = cleanedBody.slice('어떨까요'.length).trim();
    }
    if (current.token.sub === '오늘 날씨입니다') cleanedBody = cleanedBody.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    if (current.token.sub === '오늘 뉴스입니다') cleanedBody = normalizeNewsBody(cleanedBody);
    blocks.push(titleParagraph(current.token.official));
    for (const line of cleanedBody.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '---') { blocks.push(emptyParagraph()); continue; }
      blocks.push(bodyParagraph(trimmed));
    }
    while (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      const rt = last.type === 'paragraph' ? last.paragraph.rich_text : null;
      if (rt && (rt.length === 0 || (rt.length === 1 && ['', '\u200b'].includes(rt[0]?.text?.content?.trim())))) blocks.pop();
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
      events.push(...parseIcsForDate(await res.text(), todayStr));
    } catch (e) { console.error('calendar fetch failed:', url, e); }
  }
  events.sort((a, b) => { const [aK, aT] = a.split('|'); const [bK, bT] = b.split('|'); return aT !== bT ? aT.localeCompare(bT) : aK.localeCompare(bK); });
  return events.map((e) => e.split('|').slice(2).join('|')).join(', ');
}
function parseIcsForDate(icsText, todayStr) {
  const results = [];
  const targetDate = parseYMD(todayStr);
  for (const rawBlock of icsText.split('BEGIN:VEVENT').slice(1)) {
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
      if (compareYMD(targetDate, eventStart) < 0 || exdates.includes(todayStr.replace(/-/g, ''))) occurs = false;
      else occurs = matchesRRule(rruleMatch[1], eventStart, targetDate);
    }
    if (!occurs) continue;
    let timeLabel = '하루 종일', sortKey = '00:00', dayInfo = '';
    if (timeStr) {
      let hour = parseInt(timeStr.slice(0, 2), 10);
      if (isUTC) hour = (hour + 9) % 24;
      timeLabel = `${String(hour).padStart(2, '0')}:${timeStr.slice(2, 4)}`;
      sortKey = timeLabel;
    } else {
      const dayNum = Math.round((toDate(targetDate) - toDate(eventStart)) / 86400000) + 1;
      if (dayNum >= 2) dayInfo = ` (${dayNum}일차)`;
    }
    results.push(`${sortKey}|${timeStr ? '1' : '0'}|${timeLabel} ${summary}${dayInfo}`);
  }
  return results;
}
function parseYMD(str) { const s = str.replace(/-/g, ''); return { y: +s.slice(0,4), m: +s.slice(4,6), d: +s.slice(6,8) }; }
function compareYMD(a, b) { return a.y !== b.y ? a.y-b.y : a.m !== b.m ? a.m-b.m : a.d-b.d; }
function toDate(ymd) { return new Date(ymd.y, ymd.m-1, ymd.d); }
function matchesRRule(rrule, start, target) {
  const parts = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=')));
  const interval = +(parts.INTERVAL || 1);
  if (parts.UNTIL && compareYMD(target, parseYMD(parts.UNTIL.slice(0,8))) > 0) return false;
  const dayDiff = Math.round((toDate(target) - toDate(start)) / 86400000);
  if (dayDiff < 0) return false;
  switch (parts.FREQ) {
    case 'DAILY': return dayDiff % interval === 0;
    case 'WEEKLY': { const wd = Math.floor(dayDiff/7); if (wd % interval !== 0) return false; if (parts.BYDAY) return parts.BYDAY.split(',').includes(['SU','MO','TU','WE','TH','FR','SA'][toDate(target).getDay()]); return toDate(target).getDay() === toDate(start).getDay(); }
    case 'MONTHLY': { if (target.d !== start.d) return false; const md = (target.y-start.y)*12+(target.m-start.m); return md >= 0 && md % interval === 0; }
    case 'YEARLY': { if (target.m !== start.m || target.d !== start.d) return false; const yd = target.y-start.y; return yd >= 0 && yd % interval === 0; }
    default: return false;
  }
}
