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

async function fetchGoogleNewsRSS() {
  try {
    const res = await fetch('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null && items.length < 20) {
      const block = m[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]?.trim();
      const desc = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (title && link) items.push({ title, link, desc: desc || '', source: source || '' });
    }
    return items;
  } catch (e) {
    console.error('RSS fetch failed', e);
    return [];
  }
}

async function fetchDiary(token, yesterdayStr) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DIARY_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: yesterdayStr } }, page_size: 1 }),
    });
    const data = await res.json();
    const page = data.results?.[0];
    if (!page) return { diarySummary: '', diarySuggest: '' };
    return {
      diarySummary: getRichText(page.properties['일기 요약']),
      diarySuggest: getRichText(page.properties['제언']),
    };
  } catch (e) {
    console.error('diary fetch failed', e);
    return { diarySummary: '', diarySuggest: '' };
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

  const [todaySchedule, diaryResult, newsItems] = await Promise.all([
    fetchTodayEvents(ICLOUD_CALENDAR_URLS, todayStr).catch(() => ''),
    fetchDiary(NOTION_TOKEN, yesterdayStr),
    fetchGoogleNewsRSS(),
  ]);

  const { diarySummary, diarySuggest } = diaryResult;

  const excludeSources = ['조선일보', '중앙일보', '동아일보', 'Chosun', 'JoongAng', 'Donga'];
  const newsText = newsItems
    .map((item, i) => `${i + 1}. [${item.source}] ${item.title}${item.desc ? ' / ' + item.desc : ''} / URL: ${item.link}`)
    .join('\n');
    
  // 요일 계산 로직 (에러 방지를 위해 여기서 한 번만 선언)
  const [y, mo, d] = todayStr.split('-').map(Number);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dow = new Date(y, mo - 1, d).getDay();
  const dayName = days[dow]; 
  const isWeekday = dow >= 1 && dow <= 5; // 월~금 여부

  const systemPrompt = `너는 민영의 아침 브리핑을 작성하는 비서야.

말투: 한국어, ~요/~입니다 자연스럽게 섞어서. 날씨 섹션은 기상캐스터처럼 ~입니다 위주. 나머지는 ~요와 ~입니다 번갈아 사용. ~하셨어요/~하실 같은 주체높임 전부 금지. ~십시오/~것입니다 금지. 이모지/구어체/마크다운 볼드 금지. 음성으로 읽힐 글이므로 괄호/기호 금지.

헤더 5개를 정확히 이 텍스트로 순서대로 작성:
오늘 날씨입니다
오늘 일정입니다
오늘 뉴스입니다
어제는 이런 하루를 보내셨네요
오늘은 이렇게 해보는 게 어떨까요

각 섹션 분량과 형식:
- 날씨: 250자 이내. 한 문단 3~4문장. 줄바꿈 없이. web_search로 오늘 서울 날씨를 섭씨 기준으로 검색. 검색 출처/단위 변환 과정 언급 절대 금지. 기상캐스터처럼 "서울은 오늘 최고기온 N도, 최저 N도로..." 형식으로 시작. 날씨 사실 먼저, 체감·생활 조언으로 마무리.
- 일정: 250자 이내. 시간순 자연스럽게. 종일 1개뿐이거나 없으면 일기 요약 참고해서 활동 추천 한 마디 덧붙일 것.
- 뉴스: 뉴스당 300자 이내, 총 600자 이내. 아래 기사 목록에서 ${excludeSources.join('/')} 제외하고 주요 시사 2개 선택. 연합뉴스에 따르면~과 같이 출처 표기는 금지. 각 뉴스마다 2~4문장 요약+배경설명, ~입니다로 종결. URL은 마지막 문장 바로 뒤 같은 줄에 괄호 문장 없이 그냥 붙일 것. 두 뉴스 사이 줄바꿈만, 빈 줄 없음.
- 어제: 300자 이내. 한 문단 3~4문장. 줄바꿈 없이. 요약+격려 포함.
- 오늘 제안: 400자 이내. 행동제안 3~4문장, 줄바꿈, 인지전환 3~4문장. 일기와 제언 참고해서 구체적으로.
[중요 규칙: 오늘이 평일(월~금)인데 일정이 없다면, 쉬는 날이 아니라 '평범하게 출근하는 날'로 간주하세요. 이 경우 출근 전 10분 동안 할 수 있는 간단한 리프레시 활동이나, 퇴근 후 저녁 시간을 기분 좋게 보낼 수 있는 소소한 일정을 제안해 주세요.]
전체 합계 1800자 이내.`;

  const userPrompt = `오늘(${todayStr}, ${dayName}요일) 일정: ${todaySchedule || '(없음)'}
어제(${yesterdayStr}) 일기 요약: ${diarySummary || '(없음)'}
어제 제언: ${diarySuggest || '(없음)'}

기사 목록:
${newsText || '(없음)'}

오늘 브리핑 작성해줘.`;

  const briefingResult = await callClaude(ANTHROPIC_API_KEY, systemPrompt, userPrompt);
  const briefingText = (briefingResult.text || '(브리핑 생성 실패)').replace(/\*\*/g, '').trim();

  // (수정된 부분) 위에서 구한 변수들을 재사용하여 제목 생성 (중복 선언 제거)
  const titleLabel = `${mo}월 ${d}일 ${dayName}요일 모닝 브리핑입니다.`;

  const newBlocks = buildBriefingBlocks(briefingText);

  let existingPageId = null;
  try {
    const searchRes = await fetch(`https://api.notion.com/v1/databases/${MORNING_BRIEFING_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(NOTION_TOKEN),
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: todayStr } }, page_size: 1 }),
    });
    existingPageId = (await searchRes.json()).results?.[0]?.id || null;
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
      const childrenData = await (await fetch(
        `https://api.notion.com/v1/blocks/${existingPageId}/children?page_size=100`,
        { headers: notionHeaders(NOTION_TOKEN) }
      )).json();
      for (const block of (childrenData.results || [])) {
        await fetch(`https://api.notion.com/v1/blocks/${block.id}`, { method: 'DELETE', headers: notionHeaders(NOTION_TOKEN) });
      }
    } catch (e) { console.error('update failed', e); }
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
    pageResult = { ok: createRes.ok, mode: 'created', pageId: (await createRes.json()).id };
  }

  return { ok: pageResult.ok, todayStr, briefingText, debug: briefingResult.debug, notion: pageResult };
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
          max_tokens: 2200,
          system: systemPrompt,
          messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) return { text: '', debug: { stage: 'claude_error', raw: data } };
      const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);
      if (data.stop_reason !== 'tool_use') { finalText = textBlocks.join('\n').trim(); break; }
      messages.push({
        role: 'assistant',
        content: (data.content || []).map((b) => b.type === 'tool_result' ? { ...b, content: '(검색 완료)' } : b)
      });
    }
    return { text: finalText.trim(), debug: null };
  } catch (error) {
    return { text: '', debug: { stage: 'claude_exception', error: String(error) } };
  }
}

function notionHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' };
}
function getRichText(prop) {
  if (!prop) return '';
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join('');
  if (prop.title) return prop.title.map((t) => t.plain_text).join('');
  return '';
}
function dividerBlock() { return { object: 'block', type: 'divider', divider: {} }; }
function titleParagraph(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text }, annotations: { bold: true, underline: true } }] } };
}
function bodyParagraph(line) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: line } }] } };
}
function linkParagraph(text, url) {
  return {
    object: 'block', type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: text + ' ' } },
        { type: 'text', text: { content: '🔗', link: { url } } }
      ]
    }
  };
}
function parseNewsLine(line) {
  const m1 = line.match(/^(.*?)\s*\((https?:\/\/[^\s)]+)\)\s*$/);
  if (m1) return { text: m1[1].trim(), url: m1[2] };
  const m2 = line.match(/^(.*?)\s*(https?:\/\/\S+)\s*$/);
  if (m2) return { text: m2[1].trim(), url: m2[2] };
  return { text: line, url: null };
}
function normalizeNewsBody(cleanedBody) {
  const lines = cleanedBody.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  let current = [];
  for (const line of lines) {
    current.push(line);
    if (/https?:\/\/\S+/.test(line)) {
      items.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) {
    if (items.length) items[items.length - 1] += ' ' + current.join(' ');
    else items.push(current.join(' '));
  }
  return items.filter(Boolean).join('\n');
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
    let cleanedBody = (next
      ? rawText.slice(current.pos + current.token.sub.length, next.pos)
      : rawText.slice(current.pos + current.token.sub.length)
    ).trim();
    if (current.token.sub === '어제는 이런 하루를' && cleanedBody.startsWith('보내셨네요'))
      cleanedBody = cleanedBody.slice('보내셨네요'.length).trim();
    if (current.token.sub === '오늘은 이렇게 해보는 게') {
      if (cleanedBody.startsWith('어떨까요?')) cleanedBody = cleanedBody.slice('어떨까요?'.length).trim();
      else if (cleanedBody.startsWith('어떨까요')) cleanedBody = cleanedBody.slice('어떨까요'.length).trim();
    }
    if (current.token.sub === '오늘 날씨입니다')
      cleanedBody = cleanedBody.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    if (current.token.sub === '오늘 뉴스입니다')
      cleanedBody = normalizeNewsBody(cleanedBody);
    blocks.push(titleParagraph(current.token.official));
    for (const line of cleanedBody.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const { text, url } = parseNewsLine(trimmed);
      if (url) blocks.push(linkParagraph(text, url));
      else blocks.push(bodyParagraph(trimmed));
    }
    while (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      const rt = last.type === 'paragraph' ? last.paragraph.rich_text : null;
      if (rt && (rt.length === 0 || (rt.length === 1 && ['', '\u200b'].includes(rt[0]?.text?.content?.trim()))))
        blocks.pop();
      else break;
    }
  }
  return blocks.slice(0, 100);
}

async function fetchTodayEvents(icsUrls, todayStr) {
  if (!icsUrls) return '';
  const events = [];
  for (const url of icsUrls.split(',').map((u) => u.trim()).filter(Boolean)) {
    try { events.push(...parseIcsForDate(await (await fetch(url)).text(), todayStr)); }
    catch (e) { console.error('calendar fetch failed:', url, e); }
  }
  events.sort((a, b) => {
    const [aK, aT] = a.split('|');
    const [bK, bT] = b.split('|');
    return aT !== bT ? aT.localeCompare(bT) : aK.localeCompare(bK);
  });
  return events.map((e) => e.split('|').slice(2).join('|')).join(', ');
}
function parseIcsForDate(icsText, todayStr) {
  const results = [], targetDate = parseYMD(todayStr);
  for (const rawBlock of icsText.split('BEGIN:VEVENT').slice(1)) {
    const block = rawBlock.split('END:VEVENT')[0];
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const dtStartMatch = block.match(/DTSTART(?:;[^:\r\n]*)?:(\d{8})(T(\d{6}))?(Z)?/);
    if (!summaryMatch || !dtStartMatch) continue;
    const summary = summaryMatch[1].trim();
    const dateStr = dtStartMatch[1], timeStr = dtStartMatch[3], isUTC = !!dtStartMatch[4];
    const eventStart = parseYMD(dateStr);
    const rruleMatch = block.match(/RRULE:(.+)/);
    const exdates = [...block.matchAll(/EXDATE(?:;[^:\r\n]*)?:(\d{8})/g)].map((m) => m[1]);
    const occurs = !rruleMatch
      ? dateStr === todayStr.replace(/-/g, '')
      : compareYMD(targetDate, eventStart) >= 0 && !exdates.includes(todayStr.replace(/-/g, '')) && matchesRRule(rruleMatch[1], eventStart, targetDate);
    if (!occurs) continue;
    let timeLabel = '하루 종일', sortKey = '00:00', dayInfo = '';
    if (timeStr) {
      let hour = parseInt(timeStr.slice(0, 2), 10);
      if (isUTC) hour = (hour + 9) % 24;
      timeLabel = sortKey = `${String(hour).padStart(2, '0')}:${timeStr.slice(2, 4)}`;
    } else {
      const dayNum = Math.round((toDate(targetDate) - toDate(eventStart)) / 86400000) + 1;
      if (dayNum >= 2) dayInfo = ` (${dayNum}일차)`;
    }
    results.push(`${sortKey}|${timeStr ? '1' : '0'}|${timeLabel} ${summary}${dayInfo}`);
  }
  return results;
}
function parseYMD(str) { const s = str.replace(/-/g, ''); return { y: +s.slice(0, 4), m: +s.slice(4, 6), d: +s.slice(6, 8) }; }
function compareYMD(a, b) { return a.y !== b.y ? a.y - b.y : a.m !== b.m ? a.m - b.m : a.d - b.d; }
function toDate(ymd) { return new Date(ymd.y, ymd.m - 1, ymd.d); }
function matchesRRule(rrule, start, target) {
  const parts = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=')));
  const interval = +(parts.INTERVAL || 1);
  if (parts.UNTIL && compareYMD(target, parseYMD(parts.UNTIL.slice(0, 8))) > 0) return false;
  const dayDiff = Math.round((toDate(target) - toDate(start)) / 86400000);
  if (dayDiff < 0) return false;
  switch (parts.FREQ) {
    case 'DAILY': return dayDiff % interval === 0;
    case 'WEEKLY': {
      const wd = Math.floor(dayDiff / 7);
      if (wd % interval !== 0) return false;
      return parts.BYDAY
        ? parts.BYDAY.split(',').includes(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][toDate(target).getDay()])
        : toDate(target).getDay() === toDate(start).getDay();
    }
    case 'MONTHLY': {
      if (target.d !== start.d) return false;
      const md = (target.y - start.y) * 12 + (target.m - start.m);
      return md >= 0 && md % interval === 0;
    }
    case 'YEARLY': {
      if (target.m !== start.m || target.d !== start.d) return false;
      const yd = target.y - start.y;
      return yd >= 0 && yd % interval === 0;
    }
    default: return false;
  }
}
