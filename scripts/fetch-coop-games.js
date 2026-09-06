// scripts/fetch-coop-games.js
//
// GitHub Actions가 주기적으로 이 스크립트를 실행해서
// 스팀 협동 게임 데이터를 긁어와 data/coop-games.json 으로 저장한다.
// 이제 브라우저가 직접 스팀에 요청하지 않으므로 CORS 프록시가 필요 없다.

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const MAX_GAMES = 1500;            // 가져올 최대 게임 수
const PAGE_SIZE = 100;             // 검색 결과 페이지당 개수
const APPDETAILS_DELAY_MS = 1300;  // appdetails 호출 사이 지연 (레이트리밋 방지)
const MAX_GENRES_OUTPUT = 20;      // 장르 칩으로 보여줄 최대 개수 (많이 쓰인 순)

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchSearchPage(start) {
  const params = new URLSearchParams({
    query: '',
    start: String(start),
    count: String(PAGE_SIZE),
    category1: '998',  // 게임만
    category2: '9',    // 협동(Co-op) 전체
    infinite: '1',
    cc: 'kr',
    l: 'koreana',
    sort_by: 'Reviews_DESC',
  });
  const url = `https://store.steampowered.com/search/results/?${params.toString()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`검색 페이지 요청 실패: HTTP ${res.status}`);
  const data = await res.json();
  if (data.success !== 1) throw new Error('스팀 검색 응답 오류');
  return { html: data.results_html, total: data.total_count };
}

function parseSearchHtml(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('a.search_result_row').each((_, el) => {
    const row = $(el);
    const appid =
      row.attr('data-ds-appid') ||
      (row.attr('href') || '').match(/\/app\/(\d+)/)?.[1] ||
      '';
    if (!appid) return;

    const title = row.find('.title').text().trim() || '이름 없음';
    const released = row.find('.search_released').text().trim() || '';
    const img = row.find('img').attr('src') || '';

    const priceBlock = row.find('.search_price_discount_combined');
    let finalPriceCents = priceBlock.attr('data-price-final');
    finalPriceCents = finalPriceCents !== undefined ? parseInt(finalPriceCents, 10) : null;

    // 할인율 추출: 클래스명이 스팀 쪽에서 바뀌는 경우가 있어 span 텍스트를 먼저 시도하고,
    // 실패하면 행 전체 텍스트에서 "-20%" 같은 패턴을 정규식으로 직접 찾는다 (더 안전함).
    let discountPct = 0;
    const discountSpanText = row.find('.search_discount span').text();
    const discountMatch1 = discountSpanText.match(/(\d{1,2})\s*%/);
    if (discountMatch1) discountPct = parseInt(discountMatch1[1], 10);
    if (!discountPct) {
      const rowText = row.text();
      const discountMatch2 = rowText.match(/-\s*(\d{1,2})\s*%/);
      if (discountMatch2) discountPct = parseInt(discountMatch2[1], 10);
    }

    let origPriceText = '';
    const strike = row.find('.search_price strike');
    if (strike.length) origPriceText = strike.text().trim();
    if (!origPriceText && discountPct > 0 && finalPriceCents) {
      // strike 텍스트를 못 찾으면 할인율 기준으로 원가를 역산해서 표시용 텍스트를 만든다.
      const estimatedOriginal = Math.round(finalPriceCents / (1 - discountPct / 100));
      origPriceText = Math.round(estimatedOriginal / 100).toLocaleString('ko-KR') + '원';
    }

    const reviewEl = row.find('.search_reviewscore span[data-tooltip-html]');
    const tooltipRaw = reviewEl.attr('data-tooltip-html') || '';
    const reviewSummary = tooltipRaw.split('<br>')[0]?.trim() || '';
    const reviewCountMatch = tooltipRaw.match(/([\d,]+)\s*개의?\s*(?:평가|리뷰)/);
    const reviewCount = reviewCountMatch ? parseInt(reviewCountMatch[1].replace(/,/g, ''), 10) : 0;

    items.push({
      appid,
      title,
      released,
      img,
      finalPriceCents,
      discountPct,
      origPriceText,
      reviewSummary,
      reviewCount,
      url: `https://store.steampowered.com/app/${appid}/`,
    });
  });
  return items;
}

async function fetchAppDetails(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=kr&l=koreana`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data[appid];
    if (!entry || !entry.success || !entry.data) return null;
    return {
      categories: (entry.data.categories || []).map((c) => ({ id: c.id, description: c.description })),
      genres: (entry.data.genres || []).map((g) => ({ id: g.id, description: g.description })),
    };
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('스팀 협동 게임 목록 수집 시작...');
  let allItems = [];
  let start = 0;
  let total = Infinity;

  while (allItems.length < MAX_GAMES && start < total) {
    console.log(`검색 페이지 가져오는 중 (start=${start})...`);
    const { html, total: t } = await fetchSearchPage(start);
    total = t;
    const items = parseSearchHtml(html);
    if (items.length === 0) break;
    allItems = allItems.concat(items);
    start += PAGE_SIZE;
    await sleep(500);
  }

  allItems = allItems.slice(0, MAX_GAMES);
  console.log(`검색으로 ${allItems.length}개 게임 확보. 이제 각 게임의 장르/카테고리 정보를 가져옵니다...`);

  const coopCategoryCounts = new Map(); // id -> { description, count }
  const genreCounts = new Map();

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const details = await fetchAppDetails(item.appid);
    if (details) {
      item.categories = details.categories;
      item.genres = details.genres;

      details.categories.forEach((c) => {
        if (/협동|co-?op/i.test(c.description)) {
          const cur = coopCategoryCounts.get(c.id) || { description: c.description, count: 0 };
          cur.count += 1;
          coopCategoryCounts.set(c.id, cur);
        }
      });
      details.genres.forEach((g) => {
        const cur = genreCounts.get(g.id) || { description: g.description, count: 0 };
        cur.count += 1;
        genreCounts.set(g.id, cur);
      });
    } else {
      item.categories = [];
      item.genres = [];
    }
    if (i % 25 === 0) console.log(`  appdetails 진행: ${i}/${allItems.length}`);
    await sleep(APPDETAILS_DELAY_MS);
  }

  const coopCategories = [...coopCategoryCounts.entries()]
    .map(([id, v]) => ({ id, description: v.description, count: v.count }))
    .sort((a, b) => b.count - a.count);

  const genres = [...genreCounts.entries()]
    .map(([id, v]) => ({ id, description: v.description, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_GENRES_OUTPUT);

  const output = {
    generatedAt: new Date().toISOString(),
    games: allItems,
    coopCategories,
    genres,
  };

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'coop-games.json'), JSON.stringify(output));
  console.log(
    `완료: 게임 ${allItems.length}개, coop 카테고리 ${coopCategories.length}개, 장르 ${genres.length}개, 할인 중인 게임 ${allItems.filter(g=>g.discountPct>0).length}개`
  );
}

main().catch((e) => {
  console.error('스크립트 실행 실패:', e);
  process.exit(1);
});
