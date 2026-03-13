# Funnel Swiper Dashboard

Dashboard per la gestione delle attività di swipe funnel con vista stile Excel.

## Funzionalità

### Front End Funnel
- Gestione pagine con vista tabella Excel
- Tipi pagina: 5 Reasons Why Listicle, Quiz Funnel, Landing, Product Page, Safe Page, Checkout
- Template: Advertorial, Checkout, OTO 1, OTO 2, Upsell, Downsell
- Selezione prodotto
- URL da swipare
- Stato swipe (Pending, In Progress, Completed, Failed)
- Lancio swipe
- Risultato swipe

### Post Purchase Funnel
- Thank You Page
- Upsell 1, Upsell 2
- Downsell
- Order Confirmation

### My Products
- Gestione prodotti
- Nome, descrizione, prezzo, immagine

### Funnel Analyzer (Visual Funnel Crawler)
- **Layer 1 – Crawl**: Playwright naviga dall’URL di ingresso, screenshot full-page per ogni step, link/CTA/form, network e cookie.
- **Layer 2 – Vision AI**: Ogni screenshot viene inviato a Claude o Gemini (vision) per estrarre: tipo pagina, headline, subheadline, copy, CTA, offerta, prezzi, urgenza, social proof, tech stack, tecniche di persuasione.

Per l’analisi Vision, in `.env.local` imposta **una** delle due:
- `ANTHROPIC_API_KEY` (per Claude)
- `GEMINI_API_KEY` (per Gemini)

## Installazione

```bash
npm install
```

## Sviluppo

```bash
npm run dev
```

Apri [http://localhost:3000](http://localhost:3000) nel browser.

## Build

```bash
npm run build
npm start
```

## Tecnologie

- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- Zustand (state management)
- Lucide React (icons)
