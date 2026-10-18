// Gerador de carteiras aleatórias (determinístico) usado nos testes de estresse.
import { migrateState } from '../js/model.js';

// gerador determinístico (mesma sequência a cada execução → falhas reproduzíveis)
export function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

export function splitHundred(r, n) {
  if (n === 0) return [];
  const w = Array.from({ length: n }, () => 0.05 + r());
  const W = w.reduce((s, x) => s + x, 0);
  const out = w.map((x) => Math.round((x / W) * 10000) / 100);
  const diff = Math.round((100 - out.reduce((s, x) => s + x, 0)) * 100) / 100;
  out[0] = Math.round((out[0] + diff) * 100) / 100;
  return out;
}

export function randomPortfolio(r, i) {
  const types = ['b3', 'b3', 'exterior', 'cripto', 'rendafixa', 'valor'];
  const nCls = 1 + Math.floor(r() * 5);
  const classes = [];
  const usd = r() < 0.5;
  for (let k = 0; k < nCls; k++) {
    let type = types[Math.floor(r() * types.length)];
    if (type === 'exterior' && !usd) type = 'b3';
    const nA = type === 'valor' ? 0 : 1 + Math.floor(r() * 8);
    const ideals = splitHundred(r, nA);
    const assets = ideals.map((ip, j) => {
      const hasPrice = r() < 0.9;
      const price = type === 'cripto' ? 1000 + r() * 400000 : type === 'exterior' ? 5 + r() * 600 : 1 + r() * 300;
      const qtyMode = r() < 0.5;
      return {
        id: `a${i}_${k}_${j}`, ticker: `T${k}${j}${type === 'b3' ? '3' : ''}`, idealPct: ip,
        qty: qtyMode ? (type === 'cripto' || type === 'exterior' ? r() * 3 : Math.floor(r() * 200)) : 0,
        price: hasPrice ? Math.round(price * 100) / 100 : 0, priceMode: 'manual',
        currentValue: qtyMode ? 0 : Math.round(r() * 20000 * 100) / 100,
        minQty: type === 'b3' && r() < 0.15 ? 100 : 1,
        minAmount: (type === 'rendafixa' || type === 'cripto') && r() < 0.3 ? Math.round(r() * 100) : 0,
      };
    });
    classes.push({ id: `c${k}`, name: `Classe ${k}`, type, assets, currency: type === 'exterior' ? 'USD' : 'BRL',
      fractional: type === 'exterior' ? r() < 0.7 : false, currentValue: type === 'valor' ? Math.round(r() * 10000 * 100) / 100 : 0 });
  }
  classes.push({ id: 'cash', name: 'Caixa', type: 'valor', isCash: true, currentValue: Math.round(r() * 5000 * 100) / 100, assets: [] });
  const ideals = splitHundred(r, classes.length);
  classes.forEach((c, k) => { c.idealPct = ideals[k]; });
  // às vezes uma classe com 0% (não recebe nada)
  if (classes.length > 2 && r() < 0.2) { const z = classes[0].idealPct; classes[0].idealPct = 0; classes[1].idealPct = Math.round((classes[1].idealPct + z) * 100) / 100; }
  return migrateState({ classes, settings: { fxManual: { USD: usd ? Math.round((4 + r() * 2) * 10000) / 10000 : null } } });
}

