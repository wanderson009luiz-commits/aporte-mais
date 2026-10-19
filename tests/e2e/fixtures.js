// Cenários de teste no formato das carteiras de versões antigas (v2/v3): preços digitados à mão, classe em dólar, preços zerados.
(function () {
  const ACOES = [['VALE3',6,78.2],['WEGE3',8,51.49],['EGIE3',6,30.75],['BBSE3',5,39.5],['TAEE11',6,40.73],['LEVE3',5,32.5],['TOTS3',7,32.94],['SAPR11',5,34.56],['BBAS3',7,22.49],['VIVA3',6,22.33],['FLRY3',7,21.06],['SOJA3',5,7.71],['ABEV3',5,15.62],['ITSA4',7,14.19],['RANI3',5,7.95],['GRND3',5,3.74],['KLBN4',5,3.85]];
  const ETFS = [['IVVB11',40,443.15],['NASD11',30,20.95],['WRLD11',20,148.39],['DIVO11',10,133.95]];
  const FIIS = [['XPLG11',8,91.65],['HGLG11',8,146],['VILG11',6,93.15],['XPML11',7,102.65],['VISC11',7,104.83],['MALL11',6,100.24],['KNRI11',6,157.4],['HGRE11',6,113.69],['BRCR11',5,41.98],['DEVA11',7,16.98],['CPTS11',6,7.5],['VRTA11',6,70.55],['BCFF11',6,7.28],['HGRU11',8,115],['MXRF11',8,9.14]];
  const RF = [['TESOURO IPCA+',49,100],['TESOURO SELIC',17,100],['LCI/LCA',17,100],['LIQUIDEZ IMEDIATA',17,1]];
  const CR = [['BTC',70,393227.28],['ETH',30,12676.07]];
  let n = 0;
  const mk = (rows, withPrice) => rows.map(([t, p, price]) => ({ id: 'x' + (n++), price: withPrice ? price : 0, minQty: 1, ticker: t, idealPct: p, termometro: { nota: null, motivos: [] }, currentValue: 0 }));
  function v2State(withPrice, withUsd) {
    const cur = withUsd ? {} : { currency: 'BRL' };
    const classes = [
      { id: 'acoes', name: 'Ações', assets: mk(ACOES, withPrice), isCash: false, idealPct: 35, hasAssets: true, fractional: false, currentValue: 0, ...cur },
      { id: 'caixa', name: 'Caixa', assets: [], isCash: true, idealPct: 5, hasAssets: false, fractional: false, currentValue: 0, ...cur },
      { id: 'etfs', name: 'ETFs', assets: mk(ETFS, withPrice), isCash: false, idealPct: 25, hasAssets: true, fractional: false, currentValue: 0, ...cur },
      { id: 'fiis', name: 'FIIs', assets: mk(FIIS, withPrice), isCash: false, idealPct: 20, hasAssets: true, fractional: false, currentValue: 0, ...cur },
      { id: 'rendafixa', name: 'Renda Fixa', assets: mk(RF, withPrice), isCash: false, idealPct: 10, hasAssets: true, fractional: false, currentValue: 0, ...cur },
      { id: 'cripto', name: 'Criptomoedas', assets: mk(CR, withPrice), isCash: false, idealPct: 5, hasAssets: true, fractional: true, currentValue: 0, ...cur },
    ];
    if (withUsd) classes.push({ id: 'acoes-eua', name: 'Ações EUA (Avenue)', assets: [], isCash: false, currency: 'USD', idealPct: 0, hasAssets: true, fractional: true, currentValue: 0 });
    return { agenda: { weekday: 1, frequency: 'semanal', customNote: '', dayOfMonth: 5, lastAporteDate: null }, aportes: [], classes, timeline: [], dividendos: [] };
  }
  const Q = { ABEV3: 16.84, BBAS3: 23.63, BBSE3: 42.08, BRCR11: 45.7, CPTS11: 7.79, DEVA11: 17.9, DIVO11: 145.28, EGIE3: 31.32, FLRY3: 27.11, GRND3: 4.5, HGLG11: 156.42, HGRE11: 124.79, HGRU11: 123.38, ITSA4: 15.43, IVVB11: 438.55, KLBN4: 3.61, KNRI11: 161.95, LEVE3: 37.2, MXRF11: 9.34, NASD11: 20.63, RANI3: 8, SAPR11: 40, SOJA3: 8, TAEE11: 44.56, TOTS3: 40.29, VALE3: 66.21, VILG11: 100.5, VISC11: 113.6, VIVA3: 26.69, VRTA11: 75.4, WEGE3: 47.99, WRLD11: 144.11, XPLG11: 99.89, XPML11: 105.99, 'CRYPTO:BTC': 409696, 'CRYPTO:ETH': 11936.55, 'US:AAPL': 343.46, BTHF11: 8.94, PMLL11: 108.99, 'US:VOO': 512.7 };
  // carteira com cotas em tickers que mudaram de código (e um que a fonte não reconhece)
  function trocas() {
    const s = v2State(false, false);
    const f = s.classes.find((c) => c.id === 'fiis');
    f.assets.find((a) => a.ticker === 'BCFF11').qty = 13;
    f.assets.find((a) => a.ticker === 'MALL11').qty = 5;
    const d = f.assets.find((a) => a.ticker === 'DEVA11'); d.ticker = 'DEVA12'; d.qty = 20;
    return s;
  }
  // notícias que a função "news-refresh" falsa grava (h = horas atrás)
  const NEWS = [
    { ticker: 'VALE3', h: 2, impact: 'alto', direction: 'negativo', relevant: true, classified_by: 'ia', source: 'InfoMoney', title: 'Vale tem rompimento de barragem e suspende operações em mina', summary: 'Acidente pode gerar multas e paralisar parte da produção, pressionando resultado e dividendos.' },
    { ticker: 'MXRF11', h: 5, impact: 'medio', direction: 'negativo', relevant: true, classified_by: 'ia', source: 'FIIs.com.br', title: 'MXRF11 reduz dividendos para R$ 0,09 por cota', summary: 'Rendimento mensal cai pela inadimplência de um CRI da carteira.' },
    { ticker: 'WEGE3', h: 8, impact: 'medio', direction: 'positivo', relevant: true, classified_by: 'ia', source: 'Valor', title: 'WEG tem lucro recorde no 3º trimestre e supera estimativas', summary: 'Lucro acima do esperado reforça a tese de crescimento.' },
    { ticker: 'CRYPTO:BTC', h: 3, impact: 'baixo', direction: 'positivo', relevant: true, classified_by: 'regras', source: 'Cointelegraph', title: 'Bitcoin sobe 3% e volta a US$ 82 mil', summary: null },
    { ticker: 'HGLG11', h: 6, impact: 'baixo', direction: 'neutro', relevant: false, classified_by: 'ia', source: 'Suno', title: '10 FIIs para investir: HGLG11, XPML11, KNRI11 e BTLG11', summary: 'Lista de recomendações; não é sobre o fundo.' },
    { ticker: 'XPLG11', h: 7, impact: 'baixo', direction: 'neutro', relevant: true, classified_by: 'regras', source: 'Teste', title: '<img src=x onerror="window.__xss=1"> XPLG11 renova contrato', summary: null },
    { ticker: 'PETR4', h: 1, impact: 'alto', direction: 'negativo', relevant: true, classified_by: 'ia', source: 'X', title: 'Petrobras corta dividendos (não está na carteira)', summary: 'Não deve aparecer.' },
    { ticker: 'VALE3', h: 24 * 20, impact: 'alto', direction: 'negativo', relevant: true, classified_by: 'ia', source: 'X', title: 'Notícia velha da Vale (20 dias)', summary: 'Fora da janela.' },
  ];
  window.__FIXTURES = { antiga: v2State(true, true), zerada: v2State(false, false), trocas: trocas(), news: NEWS, quotes: Q, fx: { 'USD-BRL': 5.0645, 'EUR-BRL': 5.6633 }, unknown: ['BCFF11', 'MALL11', 'DEVA12'] };
})();
