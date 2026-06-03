/**
 * Sri Lanka Credit Card Offers Scraper v2
 * - Strict validation: rejects navigation text, empty titles, junk URLs
 * - Only saves offers with real titles, real discounts, valid bank URLs
 * - Falls back to keeping existing offers.json if scrape yields too few results
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Validation ──────────────────────────────────────────────────────────────
const JUNK_TITLES = [
  'looking for something','no promotions','close','filters','best offer',
  'up to','load more','see more','view more','show more','next','previous',
  'page','home','menu','search','login','register','apply','contact',
  'terms','conditions','privacy','cookie','back to','read more',
  'click here','learn more','find out','discover','explore','get started',
  'sign up','log in','download','subscribe','follow us','share',
  'facebook','twitter','instagram','youtube','linkedin',
  'copyright','all rights reserved','powered by',
];

const JUNK_URLS = [
  'calendar.google.com','cbsl.gov.lk','drive.google.com',
  'facebook.com','twitter.com','instagram.com','youtube.com',
  'linkedin.com','play.google.com','apps.apple.com',
];

function isValidOffer(o) {
  if (!o.title || o.title.length < 8) return false;
  if (!o.bank || !o.url) return false;

  // Reject junk titles
  const tl = o.title.toLowerCase().trim();
  if (JUNK_TITLES.some(j => tl.startsWith(j) || tl === j)) return false;

  // Reject if title is just punctuation or numbers
  if (!/[a-zA-Z]{4,}/.test(o.title)) return false;

  // Reject junk URLs
  if (JUNK_URLS.some(j => o.url.includes(j))) return false;

  // Must have a real discount or description
  if (!o.disc || o.disc === 'Special offer') {
    // Allow if desc has useful content
    if (!o.desc || o.desc.length < 20) return false;
  }

  return true;
}

function clean(s, maxLen = 400) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseExpiry(text) {
  if (!text) return defaultExpiry();
  const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const pats = [
    /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/,
    /(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/,
    /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,]+(\d{4})/i,
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})[,\s]+(\d{4})/i,
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})/i,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (!m) continue;
    try {
      let d, mo, y;
      if (p.source.startsWith('(\\d{4})')) { y=+m[1]; mo=+m[2]; d=+m[3]; }
      else if (p.source.includes('\\s+(jan')) { d=+m[1]; mo=months[m[2].toLowerCase().slice(0,3)]; y=+m[3]; }
      else if (p.source.startsWith('(jan') && m[3]) { mo=months[m[1].toLowerCase().slice(0,3)]; d=+m[2]; y=+m[3]; }
      else if (p.source.startsWith('(jan')) { mo=months[m[1].toLowerCase().slice(0,3)]; y=+m[2]; d=28; }
      else { d=+m[1]; mo=+m[2]; y=+m[3]; }
      if (y>2020&&mo>=1&&mo<=12&&d>=1&&d<=31)
        return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    } catch(e) {}
  }
  return defaultExpiry();
}

function defaultExpiry() {
  const d = new Date();
  d.setMonth(d.getMonth() + 3);
  return d.toISOString().slice(0,10);
}

function guessCat(text) {
  const t = (text||'').toLowerCase();
  if (/restaurant|dining|food|eat|buffet|lunch|dinner|café|cafe|bar|pub|pizza|burger|kfc|dine/.test(t)) return 'Dining';
  if (/hotel|resort|villa|stay|room|travel|flight|airline|tour|holiday|vacation|overseas|airport|lounge/.test(t)) return 'Travel';
  if (/supermarket|grocery|keells|cargills|glomark|arpico|spar|fresh veg|fresh fruit|seafood/.test(t)) return 'Supermarket';
  if (/fashion|cloth|apparel|jewel|watch|gold|salon|spa|beauty|lifestyle/.test(t)) return 'Shopping';
  if (/health|hospital|medical|clinic|pharma|wellness|vision|eye|dental|hearing/.test(t)) return 'Health';
  if (/fuel|petrol|diesel|ioc|ceypetco/.test(t)) return 'Fuel';
  if (/instalment|ipp|0%|zero interest|epp|payment plan|interest.?free|solar|education|insurance/.test(t)) return 'Instalment';
  if (/online|e-commerce|digital|web|app|delivery/.test(t)) return 'Online';
  if (/reward|point|miles|loyalty|cashback|redeem/.test(t)) return 'Rewards';
  if (/electronic|gadget|laptop|mobile|appliance/.test(t)) return 'Shopping';
  return 'Other';
}

function dedupe(offers) {
  const seen = new Set();
  return offers.filter(o => {
    const key = `${o.bank}|${o.title.toLowerCase().trim().slice(0,50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Browser helpers ─────────────────────────────────────────────────────────
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultTimeout(30000);
  return page;
}

async function goto(page, url, wait = 3000) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(wait);
  } catch(e) {
    console.warn(`  ⚠ Timeout: ${url}`);
    await delay(1000);
  }
}

// ── Extract offers from a page ───────────────────────────────────────────────
async function extractOffers(page, bank, cat, fallbackUrl) {
  return page.evaluate((bank, cat, fallbackUrl) => {
    const results = [];
    const cards = document.querySelectorAll([
      '.offer-card','.promo-card','.promotion-card','.promo-item',
      '.promotion-item','.offer-item','article.offer','article.promo',
      '[class*="offer-card"]','[class*="promo-card"]',
      '[class*="promotion-item"]','[class*="offer-item"]',
    ].join(','));

    cards.forEach(card => {
      const title  = (card.querySelector('h1,h2,h3,h4,.title,.offer-title,.promo-title,.heading') || {}).innerText?.trim() || '';
      const desc   = (card.querySelector('p,.desc,.description,.content,.body,.text') || {}).innerText?.trim() || '';
      const disc   = (card.querySelector('.discount,.saving,.off,.badge,.percent,.highlight,.tag,.label') || {}).innerText?.trim() || '';
      const expiry = (card.querySelector('.expiry,.validity,.valid,.till,.until,.date,.period,.valid-till') || {}).innerText?.trim() || '';
      const link   = (card.querySelector('a[href]') || {}).href || fallbackUrl;
      if (title.length > 7) results.push({ bank, cat, title, desc, disc, expiry, url: link });
    });
    return results;
  }, bank, cat, fallbackUrl);
}

// ════════════════════════════════════════════════════════
// NDB — category pages
// ════════════════════════════════════════════════════════
async function scrapeNDB(browser) {
  console.log('📦 NDB...');
  const offers = [];
  const cats = [
    ['restaurants-pubs','Dining'],['supermarkets','Supermarket'],
    ['hotels-villas','Travel'],['special-ipp-promotions','Instalment'],
    ['wellness-beautycare','Health'],['online-stores','Online'],
    ['travel-transport','Travel'],['education','Instalment'],
    ['automobile','Other'],['fashion-lifestyle','Shopping'],
    ['hospitals-healthcare','Health'],['jewellery-watches','Shopping'],
  ];
  for (const [slug, cat] of cats) {
    const url = `https://www.ndbbank.com/cards/card-offers/${slug}`;
    const page = await newPage(browser);
    await goto(page, url, 3000);
    try {
      const items = await extractOffers(page, 'NDB', cat, url);
      offers.push(...items);
    } catch(e) {}
    await page.close();
    await delay(600);
  }
  console.log(`  ✓ NDB raw: ${offers.length}`);
  return offers;
}

// ════════════════════════════════════════════════════════
// Seylan — 22 categories, multi-page
// ════════════════════════════════════════════════════════
async function scrapeSeylan(browser) {
  console.log('📦 Seylan...');
  const offers = [];
  const cats = [
    ['cracker-deals','Shopping'],['lifestyle','Shopping'],['dining','Dining'],
    ['local-travel','Travel'],['eye-care','Health'],['special-promotions','Other'],
    ['overseas-travel','Travel'],['auto','Other'],['wellness','Health'],
    ['online-deals','Online'],['health','Health'],['supermarket','Supermarket'],
    ['education','Instalment'],['insurance','Instalment'],['pay-plans','Instalment'],
    ['electronics','Shopping'],['kiddies','Shopping'],['salon-spa','Shopping'],
    ['jewelry','Shopping'],['solar','Instalment'],['harasara','Other'],
  ];

  for (const [slug, cat] of cats) {
    let pageNum = 1;
    while (pageNum <= 10) {
      const url = `https://www.seylan.lk/promotions/cards/${slug}?page=${pageNum}`;
      const page = await newPage(browser);
      await goto(page, url, 3500);
      try {
        // Get offer detail links
        const links = await page.evaluate((slug) => {
          return [...new Set(
            [...document.querySelectorAll('a[href]')]
              .map(a => a.href)
              .filter(h =>
                h.includes('seylan.lk/promotions') &&
                !h.match(/\/cards\/(cracker-deals|lifestyle|dining|local-travel|eye-care|special-promotions|overseas-travel|auto|wellness|online-deals|health|supermarket|education|insurance|pay-plans|electronics|kiddies|salon-spa|jewelry|solar|harasara)\/?(\?.*)?$/) &&
                !h.includes('?type') &&
                h.split('/').length > 5
              )
          )].slice(0, 20);
        }, slug);

        let hasNext = false;
        if (links.length > 0) {
          await page.close();
          for (const link of links) {
            const dp = await newPage(browser);
            await goto(dp, link, 2500);
            try {
              const detail = await dp.evaluate(() => {
                const title  = (document.querySelector('h1,.offer-title,.page-title,.promo-title') || {}).innerText?.trim() || document.title?.split('|')[0]?.trim() || '';
                const paras  = [...document.querySelectorAll('main p,.offer-body p,.content p,.description p')].map(p => p.innerText?.trim()).filter(Boolean);
                const desc   = paras.slice(0,3).join(' ').slice(0,400);
                const disc   = (document.querySelector('.discount,.saving,.badge,.off,.percent,.highlight') || {}).innerText?.trim() || '';
                const body   = document.body?.innerText || '';
                const em     = body.match(/valid.*?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+\d{4})/i);
                return { title, desc: desc || body.slice(0,300).replace(/\s+/g,' ').trim(), disc, expiry: em ? em[1] : '' };
              });
              if (detail.title?.length > 7) {
                offers.push({ bank:'Seylan', cat, title:detail.title, desc:detail.desc, disc:detail.disc||'', expiry:detail.expiry, url:link });
              }
            } catch(e) {}
            await dp.close();
            await delay(400);
          }
        } else {
          // Try direct card extraction
          const items = await extractOffers(page, 'Seylan', cat, url);
          offers.push(...items);
          hasNext = await page.evaluate(() => !!document.querySelector('a[rel="next"],.pagination .next:not(.disabled)'));
          await page.close();
        }

        if (!hasNext || links.length === 0) break;
        pageNum++;
      } catch(e) {
        await page.close();
        break;
      }
      await delay(600);
    }
  }
  console.log(`  ✓ Seylan raw: ${offers.length}`);
  return offers;
}

// ════════════════════════════════════════════════════════
// NTB — category pages
// ════════════════════════════════════════════════════════
async function scrapeNTB(browser) {
  console.log('📦 NTB...');
  const offers = [];
  const cats = [
    ['dining','Dining'],['hotels-resorts','Travel'],['online','Online'],
    ['wellness','Health'],['shopping','Shopping'],['supermarkets','Supermarket'],
    ['travel','Travel'],['other','Other'],
  ];
  for (const [slug, cat] of cats) {
    const url = `https://www.nationstrust.com/promotions/${slug}`;
    const page = await newPage(browser);
    await goto(page, url, 3000);
    try {
      const items = await extractOffers(page, 'NTB', cat, url);
      offers.push(...items);
    } catch(e) {}
    await page.close();
    await delay(600);
  }
  console.log(`  ✓ NTB raw: ${offers.length}`);
  return offers;
}

// ════════════════════════════════════════════════════════
// BOC — category + product pages
// ════════════════════════════════════════════════════════
async function scrapeBOC(browser) {
  console.log('📦 BOC...');
  const offers = [];
  const cats = [
    ['supermarkets','Supermarket'],['dining','Dining'],
    ['travel-and-leisure','Travel'],['fashion','Shopping'],
    ['zero-plans','Instalment'],['wellness','Health'],
  ];
  for (const [slug, cat] of cats) {
    const url = `https://www.boc.lk/personal-banking/card-offers/${slug}`;
    const page = await newPage(browser);
    await goto(page, url, 3000);
    try {
      const subLinks = await page.evaluate(() =>
        [...new Set([...document.querySelectorAll('a[href*="/product"]')].map(a=>a.href))].slice(0,20)
      );
      await page.close();
      if (subLinks.length > 0) {
        for (const subUrl of subLinks) {
          const sp = await newPage(browser);
          await goto(sp, subUrl, 2000);
          try {
            const detail = await sp.evaluate(() => ({
              title:  (document.querySelector('h1,.offer-title,.page-title')||{}).innerText?.trim() || document.title?.split('|')[0]?.trim() || '',
              desc:   [...document.querySelectorAll('.offer-body p,.content p,main p')].map(p=>p.innerText?.trim()).filter(Boolean).join(' ').slice(0,400),
              disc:   (document.querySelector('.discount,.saving,.badge,.off')||{}).innerText?.trim() || '',
              expiry: (document.querySelector('.expiry,.validity,.valid-till')||{}).innerText?.trim() || '',
            }));
            if (detail.title?.length > 7)
              offers.push({ bank:'BOC', cat, title:detail.title, desc:detail.desc, disc:detail.disc||'', expiry:detail.expiry, url:subUrl });
          } catch(e) {}
          await sp.close();
          await delay(400);
        }
      } else {
        const items = await extractOffers(page, 'BOC', cat, url);
        offers.push(...items);
        await page.close();
      }
    } catch(e) {
      try { await page.close(); } catch(e2) {}
    }
    await delay(600);
  }
  console.log(`  ✓ BOC raw: ${offers.length}`);
  return offers;
}

// ════════════════════════════════════════════════════════
// ComBank — load more button
// ════════════════════════════════════════════════════════
async function scrapeComBank(browser) {
  console.log('📦 ComBank...');
  const url = 'https://www.combank.lk/rewards-promotions';
  const page = await newPage(browser);
  await goto(page, url, 4000);
  const offers = [];
  try {
    for (let i = 0; i < 15; i++) {
      const btn = await page.$('.load-more,button[class*="load"],.view-more,.show-more,[class*="loadMore"]');
      if (!btn) break;
      try { await btn.click(); await delay(2500); } catch(e) { break; }
    }
    const items = await extractOffers(page, 'ComBank', 'Other', url);
    offers.push(...items.map(o => ({ ...o, cat: guessCat(o.title+' '+o.desc) })));
  } catch(e) {}
  await page.close();
  console.log(`  ✓ ComBank raw: ${offers.length}`);
  return offers;
}

// ════════════════════════════════════════════════════════
// HNB — click load more until disabled
// ════════════════════════════════════════════════════════
async function scrapeHNB(browser) {
  console.log('📦 HNB...');
  const url = 'https://www.hnb.lk/card-promotion';
  const page = await newPage(browser);
  await goto(page, url, 5000);
  const offers = [];
  try {
    for (let i = 0; i < 30; i++) {
      const btn = await page.$('button.load-more,.load-more-btn,[class*="loadMore"],.see-more');
      if (!btn) break;
      const disabled = await page.evaluate(b => b.disabled || b.classList.contains('disabled'), btn);
      if (disabled) break;
      try { await btn.click(); await delay(2500); } catch(e) { break; }
    }
    const items = await extractOffers(page, 'HNB', 'Other', url);
    offers.push(...items.map(o => ({ ...o, cat: guessCat(o.title+' '+o.desc) })));
  } catch(e) {}
  await page.close();
  console.log(`  ✓ HNB raw: ${offers.length}`);
  return offers;
}

// ════════════════════════════════════════════════════════
// Generic scraper for remaining banks
// ════════════════════════════════════════════════════════
async function scrapeGeneric(browser, bank, url) {
  console.log(`📦 ${bank}...`);
  const page = await newPage(browser);
  await goto(page, url, 4000);
  const offers = [];
  try {
    const items = await extractOffers(page, bank, 'Other', url);
    offers.push(...items.map(o => ({ ...o, cat: guessCat(o.title+' '+o.desc) })));
  } catch(e) {}
  await page.close();
  console.log(`  ✓ ${bank} raw: ${offers.length}`);
  return offers;
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
async function main() {
  console.log('🚀 Sri Lanka Card Offers Scraper v2');
  console.log('=====================================');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  let raw = [];
  const scrapers = [
    () => scrapeNDB(browser),
    () => scrapeSeylan(browser),
    () => scrapeNTB(browser),
    () => scrapeBOC(browser),
    () => scrapeComBank(browser),
    () => scrapeHNB(browser),
    () => scrapeGeneric(browser, 'DFCC',               'https://www.dfcc.lk/cards/credit-card-offers'),
    () => scrapeGeneric(browser, "People's",            'https://www.peoplesbank.lk/special-offers/'),
    () => scrapeGeneric(browser, 'Sampath',             'https://www.sampath.lk/sampath-cards/credit-card-offer'),
    () => scrapeGeneric(browser, 'Pan Asia',            'https://www.pabcbank.com/card-offers/'),
    () => scrapeGeneric(browser, 'Cargills',            'https://www.cargillsbank.com/promotions'),
    () => scrapeGeneric(browser, 'CDB',                 'https://www.cdb.lk/cdb-offers'),
    () => scrapeGeneric(browser, 'Standard Chartered',  'https://www.sc.com/lk/promotions/'),
  ];

  for (const scraper of scrapers) {
    try { raw.push(...await scraper()); }
    catch(e) { console.error('Scraper error:', e.message); }
    await delay(800);
  }
  await browser.close();

  // ── Strict validation ──
  const valid = dedupe(raw.filter(isValidOffer)).map((o, i) => ({
    id: i + 1,
    bank:   clean(o.bank),
    cat:    clean(o.cat),
    title:  clean(o.title, 150),
    desc:   clean(o.desc, 400),
    disc:   clean(o.disc || guessCat(o.title) || 'Special offer', 80),
    expiry: parseExpiry(o.expiry),
    url:    clean(o.url, 300),
  }));

  console.log(`\n✅ Raw: ${raw.length} → Valid: ${valid.length}`);

  // ── Safety check: only save if we got enough real offers ──
  const MIN_OFFERS = 80;
  if (valid.length < MIN_OFFERS) {
    console.log(`⚠️  Only ${valid.length} valid offers — below minimum ${MIN_OFFERS}.`);
    console.log('   Keeping existing offers.json to avoid overwriting good data.');
    process.exit(0);
  }

  const byBank = {};
  valid.forEach(o => byBank[o.bank] = (byBank[o.bank]||0)+1);
  Object.entries(byBank).sort().forEach(([b,n]) => console.log(`   ${b}: ${n}`));

  fs.writeFileSync(
    path.join(__dirname, 'offers.json'),
    JSON.stringify(valid, null, 2)
  );
  console.log('💾 Saved scraper/offers.json');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
