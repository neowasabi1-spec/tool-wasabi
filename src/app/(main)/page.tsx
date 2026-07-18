'use client';
// Deploy trigger: Quiz Archive API ready

import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import {
  Layers,
  ShoppingBag,
  CheckCircle,
  Clock,
  TrendingUp,
  Copy,
  FileCode,
  ClipboardCheck,
  Swords,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';

export default function Dashboard() {
  const { products, funnelPages, postPurchasePages } = useStore();

  const completed = [...funnelPages, ...postPurchasePages].filter(
    (p) => p.swipeStatus === 'completed'
  ).length;
  const pending = [...funnelPages, ...postPurchasePages].filter(
    (p) => p.swipeStatus === 'pending'
  ).length;

  const stats = [
    {
      name: 'Products',
      value: products.length,
      icon: ShoppingBag,
      tint: 'bg-indigo-50 text-indigo-600',
      href: '/products',
    },
    {
      name: 'Funnel Pages',
      value: funnelPages.length,
      icon: Layers,
      tint: 'bg-violet-50 text-violet-600',
      href: '/front-end-funnel',
    },
    {
      name: 'Completed Swipes',
      value: completed,
      icon: CheckCircle,
      tint: 'bg-emerald-50 text-emerald-600',
      href: '/front-end-funnel',
    },
    {
      name: 'Pending',
      value: pending,
      icon: Clock,
      tint: 'bg-amber-50 text-amber-600',
      href: '/front-end-funnel',
    },
  ];

  const shortcuts = [
    {
      name: 'Clone / Swipe',
      desc: 'Clone a page and rewrite it with your product',
      icon: Copy,
      href: '/front-end-funnel',
      tint: 'from-indigo-500 to-violet-600',
    },
    {
      name: 'My Archive',
      desc: 'Your saved pages, organized by type',
      icon: FileCode,
      href: '/templates',
      tint: 'from-sky-500 to-indigo-600',
    },
    {
      name: 'Catalogue',
      desc: 'Manage your products and offers',
      icon: ShoppingBag,
      href: '/products',
      tint: 'from-fuchsia-500 to-purple-600',
    },
    {
      name: 'Checkpoint',
      desc: 'Monitor and verify competitor funnels',
      icon: ClipboardCheck,
      href: '/checkpoint',
      tint: 'from-emerald-500 to-teal-600',
    },
    {
      name: 'Protocollo Valchiria',
      desc: 'Your library of best funnels',
      icon: Swords,
      href: '/protocollo-valchiria',
      tint: 'from-amber-500 to-orange-600',
    },
    {
      name: 'Post Purchase',
      desc: 'Upsell, downsell and thank you pages',
      icon: TrendingUp,
      href: '/post-purchase',
      tint: 'from-rose-500 to-pink-600',
    },
  ];

  return (
    <div className="min-h-screen">
      <Header title="Dashboard" subtitle="Overview of your swipe activity" />

      <div className="p-6 space-y-8">
        {/* Hero */}
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 via-violet-600 to-purple-700 p-8 text-white shadow-lg shadow-indigo-900/20">
          <div className="absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/10 blur-2xl" />
          <div className="absolute -bottom-16 -left-6 h-56 w-56 rounded-full bg-white/5 blur-2xl" />
          <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div className="max-w-xl">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                <Sparkles className="h-3.5 w-3.5" />
                Funnel Swiper
              </div>
              <h2 className="mt-3 text-3xl font-bold tracking-tight">Welcome back 👋</h2>
              <p className="mt-2 text-indigo-100">
                Clone a landing, rewrite it with your product and build the
                complete funnel — all from one place.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/front-end-funnel"
                className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-indigo-700 shadow-sm transition-transform hover:-translate-y-0.5"
              >
                <Copy className="h-4 w-4" />
                New Clone / Swipe
              </Link>
              <Link
                href="/templates"
                className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-5 py-3 text-sm font-semibold text-white ring-1 ring-white/30 transition-colors hover:bg-white/25"
              >
                <FileCode className="h-4 w-4" />
                Open Archive
              </Link>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Link
                key={stat.name}
                href={stat.href}
                className="group rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg"
              >
                <div className="flex items-center justify-between">
                  <span className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ${stat.tint}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <ArrowRight className="h-4 w-4 text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-400" />
                </div>
                <p className="mt-4 text-3xl font-bold tabular-nums text-gray-900">{stat.value}</p>
                <p className="mt-0.5 text-sm text-gray-500">{stat.name}</p>
              </Link>
            );
          })}
        </div>

        {/* Shortcuts */}
        <div>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Quick Access
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shortcuts.map((s) => {
              const Icon = s.icon;
              return (
                <Link
                  key={s.name}
                  href={s.href}
                  className="group flex items-start gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg"
                >
                  <span className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${s.tint} text-white shadow-sm`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-semibold text-gray-900">{s.name}</h4>
                      <ArrowRight className="h-4 w-4 shrink-0 text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-500" />
                    </div>
                    <p className="mt-0.5 text-sm text-gray-500">{s.desc}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
