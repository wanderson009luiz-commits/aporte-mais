# Aporte+

Organize seus aportes: você define quanto cada classe e cada ativo deve pesar na carteira, informa quanto tem para investir e o Aporte+ monta a ordem de compra — cotas inteiras na bolsa, valor exato em cripto e no exterior, aplicação em renda fixa — e manda o que sobrar para o Caixa de Oportunidade.

**Acesse:** https://wanderson009luiz-commits.github.io/aporte-mais/ · versão 4.0.0

- Login por e-mail e senha (Supabase). Cada pessoa vê só a própria carteira.
- Cotações automáticas e gratuitas: B3 e EUA (Yahoo Finance), cripto (CoinGecko) e câmbio — atualizadas pelo servidor (`supabase/functions/price-refresh`).
- No celular: abra o endereço e use "Adicionar à tela inicial" para instalar como aplicativo.
- O app não recomenda investimentos nem executa ordens: ele organiza a sua estratégia.

## Como o cálculo funciona

1. Cada classe tem um alvo = % ideal × (patrimônio + aporte). O aporte é dividido entre as classes na proporção da distância de cada uma até o alvo.
2. Dentro da classe, o mesmo critério entre os ativos, sem passar do alvo do ativo.
   - **Bolsa (lote):** compra cotas inteiras; a sobra compra mais cotas de quem ainda está abaixo do alvo (no máximo uma cota além do alvo por ativo).
   - **Cripto / exterior (fração):** compra o valor exato.
   - **Renda fixa (valor):** aplica o valor, respeitando a aplicação mínima informada.
3. O que não puder ser investido vai para o Caixa de Oportunidade.
4. O motor confere ao centavo que *investido + direto + caixa = aporte*; se não fechar, ele cancela o cálculo.

O código do cálculo fica em `js/engine.js` e `js/model.js`, sem dependência de tela ou rede.

## Testes

```bash
npm test                         # motor de cálculo: casos conhecidos + 4.000 carteiras aleatórias
node tests/e2e/run.mjs           # interface completa no navegador (precisa do Playwright)
```

A cada envio para `main`, o GitHub Actions roda todos os testes e **só publica se todos passarem**.

## Estrutura

```
index.html, css/app.css      interface
js/app.js                    telas, login, salvamento, cotações
js/engine.js, js/model.js    regras de cálculo (testadas)
js/vendor/supabase.js        cliente Supabase 2.117.2 (cópia local, MIT)
supabase/functions/          função de cotações no servidor
tests/                       testes automáticos
```
