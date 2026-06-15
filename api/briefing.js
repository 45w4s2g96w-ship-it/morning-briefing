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
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
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
      body: JSON.stringify({
        filter: { property: '날짜', date: { equals: yesterdayStr } },
        page_size: 1,
      }),
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

  const systemPrompt = `너는 사용자(민영)의 아침 브리핑을 작성하는 도우미야. 다음 형식을 정확히 지켜서 한국어로 작성해. 전체적으로 친절하고 전문적인 느낌이되, 존댓말이면서 아주 약간 캐주얼한 톤으로. 괄호나 기호 나열처럼 읽기 어색한 표현은 피해.

형식 (각 섹션은 빈 줄로 구분):
[WEATHER:날씨상태]
오늘 날씨입니다
(오늘 상쾌한 하루를 시작할 수 있도록 서울의 아침 날씨 상태와 어울리는 따뜻한 인사말, 기온, 외출 시 참고사항을 자연스러운 문장으로 생성해줘.)

오늘 일정입니다
(아래 제공되는 오늘 일정 목록을 자연스러운 문장으로 풀어서. 일정이 없으면 "등록된 일정이 없습니다.")

오늘 뉴스입니다
(뉴스 1) — 오늘 하루 참고하면 좋을 만한 가벼운 기술 트렌드, 일상 트렌드, 또는 긍정적인 인사이트 뉴스를 한두 문장으로 자연스럽게 설명해줘. 설명 문장 끝에 괄호로 가상의 출처 URL을 적어줘. 예: 설명 문장입니다. (https://example.com/article)

어제는 이런 하루를 보내셨네요
(어제 일기 요약을 1~2줄로 자연스럽게)
"그래도 이건 잘하셨어요 — " 뒤에 (어제 일기에서 구체적인 행동이나 태도 하나를 짚어서 진심으로 격려). 이 부분은 **굵게** 표시로 감싸줘.

오늘은 이렇게 해보는 게 어떨까요?
🏃 (구체적인 행동 제안 한 가지) 이러면 (예상되는 긍정적 변화)예요.

💭 (인지적 관점 전환 제안 한 가지) 이렇게 보면 (예상되는 변화)일 거예요.

규칙:
- 첫 줄은 반드시 "[WEATHER:날씨상태]" 형식으로 시작해. 날씨상태는 다음 중 하나만 골라 써야 해: 맑음, 구름조금, 흐림, 비, 눈, 천둥번개, 안개. 이 줄에는 이모지나 다른 텍스트를 절대 넣지 마.
- 기온은 반드시 섭씨(℃) 기준으로만 표기해.
- "오늘 일정" 섹션은 아래 제공되는 일정 목록을 자연스러운 문장으로 풀어서 작성해.
- 마지막 섹션의 🏃 줄과 💭 줄은 "행동:" "사고:" 같은 라벨을 쓰지 말고 이모지 바로 뒤에 내용으로 시작해.
- [WEATHER:날씨상태] 줄 이후에는 다른 어떤 줄에도 이모지를 쓰지 마 (🏃, 💭 제외).
- 출력은 [WEATHER:날씨상태] 줄을 포함한 위 형식 그대로만. 서두/설명 문구를 절대 추가하지 마.`;

  const userPrompt = `오늘(${todayStr}) 일정: ${todaySchedule || '(등록된 일정 없음)'}
어제(${yesterdayStr}) 일기 요약: ${diarySummary || '(없음)'}
어제 격려 메모: ${diaryEncourage || '(없음)'}
어제 제언 메모: ${diarySuggest || '(없음)'}
오늘(${todayStr}) 모닝 브리핑을 작성해줘.`;

  const briefingResult = await callGemini(GEMINI_API_KEY, systemPrompt, userPrompt);
  const briefingText = briefingResult.text || '(브리핑 생성 실패)';

  const titleLabel = formatDateKRWithDay(new Date(todayStr + 'T00:00:00'));
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
      console.error('existing blocks delete failed', e);
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
        properties: { '제목': { title: [{ text: { content: titleLabel } }] }, '날짜': { date: { start: todayStr } } },
        children: newBlocks,
      }),
    });
    const createData = await createRes.json();
    pageResult = { ok: createRes.ok, mode: 'created', pageId: createData.id, result: createData };
  }

  return { ok: pageResult.ok, todayStr, yesterdayStr, todaySchedule, briefingText, debug: briefingResult.debug, notion: pageResult };
}

async function callGemini(apiKey, systemPrompt, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 3000 }
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) return { text: '', debug: { stage: 'gemini_error', raw: data } };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const idx = text.indexOf('[WEATHER:');
    const finalText = idx >= 0 ? text.slice(idx) : text;
    return { text: finalText.trim(), debug: null };
  } catch (error) {
    return { text: '', debug: { stage: 'gemini_fetch_exception', error: String(error) } };
  }
}

function notionHeaders(token) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }; }
function getRichText(prop) { if (!prop) return ''; if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join(''); if (prop.title) return prop.title.map((t) => t.plain_text).join(''); return ''; }
function formatDateKRWithDay(d) { const days = ['일', '월', '화', '수', '목', '금', '토']; return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${days[d.getDay()]}요일`; }

const WEATHER_EMOJI_MAP = { '맑음': '☀️', '구름조금': '🌤️', '흐림': '☁️', '비': '🌧️', '눈': '❄️', '천둥번개': '⛈️', '안개': '🌫️' };

function buildBriefingBlocks(rawText) {
  const weatherMatch = rawText.match(/^\[WEATHER:([^\]]+)\]\s*\n?/);
  const weatherKey = weatherMatch ? weatherMatch[1].trim() : '';
  const weatherEmoji = WEATHER_EMOJI_MAP[weatherKey] || '🌤️';
  const text = weatherMatch ? rawText.slice(weatherMatch[0].length) : rawText;
  const lines = text.split('\n');
  const blocks = [];
  const sectionHeaderPatterns = [ { re: /^오늘 날씨입니다/, icon: weatherEmoji }, { re: /^오늘 일정입니다/, icon: '📅' }, { re: /^오늘 뉴스입니다/, icon: '📰' }, { re: /^어제는 이런 하루를/, icon: '☺️' } ];
  let currentSection = null; 
  function flushSection() {
    if (!currentSection) return;
    const richTextLines = buildRichTextLinesForCallout(currentSection.lines);
    blocks.push({ object: 'block', type: 'callout', callout: { rich_text: richTextLines, icon: { type: 'emoji', emoji: currentSection.icon || '💬' }, color: 'default' } });
    currentSection = null;
  }
  for (const line of lines) {
    if (line.length === 0) { if (currentSection) currentSection.lines.push(''); continue; }
    const isLastSectionHeader = /오늘.*이렇게.*해보는.*게/.test(line);
    const headerMatch = isLastSectionHeader ? { icon: '😉' } : sectionHeaderPatterns.find((p) => p.re.test(line));
    if (headerMatch || isLastSectionHeader) { flushSection(); currentSection = { icon: headerMatch ? headerMatch.icon : '😉', lines: [line] }; continue; }
    if (!currentSection) currentSection = { icon: '💬', lines: [] };
    currentSection.lines.push(line);
  }
  flushSection();
  const scriptText = buildScriptText(text);
  blocks.push({ object: 'block', type: 'toggle', toggle: { rich_text: [{ type: 'text', text: { content: '스크립트' } }], children: textLinesToParagraphBlocks(scriptText) } });
  return blocks.slice(0, 100);
}

function splitBoldMarkdown(line, extraAnnotations) {
  const parts = []; const regex = /\*\*(.+?)\*\*/g; let lastIndex = 0; let m;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > lastIndex) parts.push({ content: line.slice(lastIndex, m.index), bold: false });
    parts.push({ content: m[1], bold: true }); lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) parts.push({ content: line.slice(lastIndex), bold: false });
  if (parts.length === 0) parts.push({ content: line, bold: false });
  return parts.map((p) => {
    const annotations = {}; if (p.bold) annotations.bold = true;
    if (extraAnnotations) Object.assign(annotations, extraAnnotations);
    const obj = { type: 'text', text: { content: p.content } };
    if (Object.keys(annotations).length > 0) obj.annotations = annotations;
    return obj;
  });
}

function buildRichTextLinesForCallout(lines) {
  const paragraphs = []; let current = [];
  for (const line of lines) { if (line.length === 0) { if (current.length > 0) { paragraphs.push(current); current = []; } continue; } current.push(line); }
  if (current.length > 0) paragraphs.push(current);
  const richText = [];
  paragraphs.forEach((paraLines, pIdx) => {
    const sep = pIdx === 0 ? '' : '\n\n';
    if (paraLines.length === 1 && paraLines[0].trim() === '---') { richText.push({ type: 'text', text: { content: sep + '─────────────' } }); return; }
    if (pIdx === 0) { const headerText = paraLines.join(' '); const parts = splitBoldMarkdown(headerText, { bold: true, underline: true }); if (sep) richText.push({ type: 'text', text: { content: sep } }); richText.push(...parts); return; }
    paraLines.forEach((line, lineIdx) => {
      const lineSep = lineIdx === 0 ? sep : '\n\n'; const emojiMatch = line.match(/^(🏃|💭)(\s*)/);
      if (emojiMatch) { if (lineSep) richText.push({ type: 'text', text: { content: lineSep } }); richText.push({ type: 'text', text: { content: emojiMatch[1] }, annotations: { bold: true } }); const rest = line.slice(emojiMatch[0].length); richText.push(...splitBoldMarkdown((emojiMatch[2] || ' ') + rest, null)); return; }
      const joiner = lineIdx === 0 ? lineSep : ' '; if (joiner) richText.push({ type: 'text', text: { content: joiner } }); richText.push(...splitBoldMarkdown(line, null));
    });
  });
  return richText;
}

function textLinesToParagraphBlocks(text) {
  const lines = text.split('\n'); const blocks = [];
  for (const line of lines) { for (let i = 0; i < Math.max(line.length, 1); i += 2000) { const chunk = line.slice(i, i + 2000); blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: chunk ? [{ type: 'text', text: { content: chunk } }] : [] } }); if (line.length === 0) break; } }
  return blocks.slice(0, 100);
}

function buildScriptText(text) {
  const lines = text.split('\n');
  const cleanedLines = lines.map((line) => { if (line.trim() === '---') return ''; return line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\(https?:\/\/[^)]+\)\s*$/g, '').replace(/https?:\/\/\S+/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim(); });
  const paragraphs = []; let current = [];
  for (const line of cleanedLines) { if (line === '') { if (current.length > 0) { paragraphs.push(current.join(' ')); current = []; } continue; } current.push(line); }
  if (current.length > 0) paragraphs.push(current.join(' ')); return paragraphs.join('\n\n').trim();
}

async function fetchTodayEvents(icsUrls, todayStr) {
  if (!icsUrls) return '';
  const urls = icsUrls.split(',').map((u) => u.trim()).filter(Boolean); const events = [];
  for (const url of urls) { try { const res = await fetch(url); const icsText = await res.text(); events.push(...parseIcsForDate(icsText, todayStr)); } catch (e) { console.error('calendar fetch failed:', url, e); } }
  events.sort(); return events.map((e) => e.replace(/^\S+\|/, '')).join(', ');
}

function parseIcsForDate(icsText, todayStr) {
  const results = []; const veventBlocks = icsText.split('BEGIN:VEVENT').slice(1); const targetDate = parseYMD(todayStr);
  for (const rawBlock of veventBlocks) {
    const block = rawBlock.split('END:VEVENT')[0]; const summaryMatch = block.match(/SUMMARY:(.+)/); const dtStartMatch = block.match(/DTSTART(?:;[^:\r\n]*)?:(\d{8})(T(\d{6}))?(Z)?/);
    if (!summaryMatch || !dtStartMatch) continue;
    const summary = summaryMatch[1].trim(); const dateStr = dtStartMatch[1]; const timeStr = dtStartMatch[3]; const isUTC = !!dtStartMatch[4]; const eventStart = parseYMD(dateStr); const rruleMatch = block.match(/RRULE:(.+)/); const exdates = [...block.matchAll(/EXDATE(?:;[^:\r\n]*)?:(\d{8})/g)].map((m) => m[1]);
    let occurs = false;
    if (!rruleMatch) { occurs = dateStr === todayStr.replace(/-/g, ''); } else { if (compareYMD(targetDate, eventStart) < 0) { occurs = false; } else if (exdates.includes(todayStr.replace(/-/g, ''))) { occurs = false; } else { occurs = matchesRRule(rruleMatch[1], eventStart, targetDate); } }
    if (!occurs) continue;
    let timeLabel = '하루 종일'; let sortKey = '99:99';
    if (timeStr) { let hour = parseInt(timeStr.slice(0, 2), 10); const min = timeStr.slice(2, 4); if (isUTC) hour = (hour + 9) % 24; timeLabel = `${String(hour).padStart(2, '0')}:${min}`; sortKey = timeLabel; }
    results.push(`${sortKey}|${timeLabel} ${summary}`);
  }
  return results;
}

function parseYMD(str) { const s = str.replace(/-/g, ''); return { y: parseInt(s.slice(0, 4), 10), m: parseInt(s.slice(4, 6), 10), d: parseInt(s.slice(6, 8), 10) }; }
function compareYMD(a, b) { if (a.y !== b.y) return a.y - b.y; if (a.m !== b.m) return a.m - b.m; return a.d - b.d; }
function toDate(ymd) { return new Date(ymd.y, ymd.m - 1, ymd.d); }
function matchesRRule(rrule, start, target) {
  const parts = {}; for (const kv of rrule.split(';')) { const [k, v] = kv.split('='); parts[k] = v; }
  const freq = parts.FREQ; const interval = parseInt(parts.INTERVAL || '1', 10);
  if (parts.UNTIL) { const until = parseYMD(parts.UNTIL.slice(0, 8)); if (compareYMD(target, until) > 0) return false; }
  const startDate = toDate(start); const targetDate = toDate(target); const dayDiff = Math.round((targetDate - startDate) / 86400000); if (dayDiff < 0) return false;
  switch (freq) {
    case 'DAILY': return dayDiff % interval === 0;
    case 'WEEKLY': { const weekDiff = Math.floor(dayDiff / 7); if (weekDiff % interval !== 0) return false; if (parts.BYDAY) { const dayMap = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; return parts.BYDAY.split(',').includes(dayMap[targetDate.getDay()]); } return targetDate.getDay() === startDate.getDay(); }
    case 'MONTHLY': { if (target.d !== start.d) return false; const monthDiff = (target.y - start.y) * 12 + (target.m - start.m); return monthDiff >= 0 && monthDiff % interval === 0; }
    case 'YEARLY': { if (target.m !== start.m || target.d !== start.d) return false; const yearDiff = target.y - start.y; return yearDiff >= 0 && yearDiff % interval === 0; }
    default: return false;
  }
}
