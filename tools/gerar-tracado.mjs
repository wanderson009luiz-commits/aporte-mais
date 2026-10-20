// Gera os desenhos de "cédula" do visual (traçado fino tipo guilhoché) em img/.
// Rodar: node tools/gerar-tracado.mjs   (o resultado vai para o repositório; não roda no app)
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'img');
const f = (n) => Number(n.toFixed(1));
const pathOf = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L');

// roseta: um epitrocoide repetido em volta do centro, com pequenas rotações (o "rendado" das notas)
function rosette({ R, r, d, step = 1.5 }) {
  const pts = [];
  for (let a = 0; a <= 360; a += step) {
    const t = (a * Math.PI) / 180;
    pts.push([(R + r) * Math.cos(t) - d * Math.cos(((R + r) / r) * t), (R + r) * Math.sin(t) - d * Math.sin(((R + r) / r) * t)]);
  }
  return pathOf(pts);
}
// onda: soma de duas senoides, mais larga que a área visível (as cópias deslocadas não mostram as pontas)
function wave({ width, amp1, per1, amp2, per2 }) {
  const pts = [];
  for (let x = -200; x <= width + 200; x += 5) pts.push([x, Math.sin(x / per1) * amp1 + Math.sin(x / per2 + 1.3) * amp2]);
  return pathOf(pts);
}

// roseta sozinha (quadrada): vai no canto da "nota"; as ondas vêm de faixa.svg, esticadas na largura
function roseta() {
  const ink = '#2B5E8C';
  const petal = rosette({ R: 62, r: 12.4, d: 30 });
  const inner = rosette({ R: 30, r: 7.5, d: 15, step: 2 });
  const turns = Array.from({ length: 18 }, (_, k) => `<use href="#p" transform="rotate(${(k * 4).toFixed(1)})"/>`).join('');
  const turnsIn = Array.from({ length: 12 }, (_, k) => `<use href="#q" transform="rotate(${(k * 7.5).toFixed(1)})"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-112 -112 224 224">
<defs><path id="p" d="${petal}"/><path id="q" d="${inner}"/></defs>
<g fill="none" stroke="${ink}" stroke-width=".7">
<g stroke-opacity=".26">${turns}</g>
<g stroke-opacity=".34">${turnsIn}</g>
<circle r="17" stroke-opacity=".4"/><circle r="104" stroke-opacity=".16"/><circle r="110" stroke-opacity=".1"/>
</g></svg>
`;
}

function faixa() {
  const W = 720, H = 90, ink = '#2B5E8C';
  const w = wave({ width: W, amp1: 11, per1: 38, amp2: 6, per2: 83 });
  const waves = Array.from({ length: 11 }, (_, k) => `<use href="#w" transform="translate(${-k * 11} ${18 + k * 5.4})" stroke-opacity="${(0.1 + (k % 3) * 0.03).toFixed(3)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
<defs><path id="w" d="${w}"/></defs>
<g fill="none" stroke="${ink}" stroke-width=".6">${waves}</g></svg>
`;
}

// "A+" em Spectral 700, 108px, já convertido em contorno e centralizado em (256, 256) — feito com opentype.js.
// Em contorno, o ícone fica igual em qualquer aparelho (um <text> dependeria da fonte instalada).
const APLUS = 'M212.2 291.9L188.8 291.9L188.8 290.2L195.4 286.5L223.5 220.1L233.1 220.1L260.9 286.4L268.3 290.2L268.3 291.9L234.1 291.9L234.1 290.2L243.5 286.3L236.2 268.4L210.6 268.4L203.2 286.3L212.2 290.2L212.2 291.9ZM223.3 237.4L213.1 262.4L233.7 262.4L223.3 237.4ZM297.4 265.4L277.9 265.4L277.9 259.6L297.4 259.6L297.4 239.9L303.7 239.9L303.7 259.6L323.2 259.6L323.2 265.4L303.7 265.4L303.7 285.2L297.4 285.2L297.4 265.4Z';

// ícone do app: "A+" gravado sobre uma roseta, em papel de cédula
function icone() {
  const petal = rosette({ R: 118, r: 23.6, d: 58, step: 1 });
  const turns = Array.from({ length: 18 }, (_, k) => `<use href="#p" transform="rotate(${(k * 4).toFixed(1)})"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><path id="p" d="${petal}"/></defs>
<rect width="512" height="512" rx="112" fill="#EEF0EA"/>
<rect x="22" y="22" width="468" height="468" rx="94" fill="none" stroke="#2B5E8C" stroke-opacity=".45" stroke-width="3"/>
<g transform="translate(256 256)" fill="none" stroke="#2B5E8C" stroke-width="1.4" stroke-opacity=".32">${turns}</g>
<circle cx="256" cy="256" r="98" fill="#EEF0EA" stroke="#2B5E8C" stroke-opacity=".5" stroke-width="2.5"/>
<path d="${APLUS}" fill="#1F2A26"/>
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'roseta.svg'), roseta());
fs.writeFileSync(path.join(OUT, 'faixa.svg'), faixa());
fs.writeFileSync(path.join(OUT, '..', 'icon.svg'), icone());
for (const n of ['roseta.svg', 'faixa.svg']) console.log(n, fs.statSync(path.join(OUT, n)).size, 'bytes');
console.log('icon.svg', fs.statSync(path.join(OUT, '..', 'icon.svg')).size, 'bytes');
