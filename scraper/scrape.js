/**
 * Sri Lanka Credit Card Offers Scraper v3
 * Based on bank-provided extraction specifications
 *
 * Bank behaviours:
 * - NDB:          Category pages with pagination (next page buttons)
 * - ComBank:      Single page, multiple category sections
 * - Seylan:       Category pages with pagination (6 per page)
 * - NTB:          Category pages (no pagination, single page per category)
 * - BOC:          Category pages with "Load More" button
 * - People's Bank: Category pages (no pagination, single page per category)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Browser helpers ──────────────────────────────────────────────────────────
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

// ── Validation ───────────────────────────────────────────────────────────────
const JUNK = [
  'looking for','no promotion','close','filters','best offer','load more',
  'see more','view more','show more','next','previous','page','home','menu',
  'search','login','register','apply','contact','terms','conditions','privacy',
  'cookie','back to','read more','click here','learn more','find out',
  'discover','explore','get started','sign up','log in','download','subscribe',
  'follow us','share','facebook','twitter','instagram','youtube','linkedin',
  'copyright','all rights reserved','powered by','there are no promotion',
  'no offer','coming soon',
];

const JUNK_URLS = [
  'calendar.google','cbsl.gov','drive.google','facebook.com',
  'twitter.com','instagram.com','youtube.com','linkedin.com',
];

function isValid(o) {
  if (!o.title || o.title.length < 8) return false;
  if (!o.bank) return false;
  const tl = o.title.toLowerCase().trim();
  if (JUNK.some(j => tl.startsWith(j) || tl === j)) return false;
  if (!/[a-zA-Z]{4,}/.test(o.title)) return false;
  if (o.url && JUNK_URLS.some(j => o.url.includes(j))) return false;
  return true;
}

function clean(s, max = 400) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function guessCat(text) {
  const t = (text || '').toLowerCase();
  if (/restaurant|dining|food|eat|buffet|lunch|dinner|café|cafe|bar|pub|pizza|burger|dine/.test(t)) return 'Dining';
  if (/hotel|resort|villa|stay|room|flight|airline|tour|holiday|vacation|overseas|airport|lounge|travel/.test(t)) return 'Travel';
  if (/supermarket|grocery|keells|cargills|glomark|arpico|spar|fresh veg|fresh fruit/.test(t)) return 'Supermarket';
  if (/fashion|cloth|apparel|jewel|watch|gold|salon|spa|beauty|lifestyle|kiddies|kid|electron/.test(t)) return 'Shopping';
  if (/health|hospital|medical|clinic|pharma|wellness|vision|eye|dental|hearing/.test(t)) return 'Health';
  if (/fuel|petrol|diesel|ioc|ceypetco/.test(t)) return 'Fuel';
  if (/instalment|ipp|0%|zero interest|epp|payment plan|interest.?free|solar|education|insurance|utility|pay plan/.test(t)) return 'Instalment';
  if (/online|e-commerce|digital|web|app|delivery/.test(t)) return 'Online';
  if (/reward|point|miles|loyalty|cashback|redeem/.test(t)) return 'Rewards';
  if (/automobile|auto|car|vehicle|motor/.test(t)) return 'Other';
  return 'Other';
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

function dedupe(offers) {
  const seen = new Set();
  return offers.filter(o => {
    const key = `${o.bank}|${(o.title||'').toLowerCase().trim().slice(0,60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Extract offer cards from a page ──────────────────────────────────────────
async function extractCards(page, bank, cat, fallbackUrl) {
  return page.evaluate((bank, cat, fallbackUrl) => {
    const selectors = [
      '.offer-card','.promo-card','.promotion-card','.promo-item',
      '.promotion-item','.offer-item','[class*="offer-card"]',
      '[class*="promo-card"]','[class*="promotion-item"]',
      '[class*="offer-item"]','.card-offer','.promotion',
    ];
    const cards = document.querySelectorAll(selectors.join(','));
    const results = [];
    cards.forEach(card => {
      const title  = (card.querySelector('h1,h2,h3,h4,.title,.offer-title,.promo-title,.heading,.name') || {}).innerText?.trim() || '';
      const desc   = (card.querySelector('p,.desc,.description,.content,.body,.text,.offer-desc') || {}).innerText?.trim() || '';
      const disc   = (card.querySelector('.discount,.saving,.off,.badge,.percent,.highlight,.tag,.label,.benefit') || {}).innerText?.trim() || '';
      const expiry = (card.querySelector('.expiry,.validity,.valid,.till,.until,.date,.period,.valid-till,.valid-date') || {}).innerText?.trim() || '';
      const link   = (card.querySelector('a[href]') || {}).href || fallbackUrl;
      if (title.length > 7) results.push({ bank, cat, title, desc, disc, expiry, url: link });
    });
    return results;
  }, bank, cat, fallbackUrl);
}

// ── Scrape detail page ────────────────────────────────────────────────────────
async function scrapeDetail(browser, url) {
  const page = await newPage(browser);
  await goto(page, url, 2500);
  try {
    const detail = await page.evaluate(() => {
      const title  = (document.querySelector('h1,.offer-title,.page-title,.promo-title,.heading-title') || {}).innerText?.trim()
                   || document.title?.split('|')[0]?.trim() || '';
      const paras  = [...document.querySelectorAll('main p,.offer-body p,.content p,.description p,.promo-content p')].map(p => p.innerText?.trim()).filter(Boolean);
      const desc   = paras.slice(0,4).join(' ').slice(0,500);
      const disc   = (document.querySelector('.discount,.saving,.badge,.off,.percent,.highlight,.benefit') || {}).innerText?.trim() || '';
      const body   = document.body?.innerText || '';
      const em     = body.match(/valid.*?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+\d{4})/i);
      const expiry = em ? em[1] : '';
      return { title, desc: desc || body.slice(0,400).replace(/\s+/g,' ').trim(), disc, expiry };
    });
    await page.close();
    return detail;
  } catch(e) {
    await page.close();
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// NDB BANK
// Spec: Category pages with pagination. Must follow all pages until last.
// ════════════════════════════════════════════════════════════════════════════
async function scrapeNDB(browser) {
  console.log('📦 NDB Bank...');
  const categories = [
    ['privilege-weekend',          'Dining'],
    ['restaurants-pubs',           'Dining'],
    ['supermarkets',               'Supermarket'],
    ['special-ipp-promotions',     'Instalment'],
    ['travel-transport',           'Travel'],
    ['hotels-villas',              'Travel'],
    ['other-offers',               'Other'],
    ['jewellery-watches',          'Shopping'],
    ['hospital-healthcare',        'Health'],
    ['wellness-beautycare',        'Health'],
    ['online-stores',              'Online'],
    ['education',                  'Instalment'],
    ['solar-housing-construction', 'Instalment'],
    ['automobile',                 'Other'],
    ['visa-offers',                'Other'],
  ];

  const offers = [];
  const BASE = 'https://www.ndbbank.com/cards/card-offers';

  for (const [slug, cat] of categories) {
    let pageNum = 1;
    let hasMore = true;

    while (hasMore && pageNum <= 20) {
      const url = pageNum === 1 ? `${BASE}/${slug}` : `${BASE}/${slug}?page=${pageNum}`;
      console.log(`  NDB /${slug} page ${pageNum}`);
      const page = await newPage(browser);
      await goto(page, url, 3000);

      try {
        // Get offer detail links from this category page
        const links = await page.evaluate((base, slug) => {
          return [...new Set(
            [...document.querySelectorAll('a[href*="/offer-details/"]')]
              .map(a => a.href)
              .filter(h => h.includes('ndbbank.com'))
          )];
        }, BASE, slug);

        // Check for next page
        hasMore = await page.evaluate(() => {
          const next = document.querySelector('a[rel="next"], .pagination .next:not(.disabled), li.next:not(.disabled) a, a.page-link[aria-label="Next"]');
          return !!next;
        });

        await page.close();

        // Visit each offer detail page
        for (const link of links.slice(0, 30)) {
          const detail = await scrapeDetail(browser, link);
          if (detail && detail.title && detail.title.length > 7) {
            offers.push({
              bank: 'NDB', cat,
              title:  detail.title,
              desc:   detail.desc,
              disc:   detail.disc || '',
              expiry: parseExpiry(detail.expiry),
              url:    link,
            });
          }
          await delay(400);
        }

        // If no detail links found, extract cards directly
        if (links.length === 0) {
          hasMore = false;
        }

      } catch(e) {
        console.warn(`  ✗ NDB ${slug} p${pageNum}: ${e.message}`);
        try { await page.close(); } catch(e2) {}
        hasMore = false;
      }

      pageNum++;
      await delay(800);
    }
  }

  console.log(`  ✓ NDB: ${offers.length} offers`);
  return offers;
}

// ════════════════════════════════════════════════════════════════════════════
// COMBANK
// Spec: Single page with multiple category sections. No separate category URLs.
// Must identify each section and extract all promotions.
// ════════════════════════════════════════════════════════════════════════════
async function scrapeComBank(browser) {
  console.log('📦 ComBank...');
  const url = 'https://www.combank.lk/rewards-promotions';
  const page = await newPage(browser);
  await goto(page, url, 5000);
  const offers = [];

  try {
    // Click Load More if present (ComBank may have it)
    let clicks = 0;
    while (clicks < 20) {
      const btn = await page.$('.load-more, button[class*="load"], .view-more, .show-more, [class*="loadMore"]');
      if (!btn) break;
      try { await btn.click(); await delay(2500); clicks++; } catch(e) { break; }
    }
    console.log(`  ComBank: clicked Load More ${clicks} times`);

    // Get all promotion links from the page
    const links = await page.evaluate(() => {
      return [...new Set(
        [...document.querySelectorAll('a[href*="/rewards-promotion/"]')]
          .map(a => a.href)
          .filter(h => h.includes('combank.lk/rewards-promotion/'))
      )];
    });

    console.log(`  ComBank: found ${links.length} promotion links`);
    await page.close();

    // Visit each promotion detail page
    for (const link of links) {
      const detail = await scrapeDetail(browser, link);
      if (detail && detail.title && detail.title.length > 7) {
        const cat = guessCat(detail.title + ' ' + detail.desc);
        offers.push({
          bank: 'ComBank', cat,
          title:  detail.title,
          desc:   detail.desc,
          disc:   detail.disc || '',
          expiry: parseExpiry(detail.expiry),
          url:    link,
        });
      }
      await delay(400);
    }

    // If no individual links found, extract cards directly
    if (links.length === 0) {
      const p = await newPage(browser);
      await goto(p, url, 4000);
      const cards = await extractCards(p, 'ComBank', 'Other', url);
      for (const c of cards) {
        offers.push({ ...c, cat: guessCat(c.title + ' ' + c.desc), expiry: parseExpiry(c.expiry) });
      }
      await p.close();
    }

  } catch(e) {
    console.warn(`  ✗ ComBank: ${e.message}`);
    try { await page.close(); } catch(e2) {}
  }

  console.log(`  ✓ ComBank: ${offers.length} offers`);
  return offers;
}

// ════════════════════════════════════════════════════════════════════════════
// SEYLAN BANK
// Spec: 22 categories, each with pagination (6 per page).
// Must follow all pages for every category.
// ════════════════════════════════════════════════════════════════════════════
async function scrapeSeylan(browser) {
  console.log('📦 Seylan Bank...');
  const categories = [
    ['cracker-deals',      'Shopping'],
    ['lifestyle',          'Shopping'],
    ['dining',             'Dining'],
    ['local-travel',       'Travel'],
    ['eye-care',           'Health'],
    ['special-promotions', 'Other'],
    ['overseas-travel',    'Travel'],
    ['auto',               'Other'],
    ['wellness',           'Health'],
    ['online-deals',       'Online'],
    ['health',             'Health'],
    ['supermarket',        'Supermarket'],
    ['education',          'Instalment'],
    ['insurance',          'Instalment'],
    ['pay-plans',          'Instalment'],
    ['electronics',        'Shopping'],
    ['kiddies',            'Shopping'],
    ['salon-spa',          'Shopping'],
    ['jewelry',            'Shopping'],
    ['solar',              'Instalment'],
    ['harasara',           'Other'],
  ];
  // Note: 'accelerate' has different base URL
  const ACCELERATE = { slug: 'accelerate', base: 'https://www.seylan.lk/promotions', cat: 'Other' };
  const BASE = 'https://www.seylan.lk/promotions/cards';

  const offers = [];

  // Category slugs that are under a different base
  const allCats = [
    ...categories.map(([slug, cat]) => ({ slug, cat, base: BASE })),
    { slug: ACCELERATE.slug, cat: ACCELERATE.cat, base: ACCELERATE.base },
  ];

  for (const { slug, cat, base } of allCats) {
    let pageNum = 1;
    let hasMore = true;

    while (hasMore && pageNum <= 20) {
      const url = `${base}/${slug}?page=${pageNum}`;
      console.log(`  Seylan /${slug} page ${pageNum}`);
      const page = await newPage(browser);
      await goto(page, url, 4000);

      try {
        // Get individual offer links (deeper URLs with slug/offer-name)
        const links = await page.evaluate((base, slug) => {
          return [...new Set(
            [...document.querySelectorAll('a[href]')]
              .map(a => a.href)
              .filter(h => {
                if (!h.includes('seylan.lk')) return false;
                // Must be deeper than just the category URL
                const catPath = `/${slug}`;
                const idx = h.indexOf(catPath);
                if (idx === -1) return false;
                const after = h.slice(idx + catPath.length);
                return after.length > 1 && !after.startsWith('?');
              })
          )];
        }, base, slug);

        // Check if next page exists
        hasMore = await page.evaluate(() => {
          const next = document.querySelector(
            'a[rel="next"], .pagination .next:not(.disabled), li.next:not(.disabled) a, a[aria-label="Next Page"], .next-page:not(.disabled)'
          );
          return !!next;
        });

        // Also try extracting directly from cards (fallback)
        const directCards = await extractCards(page, 'Seylan', cat, url);
        await page.close();

        // Visit each individual offer page
        if (links.length > 0) {
          for (const link of links.slice(0, 20)) {
            const detail = await scrapeDetail(browser, link);
            if (detail && detail.title && detail.title.length > 7) {
              offers.push({
                bank: 'Seylan', cat,
                title:  detail.title,
                desc:   detail.desc,
                disc:   detail.disc || '',
                expiry: parseExpiry(detail.expiry),
                url:    link,
              });
            }
            await delay(400);
          }
        } else if (directCards.length > 0) {
          for (const c of directCards) {
            offers.push({ ...c, expiry: parseExpiry(c.expiry) });
          }
          // No individual links = likely only one page
          if (directCards.length < 6) hasMore = false;
        } else {
          hasMore = false;
        }

      } catch(e) {
        console.warn(`  ✗ Seylan ${slug} p${pageNum}: ${e.message}`);
        try { await page.close(); } catch(e2) {}
        hasMore = false;
      }

      pageNum++;
      await delay(800);
    }
    console.log(`  Seylan /${slug}: done`);
  }

  console.log(`  ✓ Seylan: ${offers.length} offers`);
  return offers;
}

// ════════════════════════════════════════════════════════════════════════════
// NTB (NATIONS TRUST BANK)
// Spec: Category pages, no pagination. Each category is a single page.
// ════════════════════════════════════════════════════════════════════════════
async function scrapeNTB(browser) {
  console.log('📦 NTB...');
  const categories = [
    ['enjoy-exclusive-savings-on-supermarkets',                                                                                     'Supermarket'],
    ['enjoy-special-saving-at-a-range-of-clothing-retail-stores-with-nations-trust-bank-mastercard-credit-debit-cards',             'Shopping'],
    ['enjoy-exclusive-savings-on-dining',                                                                                           'Dining'],
    ['enjoy-exclusive-savings-on-your-next-hotel-stay-with-nations-trust-bank-mastercard-cards',                                    'Travel'],
    ['enjoy-exclusive-wellness-privileges-with-your-nations-trust-bank-mastercard-cards',                                           'Health'],
    ['enjoy-exclusive-savings-with-private-banking-mastercard-credit-cards',                                                        'Other'],
    ['enjoy-exclusive-savings-when-you-shop-online-with-nations-trust-bank-mastercard-cards',                                       'Online'],
    ['enjoy-exclusive-savings-on-homecare-essentials-with-nations-trust-bank-mastercard-cards',                                     'Shopping'],
    ['enjoy-special-savings-at-automobile-service-partners-with-your-nations-trust-bank-mastercard-card',                           'Other'],
  ];

  const offers = [];
  const BASE = 'https://www.nationstrust.com/promotions';

  for (const [slug, cat] of categories) {
    const url = `${BASE}/${slug}`;
    console.log(`  NTB /${slug.slice(0,40)}...`);
    const page = await newPage(browser);
    await goto(page, url, 3500);

    try {
      // Get individual promotion links
      const links = await page.evaluate((base) => {
        return [...new Set(
          [...document.querySelectorAll('a[href]')]
            .map(a => a.href)
            .filter(h => h.includes('nationstrust.com/promotions/') && h !== base && h.split('/').length > 5)
        )];
      }, url);

      const directCards = await extractCards(page, 'NTB', cat, url);
      await page.close();

      if (links.length > 0) {
        for (const link of links.slice(0, 30)) {
          const detail = await scrapeDetail(browser, link);
          if (detail && detail.title && detail.title.length > 7) {
            offers.push({
              bank: 'NTB', cat,
              title:  detail.title,
              desc:   detail.desc,
              disc:   detail.disc || '',
              expiry: parseExpiry(detail.expiry),
              url:    link,
            });
          }
          await delay(400);
        }
      } else {
        for (const c of directCards) {
          offers.push({ ...c, expiry: parseExpiry(c.expiry) });
        }
      }
    } catch(e) {
      console.warn(`  ✗ NTB ${slug.slice(0,40)}: ${e.message}`);
      try { await page.close(); } catch(e2) {}
    }

    await delay(800);
  }

  console.log(`  ✓ NTB: ${offers.length} offers`);
  return offers;
}

// ════════════════════════════════════════════════════════════════════════════
// BOC (BANK OF CEYLON)
// Spec: Category pages with "Load More" button. Must click until button disappears.
// Only extract AFTER all Load More clicks are done.
// ════════════════════════════════════════════════════════════════════════════
async function scrapeBOC(browser) {
  console.log('📦 BOC...');
  const categories = [
    ['travel-and-leisure', 'Travel'],
    ['supermarkets',       'Supermarket'],
    ['lifestyle',          'Shopping'],
    ['utility-insurance',  'Instalment'],
    ['education',          'Instalment'],
    ['zero-plans',         'Instalment'],
    ['online',             'Online'],
    ['fashion',            'Shopping'],
    ['health-beauty',      'Health'],
    ['automobile',         'Other'],
    ['dining',             'Dining'],
    ['mastercard-offers',  'Other'],
    ['visa-offers',        'Other'],
  ];

  const offers = [];
  const BASE = 'https://www.boc.lk/personal-banking/card-offers';

  for (const [slug, cat] of categories) {
    const url = `${BASE}/${slug}`;
    console.log(`  BOC /${slug}`);
    const page = await newPage(browser);
    await goto(page, url, 4000);

    try {
      // CRITICAL: Click Load More until it disappears BEFORE extracting
      let clicks = 0;
      while (clicks < 30) {
        const btn = await page.$('button.load-more, .load-more, [class*="loadMore"], .show-more, button[class*="load-more"], a.load-more');
        if (!btn) break;
        const isVisible = await page.evaluate(b => {
          const rect = b.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !b.disabled;
        }, btn);
        if (!isVisible) break;
        try {
          await btn.click();
          await delay(2500);
          clicks++;
        } catch(e) { break; }
      }
      if (clicks > 0) console.log(`  BOC /${slug}: clicked Load More ${clicks} times`);

      // NOW extract after all content is loaded
      // First try to get individual product page links
      const links = await page.evaluate(() => {
        return [...new Set(
          [...document.querySelectorAll('a[href*="/product"]')]
            .map(a => a.href)
            .filter(h => h.includes('boc.lk'))
        )];
      });

      if (links.length > 0) {
        await page.close();
        for (const link of links.slice(0, 30)) {
          const detail = await scrapeDetail(browser, link);
          if (detail && detail.title && detail.title.length > 7) {
            offers.push({
              bank: 'BOC', cat,
              title:  detail.title,
              desc:   detail.desc,
              disc:   detail.disc || '',
              expiry: parseExpiry(detail.expiry),
              url:    link,
            });
          }
          await delay(400);
        }
      } else {
        // Extract cards directly from the category page
        const cards = await extractCards(page, 'BOC', cat, url);
        await page.close();
        for (const c of cards) {
          offers.push({ ...c, expiry: parseExpiry(c.expiry) });
        }
      }

    } catch(e) {
      console.warn(`  ✗ BOC ${slug}: ${e.message}`);
      try { await page.close(); } catch(e2) {}
    }

    await delay(800);
  }

  console.log(`  ✓ BOC: ${offers.length} offers`);
  return offers;
}

// ════════════════════════════════════════════════════════════════════════════
// PEOPLE'S BANK
// Spec: Category pages, each with its own URL. No pagination noted.
// ════════════════════════════════════════════════════════════════════════════
async function scrapePeoplesBank(browser) {
  console.log("📦 People's Bank...");
  const categories = [
    ['auto-mobile',          'Other',       'https://www.peoplesbank.lk/promotion-category/auto-mobile/?cardType=credit_card'],
    ['home-care-electronics','Shopping',    'https://www.peoplesbank.lk/promotion-category/home-care-electronics/?cardType=credit_card'],
    ['leisure',              'Travel',      'https://www.peoplesbank.lk/promotion-category/leisure/?cardType=credit_card'],
    ['online-stores',        'Online',      'https://www.peoplesbank.lk/promotion-category/online-stores/?cardType=credit_card'],
    ['restaurants',          'Dining',      'https://www.peoplesbank.lk/promotion-category/restaurants/?cardType=credit_card'],
    ['supermarkets',         'Supermarket', 'https://www.peoplesbank.lk/promotion-category/supermarkets/?cardType=credit_card'],
    ['travel',               'Travel',      'https://www.peoplesbank.lk/promotion-category/travel/?cardType=credit_card'],
    ['visa',                 'Other',       'https://www.peoplesbank.lk/promotion-category/visa/?cardType=credit_card'],
    ['wellness',             'Health',      'https://www.peoplesbank.lk/promotion-category/wellness/?cardType=credit_card'],
  ];

  const offers = [];

  for (const [slug, cat, url] of categories) {
    console.log(`  People's /${slug}`);
    const page = await newPage(browser);
    await goto(page, url, 4000);

    try {
      // Get individual promotion links
      const links = await page.evaluate(() => {
        return [...new Set(
          [...document.querySelectorAll('a[href]')]
            .map(a => a.href)
            .filter(h => h.includes('peoplesbank.lk') && h.includes('/promotion/') && !h.includes('promotion-category'))
        )];
      });

      const directCards = await extractCards(page, "People's", cat, url);
      await page.close();

      if (links.length > 0) {
        for (const link of links.slice(0, 30)) {
          const detail = await scrapeDetail(browser, link);
          if (detail && detail.title && detail.title.length > 7) {
            offers.push({
              bank: "People's", cat,
              title:  detail.title,
              desc:   detail.desc,
              disc:   detail.disc || '',
              expiry: parseExpiry(detail.expiry),
              url:    link,
            });
          }
          await delay(400);
        }
      } else {
        for (const c of directCards) {
          offers.push({ ...c, expiry: parseExpiry(c.expiry) });
        }
      }

    } catch(e) {
      console.warn(`  ✗ People's ${slug}: ${e.message}`);
      try { await page.close(); } catch(e2) {}
    }

    await delay(800);
  }

  console.log(`  ✓ People's: ${offers.length} offers`);
  return offers;
}

// ════════════════════════════════════════════════════════════════════════════
// GENERIC scraper for remaining banks
// ════════════════════════════════════════════════════════════════════════════
async function scrapeGeneric(browser, bank, url) {
  console.log(`📦 ${bank}...`);
  const page = await newPage(browser);
  await goto(page, url, 4000);
  const offers = [];

  try {
    // Try Load More
    let clicks = 0;
    while (clicks < 15) {
      const btn = await page.$('.load-more, button[class*="load"], .view-more, .show-more, [class*="loadMore"]');
      if (!btn) break;
      try { await btn.click(); await delay(2500); clicks++; } catch(e) { break; }
    }

    const cards = await extractCards(page, bank, 'Other', url);
    for (const c of cards) {
      offers.push({ ...c, cat: guessCat(c.title + ' ' + c.desc), expiry: parseExpiry(c.expiry) });
    }
  } catch(e) {
    console.warn(`  ✗ ${bank}: ${e.message}`);
  }
  await page.close();
  console.log(`  ✓ ${bank}: ${offers.length} offers`);
  return offers;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('🚀 Sri Lanka Credit Card Offers Scraper v3');
  console.log('==========================================');
  console.log(`Started: ${new Date().toLocaleString()}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  let raw = [];

  const scrapers = [
    ['NDB',         () => scrapeNDB(browser)],
    ['ComBank',     () => scrapeComBank(browser)],
    ['Seylan',      () => scrapeSeylan(browser)],
    ['NTB',         () => scrapeNTB(browser)],
    ['BOC',         () => scrapeBOC(browser)],
    ["People's",    () => scrapePeoplesBank(browser)],
    ['HNB',         () => scrapeGeneric(browser, 'HNB', 'https://www.hnb.lk/card-promotion')],
    ['DFCC',        () => scrapeGeneric(browser, 'DFCC', 'https://www.dfcc.lk/cards/credit-card-offers')],
    ['Sampath',     () => scrapeGeneric(browser, 'Sampath', 'https://www.sampath.lk/sampath-cards/credit-card-offer')],
    ['Pan Asia',    () => scrapeGeneric(browser, 'Pan Asia', 'https://www.pabcbank.com/card-offers/')],
    ['Cargills',    () => scrapeGeneric(browser, 'Cargills', 'https://www.cargillsbank.com/promotions')],
    ['CDB',         () => scrapeGeneric(browser, 'CDB', 'https://www.cdb.lk/cdb-offers')],
    ['Standard Chartered', () => scrapeGeneric(browser, 'Standard Chartered', 'https://www.sc.com/lk/promotions/')],
  ];

  for (const [name, scraper] of scrapers) {
    try {
      const result = await scraper();
      raw.push(...result);
      console.log(`  → ${name} complete: ${result.length} raw offers`);
    } catch(e) {
      console.error(`  ✗ ${name} failed: ${e.message}`);
    }
    await delay(1000);
  }

  await browser.close();

  // ── Clean & validate ──
  const today = new Date().toISOString().slice(0,10);
  const valid = dedupe(
    raw
      .filter(isValid)
      .map((o, i) => ({
        id:     i + 1,
        bank:   clean(o.bank, 50),
        cat:    clean(o.cat, 50),
        title:  clean(o.title, 150),
        desc:   clean(o.desc, 500),
        disc:   clean(o.disc || 'Special offer', 100),
        expiry: o.expiry || defaultExpiry(),
        url:    clean(o.url || '', 300),
      }))
      .filter(o => o.expiry >= today) // remove already expired
  );

  // ── Safety check ──
  const MIN = 50;
  if (valid.length < MIN) {
    console.log(`\n⚠️  Only ${valid.length} valid offers — below minimum ${MIN}.`);
    console.log('   Keeping existing offers.json.');
    process.exit(0);
  }

  // ── Summary ──
  console.log(`\n✅ Raw: ${raw.length} → Valid & unique: ${valid.length}`);
  const byBank = {};
  valid.forEach(o => byBank[o.bank] = (byBank[o.bank]||0)+1);
  Object.entries(byBank).sort().forEach(([b,n]) => console.log(`   ${b}: ${n}`));

  fs.writeFileSync(
    path.join(__dirname, 'offers.json'),
    JSON.stringify(valid, null, 2)
  );
  console.log(`\n💾 Saved to scraper/offers.json`);
  console.log(`Finished: ${new Date().toLocaleString()}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
