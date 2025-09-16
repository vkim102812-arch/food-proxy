// api/food.ts — USDA-only proxy for Vercel
import type { VercelRequest, VercelResponse } from '@vercel/node';

const USDA_API_KEY = process.env.USDA_API_KEY || '';

type ExtFood = { name: string; kcal_per_100g: number; source: 'usda' | 'fallback' };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const num = (x: any) => {
  const n = parseFloat(String(x).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

// Fix common typos and synonyms
function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/\bdumpsticks\b/g, 'drumsticks')
    .replace(/\bskin ?on\b/g, 'skin-on')
    .replace(/\bskin ?off\b/g, 'skinless')
    .replace(/\bchicken leg(s)?\b/g, 'chicken drumsticks');
}

async function fetchUSDA(q: string): Promise<ExtFood[]> {
  if (!USDA_API_KEY) return [];
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_API_KEY}&query=${encodeURIComponent(q)}&pageSize=15`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  const items = Array.isArray(j?.foods) ? j.foods : [];
  const out: ExtFood[] = [];

  for (const it of items) {
    const name = norm(it?.description || it?.lowercaseDescription || '');
    if (!name) continue;

    const nutrients = it?.foodNutrients || [];
    const cal = nutrients
