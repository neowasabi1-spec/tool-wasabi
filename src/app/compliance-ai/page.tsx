'use client';

import { useState, useCallback } from 'react';
import Header from '@/components/Header';
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Loader2,
  Plus,
  Trash2,
  Play,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Zap,
} from 'lucide-react';

interface ComplianceItem {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warning' | 'not_applicable';
  details: string;
  recommendation?: string;
}

interface ComplianceResult {
  sectionId: string;
  sectionName: string;
  items: ComplianceItem[];
  overallStatus: 'pass' | 'fail' | 'warning';
  summary: string;
}

type ProductType = 'supplement' | 'digital' | 'both';

interface CheckSection {
  id: string;
  name: string;
  description: string;
  checks: string[];
}

interface CheckCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  sections: CheckSection[];
}

const COMPLIANCE_CATEGORIES: CheckCategory[] = [
  {
    id: 'A',
    name: 'Global Requirements',
    description: 'Apply to every offer — must pass on all pages',
    color: 'blue',
    sections: [
      {
        id: 'A1',
        name: 'Footer & Mandatory Links',
        description: 'Check footer visibility and legal links on every page',
        checks: [
          'Footer visible on: main/VSL, checkout, each OTO + downsell, thank-you',
          'Privacy Policy link works (includes email opt-out/unsubscribe)',
          'Terms & Conditions link works',
          'Refund / Returns Policy link works',
          'Disclaimer link works',
          'Contact Us link works (email + support method)',
        ],
      },
      {
        id: 'A2',
        name: 'Refund Policy Consistency',
        description: 'No mismatches in refund terms across pages',
        checks: [
          'Refund days same across all pages + all policies',
          'Guarantee wording consistent everywhere',
          'Checkout text matches policy text exactly',
        ],
      },
      {
        id: 'A3',
        name: 'Timers, Scarcity & Urgency',
        description: 'No fake urgency or scarcity tactics',
        checks: [
          'No countdown timers unless offer truly changes on expiry',
          'No fake scarcity ("only today", "spots left") unless provable',
          'Timer documentation: proof of price/availability change after expiry',
        ],
      },
      {
        id: 'A4',
        name: 'Testimonials, Ratings & Logos',
        description: 'All social proof must be verifiable',
        checks: [
          'All testimonials are real with proof (source, name/initials)',
          'Star ratings are real (source + method documented)',
          'Publication logos only if actually featured (proof saved)',
          'Remove assets if proof is missing',
        ],
      },
      {
        id: 'A5',
        name: 'Claims & Studies',
        description: 'No unsupported claims or unverified studies',
        checks: [
          'No unsupported medical/scientific claims',
          'Study references are available and accurate',
          'No "guaranteed results" / "clinically proven" without substantiation',
        ],
      },
      {
        id: 'A6',
        name: 'Pricing & Discount Integrity',
        description: 'Honest pricing presentation',
        checks: [
          'No fake strike-through "WAS $X" prices',
          'No "TOTAL VALUE $X" / value stacking (especially bonuses)',
          'Consistent pricing across all pages',
        ],
      },
      {
        id: 'A7',
        name: '"Free" Language Accuracy',
        description: 'Free means actually free',
        checks: [
          '"Free" only used when truly free',
          'If shipping charged: "Free (just $X shipping)" stated clearly',
          'No "free access" while charging — remove if customer pays anything',
        ],
      },
      {
        id: 'A8',
        name: 'Access Wording',
        description: 'No problematic lifetime promises',
        checks: [
          'Replace "lifetime access" with "unlimited access" or "VIP access"',
        ],
      },
      {
        id: 'A9',
        name: 'Links & URL Hygiene',
        description: 'All links functional and clean',
        checks: [
          'All links match correct product/page (no outdated URLs)',
          'URLs don\'t contain risky/misleading terms',
          'No broken images, missing sections, or layout issues',
        ],
      },
    ],
  },
  {
    id: 'B',
    name: 'Supplements Only',
    description: 'Additional checks for physical/supplement products',
    color: 'green',
    sections: [
      {
        id: 'B1',
        name: 'Documentation',
        description: 'Labels, COAs, and accessibility',
        checks: [
          'Labels available as PDF (final version)',
          'COAs available (per product/batch)',
          'Labels accessible to customers (linked in footer or on page)',
        ],
      },
      {
        id: 'B2',
        name: 'Shipping & Returns Compliance',
        description: 'Clear shipping terms and return process',
        checks: [
          '"Free shipping" specifies region (e.g., "Free US shipping")',
          'Returns policy includes physical return address',
          'Customer support contact clear for returns/refunds',
        ],
      },
      {
        id: 'B3',
        name: 'OTO Button Wording & Clarity',
        description: 'Compliant upsell/downsell buttons',
        checks: [
          'Buy buttons use compliant language (e.g., "Add to order")',
          'No misleading "digital-looking" imagery for physical items',
        ],
      },
    ],
  },
  {
    id: 'C',
    name: 'Digital Only',
    description: 'Additional checks for courses, ebooks, memberships, downloads',
    color: 'purple',
    sections: [
      {
        id: 'C1',
        name: 'Delivery Clarity',
        description: 'Clear digital product delivery messaging',
        checks: [
          'Near product images: "Digital product / instant access / online access"',
          'Thank-you page explains how to access content (login/link/email)',
        ],
      },
      {
        id: 'C2',
        name: 'Spokesperson / Expert',
        description: 'Verifiable expert identities',
        checks: [
          'Doctor/expert identity is real and verifiable',
          'Remove/replace unverifiable doctor references',
        ],
      },
      {
        id: 'C3',
        name: 'Video (VSL)',
        description: 'Video playback and claim compliance',
        checks: [
          'Video playable on desktop + mobile',
          'No unsubstantiated claims in VSL',
        ],
      },
    ],
  },
  {
    id: 'D',
    name: 'Checkout & Thank-You',
    description: 'Transaction pages compliance',
    color: 'amber',
    sections: [
      {
        id: 'D1',
        name: 'Checkout Page',
        description: 'Checkout compliance requirements',
        checks: [
          'Footer legal links present + working',
          'Refund summary matches policy',
          'No misleading ratings/testimonials',
          'No timers (or fully enforceable with proof)',
        ],
      },
      {
        id: 'D2',
        name: 'Thank-You Page',
        description: 'Post-purchase compliance',
        checks: [
          'Billing descriptor disclosure (e.g., "Charge will appear as...")',
          'Delivery instructions clear (digital access / shipping)',
          'Support contact repeated',
        ],
      },
    ],
  },
  {
    id: 'E',
    name: 'Final QA',
    description: 'Pre-submission quality assurance sweep',
    color: 'red',
    sections: [
      {
        id: 'E1',
        name: 'Full Funnel QA',
        description: 'Complete crawl and red-flag keyword scan',
        checks: [
          'Full funnel crawl: every page + every footer link',
          'Mobile QA: layout, buttons, popups, video, images',
          'Red-flag scan: "lifetime", "value", "worth", "clinically", "proven", "guarantee", "free", "timer"',
        ],
      },
    ],
  },
];

const STATUS_CONFIG = {
  pass: { icon: CheckCircle2, color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30', label: 'PASS' },
  fail: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30', label: 'FAIL' },
  warning: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', label: 'WARNING' },
  not_applicable: { icon: MinusCircle, color: 'text-gray-400', bg: 'bg-gray-500/10', border: 'border-gray-500/30', label: 'N/A' },
};

const CATEGORY_COLORS: Record<string, string> = {
  blue: 'border-blue-500/30 bg-blue-500/5',
  green: 'border-green-500/30 bg-green-500/5',
  purple: 'border-purple-500/30 bg-purple-500/5',
  amber: 'border-amber-500/30 bg-amber-500/5',
  red: 'border-red-500/30 bg-red-500/5',
};

const CATEGORY_BADGE_COLORS: Record<string, string> = {
  blue: 'bg-blue-500/20 text-blue-300',
  green: 'bg-green-500/20 text-green-300',
  purple: 'bg-purple-500/20 text-purple-300',
  amber: 'bg-amber-500/20 text-amber-300',
  red: 'bg-red-500/20 text-red-300',
};

export default function ComplianceAIPage() {
  const [urls, setUrls] = useState<string[]>(['']);
  const [pastedHtml, setPastedHtml] = useState('');
  const [productType, setProductType] = useState<ProductType>('both');
  const [results, setResults] = useState<Record<string, ComplianceResult>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['A', 'B', 'C', 'D', 'E']));
  const [runningAll, setRunningAll] = useState(false);

  const addUrl = () => setUrls((prev) => [...prev, '']);
  const removeUrl = (index: number) => setUrls((prev) => prev.filter((_, i) => i !== index));
  const updateUrl = (index: number, value: string) =>
    setUrls((prev) => prev.map((u, i) => (i === index ? value : u)));

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleCategory = (id: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const runCheck = useCallback(
    async (sectionId: string) => {
      const validUrls = urls.filter((u) => u.trim());
      if (validUrls.length === 0 && !pastedHtml.trim()) return;

      setLoading((prev) => ({ ...prev, [sectionId]: true }));
      try {
        const res = await fetch('/api/compliance-ai/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sectionId,
            funnelUrls: validUrls,
            funnelHtml: pastedHtml.trim() || undefined,
            productType,
          }),
        });
        const data = await res.json();
        if (data.success && data.result) {
          setResults((prev) => ({ ...prev, [sectionId]: data.result }));
          setExpandedSections((prev) => new Set([...prev, sectionId]));
        }
      } catch (err) {
        console.error(`Check ${sectionId} failed:`, err);
      } finally {
        setLoading((prev) => ({ ...prev, [sectionId]: false }));
      }
    },
    [urls, pastedHtml, productType]
  );

  const runAllChecks = async () => {
    const validUrls = urls.filter((u) => u.trim());
    if (validUrls.length === 0 && !pastedHtml.trim()) return;

    setRunningAll(true);
    const allSections = COMPLIANCE_CATEGORIES.flatMap((cat) => cat.sections.map((s) => s.id));

    for (const sectionId of allSections) {
      if (productType === 'digital' && sectionId.startsWith('B')) continue;
      if (productType === 'supplement' && sectionId.startsWith('C')) continue;
      await runCheck(sectionId);
    }
    setRunningAll(false);
  };

  const getOverallScore = () => {
    const allResults = Object.values(results);
    if (allResults.length === 0) return null;

    const total = allResults.length;
    const passed = allResults.filter((r) => r.overallStatus === 'pass').length;
    const failed = allResults.filter((r) => r.overallStatus === 'fail').length;
    const warnings = allResults.filter((r) => r.overallStatus === 'warning').length;

    return { total, passed, failed, warnings, percentage: Math.round((passed / total) * 100) };
  };

  const getCategoryStatus = (categoryId: string): 'pass' | 'fail' | 'warning' | 'pending' => {
    const catResults = Object.entries(results).filter(([key]) => key.startsWith(categoryId));
    if (catResults.length === 0) return 'pending';
    if (catResults.some(([, r]) => r.overallStatus === 'fail')) return 'fail';
    if (catResults.some(([, r]) => r.overallStatus === 'warning')) return 'warning';
    return 'pass';
  };

  const score = getOverallScore();
  const hasInput = urls.some((u) => u.trim()) || pastedHtml.trim();

  return (
    <div className="min-h-screen bg-gray-950">
      <Header
        title="Compliance AI"
        subtitle="Gemini-powered compliance checker — analyze every page of your funnel"
      />

      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Input Section */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-blue-400" />
                Funnel Pages to Analyze
              </h2>
              <p className="text-sm text-gray-400 mt-1">
                Add all funnel URLs (main page, checkout, OTOs, thank-you) or paste HTML
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-400">Product Type:</label>
              <select
                value={productType}
                onChange={(e) => setProductType(e.target.value as ProductType)}
                className="bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="both">Both (Physical + Digital)</option>
                <option value="supplement">Supplement / Physical Only</option>
                <option value="digital">Digital Only</option>
              </select>
            </div>
          </div>

          {/* URL Inputs */}
          <div className="space-y-2 mb-4">
            {urls.map((url, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => updateUrl(i, e.target.value)}
                  placeholder={`https://your-funnel-page-${i + 1}.com`}
                  className="flex-1 bg-gray-800 border border-gray-700 text-white rounded-lg px-4 py-2.5 text-sm placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                {urls.length > 1 && (
                  <button
                    onClick={() => removeUrl(i)}
                    className="p-2.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={addUrl}
              className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add another URL
            </button>
          </div>

          {/* HTML paste */}
          <details className="group">
            <summary className="text-sm text-gray-400 cursor-pointer hover:text-gray-300 transition-colors">
              Or paste HTML content directly...
            </summary>
            <textarea
              value={pastedHtml}
              onChange={(e) => setPastedHtml(e.target.value)}
              placeholder="Paste full HTML of your funnel pages here..."
              rows={6}
              className="mt-2 w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-4 py-3 text-sm font-mono placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
            />
          </details>

          {/* Run All */}
          <div className="mt-4 flex items-center gap-4">
            <button
              onClick={runAllChecks}
              disabled={!hasInput || runningAll}
              className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 disabled:from-gray-700 disabled:to-gray-700 text-white px-6 py-2.5 rounded-lg font-medium text-sm transition-all disabled:cursor-not-allowed"
            >
              {runningAll ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Running All Checks...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" />
                  Run All Compliance Checks
                </>
              )}
            </button>
            {!hasInput && (
              <p className="text-sm text-amber-400">Add at least one URL or paste HTML to start</p>
            )}
          </div>
        </div>

        {/* Score Overview */}
        {score && (
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 text-center">
              <div className={`text-3xl font-bold ${score.percentage >= 80 ? 'text-green-400' : score.percentage >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                {score.percentage}%
              </div>
              <p className="text-sm text-gray-400 mt-1">Overall Score</p>
            </div>
            <div className="bg-gray-900 rounded-xl border border-green-500/20 p-5 text-center">
              <div className="text-3xl font-bold text-green-400">{score.passed}</div>
              <p className="text-sm text-gray-400 mt-1">Passed</p>
            </div>
            <div className="bg-gray-900 rounded-xl border border-amber-500/20 p-5 text-center">
              <div className="text-3xl font-bold text-amber-400">{score.warnings}</div>
              <p className="text-sm text-gray-400 mt-1">Warnings</p>
            </div>
            <div className="bg-gray-900 rounded-xl border border-red-500/20 p-5 text-center">
              <div className="text-3xl font-bold text-red-400">{score.failed}</div>
              <p className="text-sm text-gray-400 mt-1">Failed</p>
            </div>
          </div>
        )}

        {/* Compliance Categories */}
        {COMPLIANCE_CATEGORIES.map((category) => {
          const catStatus = getCategoryStatus(category.id);
          const isExpanded = expandedCategories.has(category.id);
          const isSkipped =
            (productType === 'digital' && category.id === 'B') ||
            (productType === 'supplement' && category.id === 'C');

          return (
            <div
              key={category.id}
              className={`rounded-xl border ${isSkipped ? 'opacity-40 border-gray-800 bg-gray-900/50' : CATEGORY_COLORS[category.color]} transition-opacity`}
            >
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(category.id)}
                className="w-full flex items-center justify-between p-5"
              >
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-md ${CATEGORY_BADGE_COLORS[category.color]}`}>
                    {category.id}
                  </span>
                  <div className="text-left">
                    <h3 className="text-white font-semibold text-base">{category.name}</h3>
                    <p className="text-gray-400 text-sm">{category.description}</p>
                  </div>
                  {isSkipped && (
                    <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded">
                      Skipped — {productType === 'digital' ? 'Digital only' : 'Supplements only'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {catStatus !== 'pending' && (
                    <span className={`text-xs font-medium px-2 py-1 rounded ${STATUS_CONFIG[catStatus === 'pending' ? 'warning' : catStatus].bg} ${STATUS_CONFIG[catStatus === 'pending' ? 'warning' : catStatus].color}`}>
                      {catStatus.toUpperCase()}
                    </span>
                  )}
                  {isExpanded ? (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  )}
                </div>
              </button>

              {/* Category Sections */}
              {isExpanded && !isSkipped && (
                <div className="px-5 pb-5 space-y-3">
                  {category.sections.map((section) => {
                    const result = results[section.id];
                    const isLoading = loading[section.id];
                    const isSectionExpanded = expandedSections.has(section.id);

                    return (
                      <div
                        key={section.id}
                        className="bg-gray-900/80 rounded-lg border border-gray-800 overflow-hidden"
                      >
                        {/* Section Header */}
                        <div className="flex items-center justify-between p-4">
                          <button
                            onClick={() => result && toggleSection(section.id)}
                            className="flex items-center gap-3 flex-1 text-left"
                          >
                            {result ? (
                              isSectionExpanded ? (
                                <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
                              ) : (
                                <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                              )
                            ) : (
                              <div className="w-4 h-4 rounded-full border-2 border-gray-600 shrink-0" />
                            )}
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-gray-500 font-mono">{section.id}</span>
                                <h4 className="text-white font-medium text-sm">{section.name}</h4>
                                {result && (
                                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_CONFIG[result.overallStatus].bg} ${STATUS_CONFIG[result.overallStatus].color}`}>
                                    {STATUS_CONFIG[result.overallStatus].label}
                                  </span>
                                )}
                              </div>
                              <p className="text-gray-500 text-xs mt-0.5">{section.description}</p>
                            </div>
                          </button>
                          <button
                            onClick={() => runCheck(section.id)}
                            disabled={!hasInput || isLoading}
                            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                          >
                            {isLoading ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            {result ? 'Re-check' : 'Check'}
                          </button>
                        </div>

                        {/* Pre-check: show what will be checked */}
                        {!result && !isLoading && (
                          <div className="px-4 pb-4">
                            <ul className="space-y-1">
                              {section.checks.map((check, ci) => (
                                <li key={ci} className="flex items-start gap-2 text-xs text-gray-500">
                                  <div className="w-1.5 h-1.5 rounded-full bg-gray-700 mt-1.5 shrink-0" />
                                  {check}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Loading state */}
                        {isLoading && (
                          <div className="px-4 pb-4">
                            <div className="flex items-center gap-2 text-sm text-blue-400">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Analyzing with Gemini AI...
                            </div>
                          </div>
                        )}

                        {/* Results */}
                        {result && isSectionExpanded && (
                          <div className="px-4 pb-4 space-y-3">
                            {/* Summary */}
                            <div className={`p-3 rounded-lg border ${STATUS_CONFIG[result.overallStatus].border} ${STATUS_CONFIG[result.overallStatus].bg}`}>
                              <p className={`text-sm ${STATUS_CONFIG[result.overallStatus].color}`}>
                                {result.summary}
                              </p>
                            </div>

                            {/* Individual Items */}
                            {result.items.map((item, idx) => {
                              const statusCfg = STATUS_CONFIG[item.status];
                              const StatusIcon = statusCfg.icon;

                              return (
                                <div
                                  key={item.id || idx}
                                  className={`p-3 rounded-lg border ${statusCfg.border} ${statusCfg.bg}`}
                                >
                                  <div className="flex items-start gap-2">
                                    <StatusIcon className={`w-4 h-4 mt-0.5 shrink-0 ${statusCfg.color}`} />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-white">
                                          {item.label}
                                        </span>
                                        <span className={`text-xs px-1.5 py-0.5 rounded ${statusCfg.bg} ${statusCfg.color} border ${statusCfg.border}`}>
                                          {statusCfg.label}
                                        </span>
                                      </div>
                                      <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                                        {item.details}
                                      </p>
                                      {item.recommendation && (
                                        <div className="mt-2 p-2 bg-gray-800/80 rounded border border-gray-700">
                                          <p className="text-xs text-amber-300">
                                            <strong>Fix:</strong> {item.recommendation}
                                          </p>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Quick Reference Links */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
          <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
            <ExternalLink className="w-4 h-4 text-gray-400" />
            Compliance Reference Links
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'FTC Guidelines', url: 'https://www.ftc.gov/business-guidance/advertising-and-marketing' },
              { label: 'FTC Endorsement Guides', url: 'https://www.ftc.gov/legal-library/browse/rules/guides-endorsements-testimonials-advertising' },
              { label: 'CAN-SPAM Act', url: 'https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business' },
              { label: 'DSHEA (Supplements)', url: 'https://www.fda.gov/food/dietary-supplements/dietary-supplement-health-and-education-act-1994-dshea' },
              { label: 'FDA Advertising', url: 'https://www.fda.gov/drugs/prescription-drug-advertising' },
              { label: 'CCPA Privacy', url: 'https://oag.ca.gov/privacy/ccpa' },
              { label: 'GDPR Compliance', url: 'https://gdpr.eu/' },
              { label: 'ClickBank Policies', url: 'https://support.clickbank.com/hc/en-us/categories/201838977-Policies' },
            ].map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-blue-400 bg-gray-800 hover:bg-gray-800/80 rounded-lg px-3 py-2.5 transition-colors border border-gray-700 hover:border-blue-500/30"
              >
                <ExternalLink className="w-3 h-3 shrink-0" />
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
