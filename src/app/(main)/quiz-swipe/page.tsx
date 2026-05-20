'use client';

/**
 * Clone / Swipe Quiz — sezione separata per quiz "single-URL multi-step".
 *
 * Sono le pagine (tipicamente React SPA) dove TUTTE le domande del quiz
 * vivono sullo stesso URL e cambiano via JS quando clicchi Next. Esempio
 * canonico: lpservhub.com/s7-yp7XapLudjms/de/?affiliate=0
 *
 * Il clone tradizionale (sezione "Clone / Swipe") cattura solo lo step 1
 * perche' il restante DOM viene generato a runtime dal bundle, spesso
 * dietro fetch /api/. Per clonare l'intero quiz servono:
 *   1. un walker Playwright (worker locale, job_type='walk_quiz')
 *      che apre la URL, clicca Next, cattura HTML+screenshot ad ogni step;
 *   2. una tabella `quiz_walks` che salva l'array di step;
 *   3. una UI (questa pagina) che mostra ogni step come riga indipendente
 *      e permette di swipare ciascuno separatamente.
 *
 * Questa pagina e' lo scaffolding: form di input + chiamata a un endpoint
 * che ancora non esiste. Il backend (job nel worker, route API, tabella DB)
 * verra' aggiunto nei prossimi commit, in modo incrementale, senza toccare
 * la sezione "Clone / Swipe" classica che funziona per le pagine normali.
 */

import { useState } from 'react';
import Header from '@/components/Header';
import { HelpCircle, Play, AlertCircle, Sparkles, Loader2 } from 'lucide-react';

interface QuizWalkStep {
  index: number;
  html: string;
  screenshot_url?: string;
  detected_question?: string;
  detected_options?: string[];
}

interface QuizWalkResult {
  url: string;
  steps: QuizWalkStep[];
  final_step: number;
  duration_seconds: number;
  notes?: string;
}

export default function QuizSwipePage() {
  const [url, setUrl] = useState('');
  const [maxSteps, setMaxSteps] = useState(15);
  const [isWalking, setIsWalking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuizWalkResult | null>(null);

  async function startWalk() {
    if (!url.trim()) {
      setError('Inserisci la URL del quiz.');
      return;
    }
    try {
      new URL(url.trim());
    } catch {
      setError('URL non valida.');
      return;
    }
    setError(null);
    setResult(null);
    setIsWalking(true);
    try {
      const res = await fetch('/api/walk-quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), maxSteps }),
      });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok) {
        if (res.status === 501) {
          setError(
            "Backend ancora non costruito. Questa sezione e' lo scaffolding UI; il job 'walk_quiz' nel worker, la route /api/walk-quiz e la tabella quiz_walks verranno aggiunti nei prossimi commit."
          );
          return;
        }
        const body = ct.includes('application/json') ? JSON.stringify(await res.json()) : await res.text();
        setError(`Errore ${res.status}: ${body.slice(0, 300)}`);
        return;
      }
      if (!ct.includes('application/json')) {
        setError('Risposta non JSON dal server.');
        return;
      }
      const data = (await res.json()) as { ok?: boolean; result?: QuizWalkResult; error?: string };
      if (!data.ok || !data.result) {
        setError(data.error || 'Risposta inattesa dal server.');
        return;
      }
      setResult(data.result);
    } catch (e) {
      setError(`Errore di rete: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsWalking(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-50">
      <Header />

      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Hero */}
          <div className="bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-2xl p-6 shadow-lg">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
                <HelpCircle className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <h1 className="text-2xl font-bold">Clone / Swipe Quiz</h1>
                <p className="text-white/85 text-sm mt-1 max-w-2xl">
                  Per quiz e funnel single-URL multi-step (React/Vue SPA dove tutte le
                  domande vivono sullo stesso link e cambiano via JS). Il walker apre la
                  pagina con Playwright, clicca Next ad ogni step, cattura HTML +
                  screenshot di ogni schermata e li salva come righe separate, swipabili
                  una alla volta.
                </p>
              </div>
            </div>
          </div>

          {/* Form input */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">URL del quiz</label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://esempio.com/quiz/?affiliate=0"
                disabled={isWalking}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:opacity-60"
              />
              <p className="text-xs text-gray-500 mt-1">
                Tipico: quiz dove la URL non cambia mai mentre rispondi alle domande.
              </p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Numero massimo di step da catturare
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={maxSteps}
                onChange={(e) => setMaxSteps(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                disabled={isWalking}
                className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:opacity-60"
              />
              <p className="text-xs text-gray-500 mt-1">
                Il walker si ferma in anticipo se non trova piu' un bottone Next o se vede una
                schermata di checkout/grazie.
              </p>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={startWalk}
                disabled={isWalking || !url.trim()}
                className="px-5 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {isWalking ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Walking quiz...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Walk Quiz
                  </>
                )}
              </button>

              <span className="text-xs text-gray-500">
                Il job gira sul worker locale (Playwright), non sulla Lambda.
              </span>
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-900">{error}</div>
            </div>
          )}

          {/* Result list */}
          {result && (
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-600" />
                  {result.steps.length} step catturati
                </h2>
                <span className="text-xs text-gray-500">
                  {result.duration_seconds.toFixed(1)}s • final_step={result.final_step}
                </span>
              </div>
              <ul className="divide-y divide-gray-100">
                {result.steps.map((s) => (
                  <li key={s.index} className="py-3 flex items-start gap-4">
                    <div className="w-10 h-10 rounded-lg bg-purple-100 text-purple-700 font-bold flex items-center justify-center shrink-0">
                      {s.index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {s.detected_question || 'Domanda non rilevata'}
                      </p>
                      {s.detected_options && s.detected_options.length > 0 && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">
                          {s.detected_options.join(' • ')}
                        </p>
                      )}
                      <p className="text-xs text-gray-400 mt-1">
                        HTML: {s.html.length.toLocaleString()} chars
                        {s.screenshot_url ? ' • screenshot salvato' : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              {result.notes && (
                <p className="text-xs text-gray-500 mt-4 italic">{result.notes}</p>
              )}
            </div>
          )}

          {/* Roadmap nota */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-900">
            <p className="font-semibold mb-1">Stato</p>
            <p className="text-blue-800">
              UI scaffolding pronta. Mancano: route <code className="bg-blue-100 px-1 rounded">/api/walk-quiz</code>,
              job <code className="bg-blue-100 px-1 rounded">walk_quiz</code> nel worker
              (<code className="bg-blue-100 px-1 rounded">worker-lib/walk-quiz.js</code>) e tabella{' '}
              <code className="bg-blue-100 px-1 rounded">quiz_walks</code> in Supabase. Nessuna delle pipeline
              esistenti viene toccata.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
