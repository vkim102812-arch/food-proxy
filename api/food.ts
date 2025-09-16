// Vercel serverless function
import type { VercelRequest, VercelResponse } from '@vercel/node';

const USDA_API_KEY = process.env.USDA_API_KEY || '';
const EDAMAM_APP_ID = process.env.EDAMAM_APP_ID || '';
const EDAMAM_APP_KEY = process.env.EDAMAM_APP_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

type ExtFood = { name: string; kcal_per_100g: number; source: 'usda' | 'edamam' | 'ai' };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const num = (x: any) => {
  const n = parseFloat(String(x).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

function roughHeuristicPer100g(name: string): number {
  const n = name.toLowerCase();
  if (/(salad|овощ|vegetable|cucumber|tomato)/.test(n)) return 40;
  if (/(fruit|ябл|banana|апельсин|berry)/.test(n)) return 55;
  if (/(soup|борщ|суп)/.test(n)) return 60;
  if (/(chicken|кур|turkey|индейк)/.test(n)) return 160;
  if (/(beef|говя|pork|свин)/.test(n)) return 240;
  if (/(fish|рыб|salmon|тунец)/.test(n)) return 180;
  if (/(rice|рис|pasta|макар)/.test(n)) return 150;
  if (/(bread|хлеб|булк)/.test(n)) return 260;
  if (/(cheese|сыр)/.test(n)) return 330;
  if (/(dessert|cake|торт|печень|cookie)/.test(n)) return 380;
  return 180;
}

async function fetchUSDA(q: string): Promise<ExtFood[]> {
  if (!USDA_API_KEY) return [];
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_API_KEY}&query=${encodeURIComponent(q)}&pageSize=10`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  const items = Array.isArray(j?.foods) ? j.foods : [];
  const out: ExtFood[] = [];
  for (const it of items) {
    const name = norm(it?.description || it?.lowercaseDescription || '');
    if (!name) continue;
    const nutrients = it?.foodNutrients || [];
    const cal = nutrients.find((n: any) => (n?.nutrientNumber === '1008') || /Energy/i.test(n?.nutrientName));
    let kcal = NaN;
    if (cal?.value && it?.servingSize && it?.servingSizeUnit === 'g') {
      kcal = (num(cal.value) / num(it.servingSize)) * 100;
    } else if (cal?.value) {
      kcal = num(cal.value); // часто уже per 100g
    }
    if (Number.isFinite(kcal) && kcal > 0 && kcal < 1000) out.push({ name, kcal_per_100g: Math.round(kcal), source: 'usda' });
  }
  return out;
}

async function fetchEdamam(q: string): Promise<ExtFood[]> {
  if (!EDAMAM_APP_ID || !EDAMAM_APP_KEY) return [];
  const url = `https://api.edamam.com/api/food-database/v2/parser?app_id=${EDAMAM_APP_ID}&app_key=${EDAMAM_APP_KEY}&ingr=${encodeURIComponent(q)}&category=generic-foods`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  const hints = Array.isArray(j?.hints) ? j.hints : [];
  return hints
    .map((h: any) => {
      const name = norm(h?.food?.label || '');
      const kcal = num(h?.food?.nutrients?.ENERC_KCAL);
      if (!name || !Number.isFinite(kcal) || kcal <= 0) return null;
      return { name, kcal_per_100g: Math.round(kcal), source: 'edamam' } as ExtFood;
    })
    .filter(Boolean) as ExtFood[];
}

async function aiFallback(q: string): Promise<ExtFood[]> {
  if (!OPENAI_API_KEY) {
    return [{ name: norm(q), kcal_per_100g: roughHeuristicPer100g(q), source: 'ai' }];
  }
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [{ role: 'user', content: `Return ONLY a number. Calories per 100 g for: "${q}".` }],
      }),
    });
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content ?? '';
    const n = num(text);
    const kcal = (Number.isFinite(n) && n > 0) ? Math.round(n) : roughHeuristicPer100g(q);
    return [{ name: norm(q), kcal_per_100g: kcal, source: 'ai' }];
  } catch {
    return [{ name: norm(q), kcal_per_100g: roughHeuristicPer100g(q), source: 'ai' }];
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing q' });

  const uniq = new Set<string>();
  const pushU = (arr: ExtFood[], item: ExtFood) => {
    const key = item.name.toLowerCase() + '|' + item.kcal_per_100g;
    if (!uniq.has(key)) { uniq.add(key); arr.push(item); }
  };

  let results: ExtFood[] = [];
  for (const it of await fetchUSDA(q)) pushU(results, it);
  if (results.length < 6) for (const it of await fetchEdamam(q)) pushU(results, it);
  if (results.length === 0) for (const it of await aiFallback(q)) pushU(results, it);

  res.status(200).json({ items: results.slice(0, 10) });
}
